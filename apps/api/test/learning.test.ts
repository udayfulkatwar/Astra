import { afterEach, describe, expect, it } from 'vitest';
import { H, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const get = (harness: Harness, url: string) => harness.app.inject({ url, headers: H.viewer });

describe.skipIf(!available)('API — learning metrics', () => {
  it('reports on a backtest run by every dimension, with sample-size honesty', async () => {
    h = await createHarness();
    const run = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/backtests',
        headers: H.operator,
        payload: {
          symbol: 'MNQ',
          accountId: 'paper-demo',
          calendar: 'SIMULATED_SCHEDULE',
          news: 'SIMULATED_FEED',
          from: '2026-03-02T00:00:00Z',
          to: '2026-03-14T00:00:00Z',
          data: { kind: 'SIMULATED', seed: 8, startPrice: 18_000 },
        },
      }),
    );
    const trades = run.result.trades.length as number;
    expect(trades).toBeGreaterThan(0);

    const res = await get(
      h,
      `/api/v1/learning?source=backtest&runId=${run.runId}&timeZone=America/New_York`,
    );
    expect(res.statusCode).toBe(200);
    const r = json(res);
    expect(r.source).toMatchObject({ kind: 'backtest', runId: run.runId });
    expect(r.source.label).toContain('SIMULATED');
    expect(r.trades).toBe(trades);
    expect(r.overall.trades).toBe(trades);
    expect(r.overall.smallSample).toBe(true); // well under 30 trades
    expect(r.timeZone).toBe('America/New_York');
    const dims = (r.dimensions as Json[]).map((d) => d.dimension);
    expect(dims).toEqual([
      'strategy',
      'instrument',
      'direction',
      'session',
      'hour',
      'weekday',
      'setup',
      'eventDay',
      'heldThroughEvent',
      'exit',
      'mode',
    ]);
    // Backtest trades carry context: the TEMPLATE setup label and SIMULATED event facts.
    const setups = (r.dimensions as Json[]).find((d) => d.dimension === 'setup')!.groups as Json[];
    expect(setups.every((g) => /^(BOS|CHOCH) (long|short)$/.test(g.key))).toBe(true);
    expect((r.notes as string[]).some((n) => n.includes('SIMULATED placeholder calendar'))).toBe(
      true,
    );
    expect(r.observations).toEqual([]); // too few trades to observe anything
    expect(r.curve.at(-1).cumR).toBeCloseTo(run.result.summary.overall.totalR, 1);
  }, 60_000);

  it('reports on the journal (empty here) and validates its parameters', async () => {
    h = await createHarness();
    const r = json(await get(h, '/api/v1/learning'));
    expect(r).toMatchObject({ trades: 0, source: { kind: 'journal' }, observations: [] });
    expect((await get(h, '/api/v1/learning?timeZone=Mars/Base')).statusCode).toBe(400);
    expect((await get(h, '/api/v1/learning?source=backtest')).statusCode).toBe(400);
    expect((await get(h, '/api/v1/learning?source=backtest&runId=btr_x')).statusCode).toBe(404);
    expect((await h.app.inject({ url: '/api/v1/learning' })).statusCode).toBe(401);
  });
});
