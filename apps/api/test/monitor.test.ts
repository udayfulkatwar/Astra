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

describe.skipIf(!available)('API — position monitor', () => {
  it('tracks an open position live, alerts near the stop and when prices go stale', async () => {
    h = await createHarness();
    await bringOnline(h); // MNQ 20,000 / 20,000.25
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h), autoExecute: true },
      }),
    );
    expect(r.execution.outcome).toBe('CONFIRMED'); // LONG 5 MNQ @ 20,000.25, stop −10, target +20
    await h.runtime.cycle();

    let m = await get(h, '/api/v1/monitor/positions');
    expect(m.policy).toMatchObject({ stopProximityPct: 25, bufferWarnPct: 70 });
    const acct = m.accounts.find((a: Json) => a.accountId === 'paper-demo');
    expect(acct.status).toBe('OK');
    // MNQ: $0.50 per 0.25 tick → $2/pt × 5 = $10/pt.
    expect(acct.positions[0]).toMatchObject({
      symbol: 'MNQ',
      direction: 'LONG',
      quantity: 5,
      entryPrice: 20_000.25,
      mark: 20_000, // exit side: the bid
      unrealizedPnl: -2.5,
      initialRisk: 100,
      stopRemainingPct: 97.5,
      targetProgressPct: -1.25,
      flags: [],
    });
    expect(acct.bufferUsedPct).toEqual(expect.any(Number));
    expect(m.alerts).toEqual([]);

    // Price falls to 1.75 points above the stop: 17.5% of the stop distance left.
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/market/quotes',
      headers: H.automation,
      payload: {
        source: 'test',
        quotes: [{ symbol: 'MNQ', bid: 19_992, ask: 19_992.25, asOf: h.clock.now().toISOString() }],
      },
    });
    await h.runtime.cycle();
    m = await get(h, '/api/v1/monitor/positions');
    expect(m.alerts).toEqual([
      expect.objectContaining({
        kind: 'STOP_NEAR',
        level: 'WARN',
        accountId: 'paper-demo',
        symbol: 'MNQ',
      }),
    ]);
    const events = (await get(h, '/api/v1/events?limit=50')).events as Json[];
    expect(events.find((e) => e.type === 'POSITION_STOP_NEAR_RAISED')).toMatchObject({
      level: 'WARN',
      component: 'position-monitor',
      accountId: 'paper-demo',
    });

    // No quote for longer than quoteMaxAgeMs: the position can no longer be monitored.
    h.clock.advance(6_000);
    await h.runtime.cycle();
    m = await get(h, '/api/v1/monitor/positions');
    expect(m.accounts[0].positions[0]).toMatchObject({ mark: null, flags: ['NO_PRICE'] });
    // The stop alert stays up: without a price its distance is unknown, not "fine".
    expect(m.alerts.map((a: Json) => a.kind).sort()).toEqual(['NO_PRICE', 'STOP_NEAR']);

    expect((await h.app.inject({ url: '/api/v1/monitor/positions' })).statusCode).toBe(401);
  });
});
