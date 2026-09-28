import { ManualClock } from '@astra/core';
import { describe, expect, it } from 'vitest';
import {
  NewsPoller,
  NewsService,
  SimulatedNewsAdapter,
  classifyNews,
  combinedContext,
  sentimentFor,
  type InstrumentNewsProfile,
  type NewsItem,
} from '../src';

const NOW = '2026-09-28T14:00:00.000Z';
const INSTRUMENTS = new Map<string, InstrumentNewsProfile>([
  ['NQ', { eventCurrencies: ['USD'], keywords: ['nasdaq', 'tech shares'] }],
  ['XAUUSD', { eventCurrencies: ['USD'], keywords: ['gold', 'bullion'] }],
  ['DAX', { eventCurrencies: ['EUR'] }],
  ['EURUSD', {}], // currencies not configured: fail-safe
]);
const item = (id: string, headline: string, o: Partial<NewsItem> = {}): NewsItem => ({
  id,
  headline,
  publishedAt: NOW,
  ...o,
});
const classify = (i: NewsItem) =>
  classifyNews({
    item: i,
    source: 'wire',
    sourceKind: 'LIVE',
    receivedAt: NOW,
    instruments: INSTRUMENTS,
  });
const symbols = (n: ReturnType<typeof classify>) => n.affected.map((a) => `${a.symbol}:${a.basis}`);

describe('classifyNews', () => {
  it('categorises, rates impact and maps instruments by currency, keyword and provider tag', () => {
    const cpi = classify(item('1', 'US inflation data comes in above expectations'));
    expect(cpi).toMatchObject({ category: 'INFLATION', impact: 'MEDIUM', currencies: ['USD'] });
    expect(symbols(cpi)).toEqual(['EURUSD:CURRENCY_UNMAPPED', 'NQ:CURRENCY', 'XAUUSD:CURRENCY']);
    expect(cpi.basis).toEqual(['inflation']);
    expect(cpi.sentiment).toBeNull(); // never guessed from words

    const gold = classify(item('2', 'Gold slips as yields rise'));
    expect(gold).toMatchObject({ category: 'COMMODITIES', impact: 'LOW' });
    expect(symbols(gold)).toEqual(['XAUUSD:KEYWORD']);

    const tagged = classify(item('3', 'Chip maker earnings beat estimates', { symbols: ['NQ'] }));
    expect(symbols(tagged)).toEqual(['NQ:PROVIDER_SYMBOL']);

    const ecb = classify(item('4', 'ECB holds rates steady'));
    expect(ecb).toMatchObject({ category: 'CENTRAL_BANK', currencies: ['EUR'] });
    expect(symbols(ecb)).toEqual(['DAX:CURRENCY', 'EURUSD:CURRENCY_UNMAPPED']);
  });

  it('escalates on "breaking/surprise" and treats unknown relevance of HIGH impact as all', () => {
    const cut = classify(item('1', 'BREAKING: Fed announces surprise rate cut'));
    expect(cut).toMatchObject({ category: 'CENTRAL_BANK', impact: 'HIGH' });
    expect(cut.basis).toContain('escalated');
    const strike = classify(item('2', 'Missile strikes reported near border'));
    expect(strike).toMatchObject({ category: 'GEOPOLITICS', impact: 'HIGH' });
    expect(strike.affected.every((a) => a.basis === 'UNKNOWN_RELEVANCE')).toBe(true);
    expect(strike.affected).toHaveLength(4);
    // "price war" is not armed conflict; an unmatched headline stays LOW and unrelated.
    expect(classify(item('3', 'Retailers in a price war')).impact).toBe('LOW');
    expect(classify(item('4', 'Local bakery opens')).affected).toEqual([]);
  });

  it('never lowers an impact: the provider rating and the rules take the higher', () => {
    expect(classify(item('1', 'Oil slips', { providerImpact: 'HIGH' })).impact).toBe('HIGH');
    expect(classify(item('2', 'US CPI rises', { providerImpact: 'LOW' })).impact).toBe('MEDIUM');
    const s = classify(
      item('3', 'Tech shares rally', { providerSentiment: { label: 'BULLISH', confidence: 0.7 } }),
    );
    expect(s.sentiment).toEqual({ label: 'BULLISH', confidence: 0.7, source: 'PROVIDER' });
  });
});

function setup() {
  const clock = new ManualClock(NOW);
  const added: string[] = [];
  const service = new NewsService({
    clock,
    freshness: { maxAgeMs: 15 * 60_000, maxFutureSkewMs: 2_000 },
    instruments: INSTRUMENTS,
    risk: { highImpactMinutes: 30, mediumImpactMinutes: 15 },
    retentionMs: 48 * 3_600_000,
    onItems: (items) => added.push(...items.map((n) => n.key)),
  });
  return { clock, service, added };
}

describe('NewsService', () => {
  it('is UNAVAILABLE before any delivery, NORMAL after an empty one, then STALE', () => {
    const { clock, service } = setup();
    expect(service.risk('NQ')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(service.health().status).toBe('UNKNOWN');
    service.ingest({ items: [] }, 'wire', 'LIVE');
    expect(service.freshRisk('NQ')).toMatchObject({
      status: 'OK',
      sourceKind: 'LIVE',
      value: { symbol: 'NQ', level: 'NORMAL', reasons: [], clearsAt: null },
    });
    expect(service.health().status).toBe('ONLINE');
    clock.advance(15 * 60_000 + 1);
    expect(service.freshRisk('NQ')).toMatchObject({ status: 'STALE' });
    expect(service.health().status).toBe('DEGRADED');
  });

  it('rates news risk HIGH / ELEVATED for relevant recent items, then lets it lapse', () => {
    const { clock, service } = setup();
    service.ingest(
      {
        items: [
          item('a', 'BREAKING: Fed announces surprise rate cut', {
            publishedAt: '2026-09-28T13:50:00.000Z',
          }),
          item('b', 'ECB policy meeting minutes released', {
            publishedAt: '2026-09-28T13:55:00.000Z',
          }),
        ],
      },
      'wire',
      'LIVE',
    );
    const nq = service.risk('NQ');
    expect(nq.status === 'OK' && nq.value).toMatchObject({
      level: 'HIGH',
      items: ['wire:a'],
      clearsAt: '2026-09-28T14:20:00.000Z',
    });
    expect(nq.status === 'OK' && nq.value.reasons[0]).toContain('10 min ago');
    const dax = service.risk('DAX');
    expect(dax.status === 'OK' && dax.value.level).toBe('ELEVATED');
    clock.advance(21 * 60_000);
    service.ingest({ items: [] }, 'wire', 'LIVE');
    const later = service.risk('NQ');
    expect(later.status === 'OK' && later.value.level).toBe('NORMAL');
  });

  it('validates items one by one, de-duplicates and binds a source to one data kind', () => {
    const { service, added } = setup();
    const r = service.ingest(
      {
        items: [
          item('1', 'Tech shares extend gains'),
          { id: '2' }, // no headline
          item('3', 'From the future', { publishedAt: '2026-09-28T15:00:00.000Z' }),
          item('1', 'Tech shares extend gains'),
        ],
      },
      'wire',
      'LIVE',
    );
    expect(r).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2]);
    // The same headline syndicated by another source is a duplicate.
    expect(
      service.ingest({ items: [item('x', 'Tech shares extend gains!')] }, 'other', 'LIVE')
        .duplicates,
    ).toBe(1);
    expect(added).toEqual(['wire:1']);
    expect(() => service.ingest({ items: [] }, 'wire', 'SIMULATED')).toThrow(/delivers LIVE/);
    expect(() => service.ingest({ nope: true }, 'wire', 'LIVE')).toThrow(/invalid news batch/);
  });

  it('labels the assessment with the least trustworthy active source', () => {
    const { service } = setup();
    service.ingest({ items: [] }, 'wire', 'LIVE');
    service.ingest({ items: [] }, 'simulation', 'SIMULATED');
    expect(service.risk('NQ')).toMatchObject({ sourceKind: 'SIMULATED' });
  });

  it('lists newest first with filters and drops items past retention', () => {
    const { clock, service } = setup();
    service.ingest(
      {
        items: [
          item('old', 'Gold edges higher', { publishedAt: '2026-09-28T10:00:00.000Z' }),
          item('new', 'US CPI rises', { publishedAt: '2026-09-28T13:00:00.000Z' }),
        ],
      },
      'wire',
      'LIVE',
    );
    expect(service.list().map((n) => n.item.id)).toEqual(['new', 'old']);
    expect(service.list({ symbol: 'XAUUSD', minImpact: 'MEDIUM' }).map((n) => n.item.id)).toEqual([
      'new',
    ]);
    expect(service.list({ category: 'COMMODITIES' }).map((n) => n.item.id)).toEqual(['old']);
    clock.advance(45 * 3_600_000);
    service.ingest({ items: [] }, 'wire', 'LIVE');
    expect(service.list().map((n) => n.item.id)).toEqual(['new']);
  });
});

describe('sentiment and combined context', () => {
  it('is UNKNOWN without provider sentiment, and recency-weighted when present', () => {
    const at = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
    const n = (id: string, min: number, label: 'BULLISH' | 'BEARISH') =>
      classify(
        item(id, 'Tech shares move', {
          publishedAt: at(min),
          providerSentiment: { label, confidence: 0.8 },
        }),
      );
    const now = new Date(NOW);
    expect(sentimentFor([classify(item('0', 'Tech shares move'))], 'NQ', now).label).toBe(
      'UNKNOWN',
    );
    const v = sentimentFor(
      [n('1', 10, 'BULLISH'), n('2', 20, 'BULLISH'), n('3', 200, 'BEARISH')],
      'NQ',
      now,
    );
    expect(v).toMatchObject({ label: 'BULLISH', momentum: 'RISING', items: 3, simulated: false });
    expect(v.confidence).toBeCloseTo(0.8 * (3 / 5));
    expect(sentimentFor([n('1', 10, 'BULLISH')], 'DAX', now).label).toBe('UNKNOWN');
    expect(combinedContext('BULLISH', 'HIGH', 'CLEAR')).toBe('Bullish — high news risk');
    expect(combinedContext('VERY_BEARISH', 'NORMAL', 'BLACKOUT')).toBe(
      'Very bearish — inside an event blackout',
    );
    expect(combinedContext('NEUTRAL', 'NORMAL', 'CLEAR')).toBe('Neutral, no elevated event risk');
  });
});

describe('SimulatedNewsAdapter and NewsPoller', () => {
  it('produces the same labelled SIMULATED items for the same range', () => {
    const a = new SimulatedNewsAdapter();
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-08T00:00:00Z');
    const items = a.itemsBetween(from, to);
    expect(items).toEqual(new SimulatedNewsAdapter().itemsBetween(from, to));
    expect(items.every((i) => i.headline.startsWith('SIMULATED — '))).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.length).toBeGreaterThan(7 * 24 * 0.6); // about one an hour
    expect(items.length).toBeLessThan(7 * 24 * 1.5);
    expect(items.some((i) => i.headline.includes('high-impact'))).toBe(true);
    // A sub-range is exactly the matching part of the full range (no lookahead, no drift).
    const mid = new Date('2026-09-04T00:00:00Z');
    expect(a.itemsBetween(from, mid)).toEqual(
      items.filter((i) => i.publishedAt <= mid.toISOString()),
    );
  });

  it('polls into the service, and a failing provider leaves the feed to go STALE', async () => {
    const { clock, service } = setup();
    let fail = false;
    const adapter = {
      id: 'wire',
      kind: 'LIVE' as const,
      fetch: () =>
        fail ? Promise.reject(new Error('provider down')) : Promise.resolve({ items: [] }),
    };
    const poller = new NewsPoller({
      adapter,
      service,
      clock,
      intervalMs: 60_000,
      timeoutMs: 1_000,
      lookbackMs: 3_600_000,
    });
    expect(await poller.poll()).toMatchObject({ ok: true, accepted: 0 });
    fail = true;
    clock.advance(16 * 60_000);
    expect(await poller.poll()).toMatchObject({ ok: false, error: 'provider down', failures: 1 });
    expect(service.freshRisk('NQ')).toMatchObject({ status: 'STALE' });
    expect(poller.status()).toMatchObject({ consecutiveFailures: 1, lastError: 'provider down' });
  });
});
