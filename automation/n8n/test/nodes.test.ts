import { describe, expect, it } from 'vitest';
import { ALERT_RULES, format, run as alertsRun, wanted } from '../src/nodes/alerts-format';
import { run as cursorRun } from '../src/nodes/alerts-cursor';
import { fromAstraWindow, fromFfWeekly, mergeWindows } from '../src/nodes/calendar-normalise';
import { checkSources as calendarSources } from '../src/nodes/calendar-sources';
import { decodeText, parseFeed, run as newsRun, toNewsItems } from '../src/nodes/news-normalise';
import { checkSources as newsSources } from '../src/nodes/news-sources';
import { checkChannels, discord, email, telegram } from '../src/nodes/notify';
import { run as reportRun } from '../src/nodes/report-message';
import type { Ctx } from '../src/nodes/shared';
import { alertBody, toCandidate } from '../src/nodes/signal-candidate';
import { run as summaryRun } from '../src/nodes/signal-summary';

const NOW = new Date('2026-09-28T14:00:00.000Z');
const ctx = (extra: Ctx['extra'] = {}, staticData: Record<string, unknown> = {}): Ctx => ({
  now: NOW,
  executionId: '42',
  staticData,
  extra,
});

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Wire &amp; Co</title><link>https://wire.example</link>
<item><title><![CDATA[Fed <b>raises</b> rates]]></title><link>https://wire.example/a</link>
<guid>a-1</guid><pubDate>Mon, 28 Sep 2026 13:30:00 GMT</pubDate>
<description>&lt;p&gt;Rates up 25bp &amp;amp; more&lt;/p&gt;</description></item>
<item><title>No date here</title><guid>a-2</guid></item>
<item><title>Old story</title><guid>a-3</guid><pubDate>Mon, 21 Sep 2026 13:30:00 GMT</pubDate></item>
<item><title>Gold &#8364; &#x2014; rally</title><guid>a-4</guid><pubDate>2026-09-28T13:45:00Z</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Central bank</title>
<entry><title type="html">Policy statement</title><id>urn:cb:1</id>
<link rel="self" href="https://cb.example/self"/><link rel="alternate" href="https://cb.example/1"/>
<updated>2026-09-28T12:00:00+02:00</updated><summary>Statement text</summary></entry></feed>`;

describe('news ingestion', () => {
  it('parses RSS: CDATA, entities, escaped HTML; drops undated and old items', () => {
    const feed = parseFeed(RSS);
    expect(feed).toMatchObject({ kind: 'RSS', title: 'Wire & Co' });
    expect(feed.entries[0]).toMatchObject({
      title: 'Fed raises rates',
      link: 'https://wire.example/a',
    });
    const { items, skipped } = toNewsItems(feed, NOW, { maxAgeHours: 24, maxItems: 50 });
    expect(skipped).toBe(1);
    expect(items).toEqual([
      {
        id: 'a-1',
        headline: 'Fed raises rates',
        publishedAt: '2026-09-28T13:30:00.000Z',
        summary: 'Rates up 25bp & more',
        publisher: 'Wire & Co',
        url: 'https://wire.example/a',
      },
      {
        id: 'a-4',
        headline: 'Gold € — rally',
        publishedAt: '2026-09-28T13:45:00.000Z',
        publisher: 'Wire & Co',
      },
    ]);
  });

  it('parses Atom (alternate link, updated time) and refuses non-feeds', () => {
    const feed = parseFeed(ATOM);
    expect(feed.entries[0]).toMatchObject({
      id: 'urn:cb:1',
      link: 'https://cb.example/1',
      published: '2026-09-28T12:00:00+02:00',
    });
    const { items } = toNewsItems(feed, NOW, { maxAgeHours: 24, maxItems: 50 });
    expect(items[0]).toMatchObject({
      publishedAt: '2026-09-28T10:00:00.000Z',
      publisher: 'Central bank',
    });
    expect(() => parseFeed('<html><body>Not found</body></html>')).toThrow('not an RSS or Atom');
    expect(decodeText('a &lt;b&gt; &unknown; &#0;')).toBe('a &unknown; &#0;');
  });

  it('hashes over-long ids and pushes one batch per feed (empty = feed alive)', () => {
    const long = `<rss><channel><title>T</title><item><title>X</title><guid>${'g'.repeat(300)}</guid><pubDate>2026-09-28T13:00:00Z</pubDate></item></channel></rss>`;
    const empty = '<rss><channel><title>Quiet</title></channel></rss>';
    const out = newsRun(
      [{ data: long }, { data: empty }],
      ctx({ sources: [{ name: 'a' }, { name: 'b' }] }),
    );
    expect(out[0]).toMatchObject({ source: 'rss:a', workflowRunId: '42' });
    expect((out[0]!.items as { id: string }[])[0]!.id).toMatch(/^h:[0-9a-f]{16}$/);
    expect(out[1]).toMatchObject({ source: 'rss:b', items: [] });
    expect(() => newsRun([{ data: long }], ctx({ sources: [] }))).toThrow('configured');
    expect(() => newsRun([{ data: '<html/>' }], ctx({ sources: [{ name: 'a' }] }))).toThrow(
      'feed a',
    );
  });

  it('refuses an empty or invalid source list', () => {
    expect(() => newsSources([])).toThrow('No news feeds configured');
    expect(() => newsSources([{ name: 'Bad Name', url: 'https://x' }])).toThrow('lowercase');
    expect(() => newsSources([{ name: 'a', url: 'ftp://x' }])).toThrow('http(s)');
    expect(() =>
      newsSources([
        { name: 'a', url: 'https://x' },
        { name: 'a', url: 'https://y' },
      ]),
    ).toThrow('twice');
  });
});

describe('calendar ingestion', () => {
  const ff = [
    {
      title: 'CPI m/m',
      country: 'USD',
      date: '2026-09-29T08:30:00-04:00',
      impact: 'High',
      forecast: '0.3%',
      previous: '0.2%',
    },
    { title: 'Bank Holiday', country: 'GBP', date: '2026-09-28T03:00:00-04:00', impact: 'Holiday' },
    { title: 'Speech', country: 'All', date: '2026-09-30T10:00:00-04:00', impact: 'Unrated' },
  ];

  it('maps a weekly export; unknown impact is UNKNOWN (treated as HIGH); window spans first→last event', () => {
    const w = fromFfWeekly(ff, 'this-week');
    expect(w.from).toBe('2026-09-28T07:00:00.000Z');
    expect(w.to).toBe('2026-09-30T14:01:00.000Z');
    expect(w.events.map((e) => [e.title, e.impact, e.currency])).toEqual([
      ['CPI m/m', 'HIGH', 'USD'],
      ['Holiday: Bank Holiday', 'LOW', 'GBP'],
      ['Speech', 'UNKNOWN', undefined],
    ]);
    expect(w.events[0]).toMatchObject({
      expected: '0.3%',
      previous: '0.2%',
      affectedInstruments: [],
    });
    expect(w.events[0]!.id).toBe(fromFfWeekly(ff, 'x').events[0]!.id); // stable ids
    expect(() => fromFfWeekly([{ title: 'X', date: 'soon' }], 's')).toThrow('event 1');
    expect(() => fromFfWeekly({}, 's')).toThrow('array');
    expect(() => fromFfWeekly([], 's')).toThrow('no events');
  });

  it('accepts ASTRA windows and never bridges a gap between sources', () => {
    const a = {
      name: 'a',
      ...fromAstraWindow(
        {
          window: {
            from: '2026-09-28T00:00:00Z',
            to: '2026-09-29T00:00:00Z',
            events: [{ id: 'e1', scheduledAt: '2026-09-28T12:00:00Z' }],
          },
        },
        'a',
      ),
    };
    const b = {
      name: 'b',
      ...fromAstraWindow(
        {
          from: '2026-09-28T20:00:00Z',
          to: '2026-09-30T00:00:00Z',
          events: [
            { id: 'e1', scheduledAt: '2026-09-28T12:00:00Z' },
            { id: 'e2', scheduledAt: '2026-09-29T12:00:00Z' },
          ],
        },
        'b',
      ),
    };
    const c = {
      name: 'c',
      ...fromAstraWindow(
        { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z', events: [] },
        'c',
      ),
    };
    const m = mergeWindows([c, b, a], NOW);
    expect(m.used).toEqual(['a', 'b']);
    expect(m.leftOut).toEqual(['c']);
    expect(m.window).toMatchObject({
      from: '2026-09-28T00:00:00.000Z',
      to: '2026-09-30T00:00:00.000Z',
    });
    expect(m.window.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(() => fromAstraWindow({ from: 'x' }, 'z')).toThrow('expected');
    expect(() => calendarSources([{ name: 'a', url: 'https://x', format: 'csv' }])).toThrow(
      'format',
    );
    expect(() => calendarSources([])).toThrow('No calendar source');
  });
});

describe('signal webhook', () => {
  const alert = {
    accountId: 'paper-demo',
    strategyId: 'paper-pipeline-test',
    symbol: 'mnq',
    direction: 'buy',
    entry: '20000.25',
    stop: 19990.25,
    target: 20020.25,
    timeframe: 'M5',
    rationale: 'BOS on M5',
  };

  it('reshapes an alert into a candidate with a stable id and no auto-execution by default', () => {
    const c = toCandidate(alert, NOW, '7') as { candidate: any; autoExecute: boolean };
    expect(c.autoExecute).toBe(false);
    expect(c.candidate).toMatchObject({
      accountId: 'paper-demo',
      workflowRunId: '7',
      signal: {
        symbol: 'MNQ',
        direction: 'LONG',
        entryType: 'MARKET',
        setupState: 'QUALIFIED',
        entry: 20000.25,
        detectedAt: NOW.toISOString(),
        rationale: ['BOS on M5'],
        timeframe: 'M5',
      },
    });
    const again = toCandidate(alert, new Date(NOW.getTime() + 20_000), '8') as any;
    expect(again.candidate.signal.id).toBe(c.candidate.signal.id); // a retry is a duplicate
    const later = toCandidate(alert, new Date(NOW.getTime() + 120_000), '9') as any;
    expect(later.candidate.signal.id).not.toBe(c.candidate.signal.id);
    expect(
      (toCandidate({ ...alert, time: Date.parse('2026-09-28T13:59:00Z') }, NOW, '1') as any)
        .candidate.signal.detectedAt,
    ).toBe('2026-09-28T13:59:00.000Z');
  });

  it('passes LIMIT entries through with their expiry (required)', () => {
    const c = toCandidate({ ...alert, entryType: 'limit', expiresInMinutes: 60 }, NOW, '3') as any;
    expect(c.candidate.signal).toMatchObject({
      entryType: 'LIMIT',
      expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });
    expect(() => toCandidate({ ...alert, entryType: 'LIMIT' }, NOW, '3')).toThrow('expiresAt');
    expect(() => toCandidate({ ...alert, entryType: 'stop' }, NOW, '3')).toThrow('entryType');
  });

  it('refuses malformed alerts', () => {
    expect(() => toCandidate({ ...alert, stop: undefined }, NOW, '1')).toThrow('"stop"');
    expect(() => toCandidate({ ...alert, direction: 'up' }, NOW, '1')).toThrow('direction');
    expect(() => toCandidate({ ...alert, accountId: 'Paper Demo' }, NOW, '1')).toThrow('accountId');
    expect(() => toCandidate({ ...alert, signalId: 'bad id!' }, NOW, '1')).toThrow('signalId');
    expect(() => alertBody({ body: 'not json' })).toThrow('not JSON');
    expect(alertBody({ body: JSON.stringify(alert) })).toEqual(alert);
  });

  it('replies with the decision only', () => {
    expect(
      summaryRun(
        [
          {
            decision: { status: 'REJECTED', decisionId: 'dec_1', reasons: ['a', 'b'], checks: [] },
            execution: null,
          },
        ],
        ctx(),
      ),
    ).toEqual([
      {
        status: 'REJECTED',
        decisionId: 'dec_1',
        symbol: null,
        direction: null,
        reasons: ['a', 'b'],
        execution: null,
      },
    ]);
  });
});

describe('alerts', () => {
  const ev = (seq: number, level: string, type: string, extra: Record<string, unknown> = {}) => ({
    seq,
    at: '2026-09-28T13:59:00.000Z',
    level,
    component: 'c',
    type,
    message: `${type} happened`,
    data: {},
    ...extra,
  });

  it('sends errors and chosen types, not routine rejections or its own failures', () => {
    expect(wanted(ev(1, 'ERROR', 'X'))).toBe(true);
    expect(wanted(ev(1, 'WARN', 'DECISION_REJECTED'))).toBe(false);
    expect(wanted(ev(1, 'INFO', 'TRADE_JOURNALED'))).toBe(true);
    expect(wanted(ev(1, 'WARN', 'POSITION_LIMIT_WARN_RAISED'))).toBe(true);
    expect(wanted(ev(1, 'ERROR', 'WORKFLOW_ERROR', { data: { workflow: 'ASTRA — Notify' } }))).toBe(
      false,
    );
    expect(
      wanted(
        ev(1, 'ERROR', 'WORKFLOW_ERROR', { data: { workflow: 'ASTRA — News ingestion (RSS)' } }),
      ),
    ).toBe(true);
    expect(ALERT_RULES.maxLines).toBeGreaterThan(0);
  });

  it('groups several alerts into one message and advances the cursor past everything read', () => {
    const one = format([ev(5, 'CRITICAL', 'PROTECTIVE_CLOSE_DONE')]);
    expect(one).toMatchObject({
      title: 'ASTRA CRITICAL: protective close done',
      level: 'CRITICAL',
    });
    const staticData: Record<string, unknown> = {};
    const out = alertsRun(
      [
        {
          events: [
            ev(12, 'WARN', 'DECISION_REJECTED'),
            ev(11, 'ERROR', 'A'),
            ev(10, 'INFO', 'TRADE_JOURNALED'),
          ],
        },
      ],
      ctx({ cursor: [{ afterSeq: 9 }] }, staticData),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'ASTRA: 2 alerts (worst ERROR)', level: 'ERROR' });
    expect(String(out[0]!.text).split('\n')).toHaveLength(2);
    expect(staticData.lastSeq).toBe(12);
    const quiet: Record<string, unknown> = {};
    expect(alertsRun([{ events: [] }], ctx({ cursor: [{ afterSeq: 30 }] }, quiet))).toEqual([]);
    expect(quiet.lastSeq).toBe(30);
  });

  it('starts at the newest event on the first run, then continues from the saved cursor', () => {
    expect(cursorRun([], ctx({ latest: [{ events: [{ seq: 99 }] }] }))).toEqual([{ afterSeq: 99 }]);
    expect(cursorRun([], ctx({ latest: [{ events: [] }] }))).toEqual([{ afterSeq: 0 }]);
    expect(cursorRun([], ctx({ latest: [{ events: [{ seq: 99 }] }] }, { lastSeq: 50 }))).toEqual([
      { afterSeq: 50 },
    ]);
  });
});

describe('notify and reports', () => {
  const channels = {
    telegram: { enabled: true, chatId: '-100123' },
    discord: { enabled: false },
    email: { enabled: true, from: 'astra@example.com', to: 'me@example.com' },
  };

  it('refuses to run with no channel (so alerts are never silently dropped)', () => {
    expect(() =>
      checkChannels({
        telegram: { enabled: false, chatId: '' },
        discord: { enabled: false },
        email: { enabled: false, from: '', to: '' },
      }),
    ).toThrow('No notification channel');
    expect(() => checkChannels({ ...channels, telegram: { enabled: true, chatId: 'me' } })).toThrow(
      'chatId',
    );
    expect(() =>
      checkChannels({ ...channels, email: { enabled: true, from: 'x', to: 'y' } }),
    ).toThrow('email');
  });

  it('builds one payload per enabled channel', () => {
    const m = [{ title: 'T', text: 'x'.repeat(5_000), level: 'INFO', channels }];
    expect(telegram(m, ctx())[0]!.text).toHaveLength(4_000);
    expect(discord(m, ctx())).toEqual([]);
    expect(email(m, ctx())).toEqual([
      { from: 'astra@example.com', to: 'me@example.com', subject: 'T', text: 'x'.repeat(5_000) },
    ]);
  });

  it('turns ASTRA’s report text into a message without adding to it', () => {
    expect(reportRun([{ text: 'ASTRA daily report — x\n\nbody' }], ctx())).toEqual([
      { title: 'ASTRA daily report — x', text: 'body', level: 'INFO' },
    ]);
    expect(() => reportRun([{}], ctx())).toThrow('without text');
  });
});
