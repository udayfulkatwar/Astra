import { simulateM1Bars } from '@astra/backtest';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, H, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const RANGE = { from: '2026-03-02T00:00:00Z', to: '2026-03-05T00:00:00Z' };
const request = (extra: Json = {}) => ({
  symbol: 'MNQ',
  accountId: 'paper-demo',
  calendar: 'SIMULATED_SCHEDULE',
  news: 'SIMULATED_FEED',
  ...RANGE,
  data: { kind: 'SIMULATED', seed: 7, startPrice: 18_000 },
  ...extra,
});
const post = (harness: Harness, payload: Json, headers = H.operator) =>
  harness.app.inject({ method: 'POST', url: '/api/v1/backtests', headers, payload });

describe.skipIf(!available)('API — backtests', () => {
  it('runs a replay, records it, and never touches trading state', async () => {
    h = await createHarness();
    const modeBefore = h.runtime.mode.current();

    const res = await post(h, request());
    expect(res.statusCode).toBe(200);
    const run = json(res);
    expect(run.runId).toMatch(/^btr_/);
    expect(run.result.label).toBe('Engine test on SIMULATED data — not evidence of performance');
    expect(run.result.decisions.signals).toBeGreaterThan(0);
    expect(run.result.data).toMatchObject({ symbol: 'MNQ', sourceKinds: ['SIMULATED'] });

    const list = json(await h.app.inject({ url: '/api/v1/backtests', headers: H.viewer }));
    expect(list.running).toBe(false);
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({
      runId: run.runId,
      createdBy: 'operator',
      dataKind: 'SIMULATED',
      summary: { trades: run.result.summary.overall.trades, label: run.result.label },
    });
    const stored = json(
      await h.app.inject({ url: `/api/v1/backtests/${run.runId}`, headers: H.viewer }),
    );
    expect(stored.result).toEqual(run.result);
    expect(stored.request.data).toEqual({ kind: 'SIMULATED', seed: 7, startPrice: 18_000 });

    // Trading state is untouched: same mode, no kill switch, no order.
    expect(h.runtime.mode.current()).toBe(modeBefore);
    expect(h.runtime.killSwitches.list().filter((s) => s.active)).toEqual([]);
    expect(await h.runtime.repos.execution.workingOrders('paper-demo', 'MNQ')).toEqual([]);
    const events = await h.runtime.repos.events.recent({ limit: 20 });
    expect(events.some((e) => e.type === 'BACKTEST_COMPLETED')).toBe(true);

    expect(
      (await h.app.inject({ url: '/api/v1/backtests/btr_missing', headers: H.viewer })).statusCode,
    ).toBe(404);
  }, 60_000);

  it('replays stored bars (one source) as HISTORICAL data', async () => {
    h = await createHarness();
    const bars = simulateM1Bars({
      symbol: 'MNQ',
      tickSize: 0.25,
      startPrice: 18_000,
      ...RANGE,
      hours: CONFIG.instruments.get('MNQ')!.tradingHours!,
      seed: 7,
    }).map((b) => ({ ...b, source: 'recorded-feed', sourceKind: 'LIVE' as const }));
    await h.runtime.repos.marketBars.upsert(bars);

    const run = json(await post(h, request({ data: { kind: 'STORED' } })));
    expect(run.result.label).toBe('Historical replay — past results do not predict future results');
    expect(run.result.data).toMatchObject({ m1Bars: bars.length, sources: ['recorded-feed'] });

    // A second source for the same minutes must be chosen explicitly.
    await h.runtime.repos.marketBars.upsert(
      bars.slice(0, 10).map((b) => ({ ...b, source: 'other' })),
    );
    const ambiguous = await post(h, request({ data: { kind: 'STORED' } }));
    expect(ambiguous.statusCode).toBe(400);
    expect(json(ambiguous).error.message).toContain('several sources');
    expect(
      (await post(h, request({ data: { kind: 'STORED', source: 'recorded-feed' } }))).statusCode,
    ).toBe(200);
  }, 60_000);

  it('refuses invalid requests and non-operators', async () => {
    h = await createHarness();
    expect((await post(h, request(), H.viewer)).statusCode).toBe(403);
    expect((await post(h, request(), H.automation)).statusCode).toBe(403);
    const noCalendar: Json = request();
    delete noCalendar.calendar;
    expect((await post(h, noCalendar)).statusCode).toBe(400); // no silent default
    const noNews: Json = request();
    delete noNews.news;
    expect((await post(h, noNews)).statusCode).toBe(400);
    expect((await post(h, request({ from: RANGE.to, to: RANGE.from }))).statusCode).toBe(400);
    expect((await post(h, request({ to: '2026-12-01T00:00:00Z' }))).statusCode).toBe(400); // > 184 days
    const empty = await post(h, request({ data: { kind: 'STORED' } }));
    expect(empty.statusCode).toBe(400);
    expect(json(empty).error.message).toContain('no stored M1 bars');
    // Simulated data without a start price needs a current quote.
    expect((await post(h, request({ data: { kind: 'SIMULATED', seed: 1 } }))).statusCode).toBe(400);
  });
});
