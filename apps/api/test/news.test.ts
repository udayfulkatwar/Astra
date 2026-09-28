import { afterEach, describe, expect, it } from 'vitest';
import { H, bringOnline, candidate, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const get = async (harness: Harness, url: string) =>
  json(await harness.app.inject({ url, headers: H.viewer }));
const push = (harness: Harness, items: unknown[], headers = H.automation) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/v1/news/items',
    headers,
    payload: { source: 'n8n', items },
  });
const evaluate = async (harness: Harness) =>
  json(
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: { candidate: candidate(harness), autoExecute: false },
    }),
  ).decision as Json;

describe.skipIf(!available)('API — news intelligence', () => {
  it('classifies pushed news, blocks new trades on HIGH news risk, and recovers', async () => {
    h = await createHarness();
    await bringOnline(h);
    expect((await evaluate(h)).status).toBe('APPROVED');

    const now = h.clock.now().toISOString();
    const res = await push(h, [
      { id: 'n1', headline: 'BREAKING: Fed announces surprise rate cut', publishedAt: now },
      { id: 'n2', headline: 'Gold edges higher', publishedAt: now },
    ]);
    expect(json(res)).toEqual({ accepted: 2, duplicates: 0, rejected: [] });

    const d = await evaluate(h);
    expect(d.status).toBe('REJECTED');
    expect(d.reasons.join(' ')).toContain('[news.risk] news risk HIGH');
    const check = (d.checks as Json[]).find((c) => c.checkId === 'news.risk');
    expect(check).toMatchObject({ verdict: 'FAIL' });

    const feed = await get(h, '/api/v1/news?symbol=MNQ');
    expect(feed.items.map((n: Json) => [n.item.id, n.category, n.impact])).toEqual([
      ['n1', 'CENTRAL_BANK', 'HIGH'],
    ]);
    expect(feed.feed.sources).toContainEqual({
      source: 'ingest:n8n',
      kind: 'MANUAL',
      lastUpdateAt: now,
    });
    const ctx = await get(h, '/api/v1/news/context');
    const mnq = (ctx.instruments as Json[]).find((i) => i.symbol === 'MNQ')!;
    expect(mnq.risk).toMatchObject({ status: 'OK', level: 'HIGH', sourceKind: 'MANUAL' });
    expect(mnq.combined).toContain('high news risk');
    const events = (await get(h, '/api/v1/events?limit=50')).events as Json[];
    expect(events.find((e) => e.type === 'NEWS_HIGH_IMPACT')).toMatchObject({
      level: 'WARN',
      component: 'news',
    });

    // 31 minutes later the HIGH risk has lapsed.
    h.clock.advance(31 * 60_000);
    await bringOnline(h);
    expect((await evaluate(h)).status).toBe('APPROVED');
  });

  it('stops trades when the feed goes stale, reports bad items, and restores items after a restart', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = json(
      await push(h, [
        { id: 'ok', headline: 'US CPI rises', publishedAt: h.clock.now().toISOString() },
        { id: 'bad' },
      ]),
    );
    expect(r.accepted).toBe(1);
    expect(r.rejected.map((x: Json) => x.index)).toEqual([1]);
    expect((await push(h, [], H.viewer)).statusCode).toBe(403);

    // No delivery for 16 minutes: the feed is STALE and news risk is unknown → no trades.
    h.clock.advance(16 * 60_000);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/market/quotes',
      headers: H.automation,
      payload: {
        source: 'test',
        quotes: [
          { symbol: 'MNQ', bid: 20_000, ask: 20_000.25, asOf: h.clock.now().toISOString() },
          { symbol: 'NQ', bid: 20_000, ask: 20_000.25, asOf: h.clock.now().toISOString() },
          { symbol: 'XAUUSD', bid: 2_600, ask: 2_600.2, asOf: h.clock.now().toISOString() },
        ],
      },
    });
    await h.runtime.cycle();
    const d = await evaluate(h);
    expect(d.status).toBe('REJECTED');
    expect(d.reasons.join(' ')).toMatch(/\[news\.risk\].*STALE/);
    const status = await get(h, '/api/v1/system/status');
    expect(status.news.status).toBe('DEGRADED');

    // Stored items come back after a restart; the feed is fresh only after a new delivery.
    h = await h.restart();
    expect((await get(h, '/api/v1/news')).items.map((n: Json) => n.item.id)).toEqual(['ok']);
    const ctx = await get(h, '/api/v1/news/context');
    expect((ctx.instruments as Json[])[0]!.risk.status).toBe('UNKNOWN');
  });
});
