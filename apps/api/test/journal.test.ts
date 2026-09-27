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
const quote = (harness: Harness, bid: number) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/v1/market/quotes',
    headers: H.automation,
    payload: {
      source: 'test',
      quotes: [{ symbol: 'MNQ', bid, ask: bid + 0.25, asOf: harness.clock.now().toISOString() }],
    },
  });

describe.skipIf(!available)('API — trade journal', () => {
  it('journals a closed trade: plan vs actual, costs, R, excursions — and summarises', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h), autoExecute: true },
      }),
    );
    expect(r.execution.outcome).toBe('CONFIRMED'); // LONG 5 MNQ @ 20,000.25, stop −10, target +20
    await h.runtime.cycle(); // the open position is now tracked

    for (const [ms, bid] of [
      [30_000, 20_010],
      [30_000, 19_995], // the worst it gets
      [30_000, 20_021], // through the target (20,020.25): the paper broker closes it there
    ] as const) {
      h.clock.advance(ms);
      await quote(h, bid);
    }
    await h.runtime.cycle(); // close synced → journaled

    const { entries } = await get(h, '/api/v1/journal?accountId=paper-demo');
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e).toMatchObject({
      source: 'ASTRA',
      accountId: 'paper-demo',
      strategyId: 'paper-pipeline-test',
      decisionId: r.decision.decisionId,
      mode: 'PAPER',
      symbol: 'MNQ',
      direction: 'LONG',
      quantity: 5,
      plan: { entry: 20_000.25, stop: 19_990.25, target: 20_020.25, rewardToRisk: 2 },
      entry: { price: 20_000.25, slippageTicks: 0 },
      exit: { price: 20_020.25, reason: 'TARGET', slippageTicks: 0 },
      durationSec: 90,
      // MNQ $2/pt × 5 = $10/pt: +20 pt = $200 gross, $1.50 × 5 commission.
      result: { grossPnl: 200, costs: 7.5, netPnl: 192.5, initialRisk: 100, outcome: 'WIN' },
      excursion: {
        mfe: { price: 20_021, pnl: 207.5 },
        mae: { price: 19_995, pnl: -52.5 },
        coverage: 'FULL',
      },
      exitedAsPlanned: true,
    });
    expect(e.result.rMultiple).toBeCloseTo(1.93, 1);
    expect(e.plan.plannedRisk).toBe(r.decision.sizing.dollarRisk);

    const events = (await get(h, '/api/v1/events?limit=50')).events as Json[];
    expect(events.find((x) => x.type === 'TRADE_JOURNALED')).toMatchObject({
      component: 'journal',
      accountId: 'paper-demo',
    });
    const s = await get(h, '/api/v1/journal/summary?accountId=paper-demo');
    expect(s.overall).toMatchObject({ trades: 1, wins: 1, winRatePct: 100, netPnl: 192.5 });
    expect(s.byStrategy[0]).toMatchObject({ key: 'paper-pipeline-test' });
    expect((await h.app.inject({ url: '/api/v1/journal' })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ url: '/api/v1/journal?symbol=mnq', headers: H.viewer })).statusCode,
    ).toBe(400);
  });
});
