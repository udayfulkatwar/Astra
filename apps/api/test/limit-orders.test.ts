import { afterEach, describe, expect, it } from 'vitest';
import {
  FX_QUOTES,
  H,
  bringOnline,
  candidate,
  createHarness,
  dbAvailable,
  type Harness,
} from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const get = async (harness: Harness, url: string) =>
  json(await harness.app.inject({ url, headers: H.operator }));

const inMinutes = (harness: Harness, m: number) =>
  new Date(harness.clock.now().getTime() + m * 60_000).toISOString();

/** A resting LONG MNQ limit 5 points under the market (bid 20,000 / ask 20,000.25). */
async function placeLimit(harness: Harness, minutes = 30) {
  const r = json(
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: {
        candidate: candidate(harness, {
          entryType: 'LIMIT',
          entry: 19_995,
          stop: 19_985,
          target: 20_025,
          expiresAt: inMinutes(harness, minutes),
        }),
        autoExecute: true,
      },
    }),
  );
  expect(r.decision.reasons).toEqual([]);
  expect(r.execution.outcome).toBe('CONFIRMED');
  return r;
}

async function quotes(harness: Harness, bid: number) {
  const asOf = harness.clock.now().toISOString();
  await harness.app.inject({
    method: 'POST',
    url: '/api/v1/market/quotes',
    headers: H.automation,
    payload: {
      source: 'test',
      quotes: [
        { symbol: 'MNQ', bid, ask: bid + 0.25, asOf },
        { symbol: 'NQ', bid, ask: bid + 0.25, asOf },
        { symbol: 'XAUUSD', bid: 2_600, ask: 2_600.2, asOf },
        ...FX_QUOTES.map((q) => ({ ...q, asOf })),
      ],
    },
  });
}

const events = async (harness: Harness) =>
  ((await get(harness, '/api/v1/events?limit=100')).events as Json[]).map((e) => e.type);

describe.skipIf(!available)('API — LIMIT entries (ADR-0023)', () => {
  it('rests at the broker, counts as exposure, fills at the limit and is journaled as a trade', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = await placeLimit(h);
    expect(r.decision.orderPlan).toMatchObject({ entryType: 'LIMIT', entry: 19_995 });
    expect(r.execution.reasons[0]).toMatch(/^WORKING: LIMIT/);

    await h.runtime.cycle();
    const acct = await get(h, '/api/v1/accounts/paper-demo');
    expect(acct.orders[0]).toMatchObject({ status: 'ACCEPTED', entryType: 'LIMIT' });
    expect(acct.snapshot.value.workingOrders).toHaveLength(1);
    expect(acct.state.openRisk.amount).toBeGreaterThan(0); // the resting order's risk

    // The market trades down through the limit: filled at 19,995, the bracket attached.
    h.clock.advance(60_000);
    await quotes(h, 19_990);
    await h.runtime.cycle();
    const after = await get(h, '/api/v1/accounts/paper-demo');
    expect(after.orders[0]).toMatchObject({ status: 'FILLED', averageFillPrice: 19_995 });
    expect(after.snapshot.value.openPositions[0]).toMatchObject({
      entryPrice: 19_995,
      stopPrice: 19_985,
    });
    expect(await events(h)).toContain('ORDER_FILLED');
  });

  it('is cancelled when a kill switch blocks new trades, and expires unfilled when not reached', async () => {
    h = await createHarness();
    await bringOnline(h);
    await placeLimit(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/activate',
      headers: H.operator,
      payload: { scope: 'STRATEGY', target: 'paper-pipeline-test', reason: 'pause strategy' },
    });
    await h.runtime.cycle();
    expect((await get(h, '/api/v1/accounts/paper-demo')).orders[0].status).toBe('CANCELLED');
    expect(await events(h)).toContain('ORDER_CANCELLED');
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/deactivate',
      headers: H.operator,
      payload: { scope: 'STRATEGY', target: 'paper-pipeline-test', reason: 'resume' },
    });

    const second = await placeLimit(h, 5);
    h.clock.advance(6 * 60_000);
    await quotes(h, 20_000);
    await h.runtime.cycle();
    const orders = (await get(h, '/api/v1/accounts/paper-demo')).orders as Json[];
    const id = second.execution.order.clientOrderId as string;
    expect(orders.find((o) => o.clientOrderId === id)).toMatchObject({ status: 'EXPIRED' });
    expect(await events(h)).toContain('ORDER_EXPIRED');
  });

  it('is cancelled when a restricted event appears inside the window it would rest through', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = await placeLimit(h, 30);
    // A HIGH-impact event 40 min away: after the expiry, but inside its 15-min blackout.
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/calendar/window',
      headers: H.automation,
      payload: {
        source: 'test',
        window: {
          from: new Date(h.clock.now().getTime() - 3_600_000).toISOString(),
          to: new Date(h.clock.now().getTime() + 86_400_000).toISOString(),
          events: [
            {
              id: 'fomc',
              title: 'Test FOMC',
              impact: 'HIGH',
              scheduledAt: inMinutes(h, 40),
              currency: 'USD',
              affectedInstruments: [],
            },
          ],
        },
      },
    });
    await h.runtime.cycle();
    const id = r.execution.order.clientOrderId as string;
    const orders = (await get(h, '/api/v1/accounts/paper-demo')).orders as Json[];
    expect(orders.find((o) => o.clientOrderId === id)).toMatchObject({ status: 'CANCELLED' });
    const ev = ((await get(h, '/api/v1/events?limit=50')).events as Json[]).find(
      (e) => e.type === 'ORDER_CANCELLED',
    );
    expect(ev?.message).toMatch(/Test FOMC/);
  });

  it('an operator can cancel a resting order; a restart keeps it tracked, not halted', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = await placeLimit(h);
    h = await h.restart();
    const ks = (await get(h, '/api/v1/kill-switches')).switches as Json[];
    expect(ks.filter((s) => s.active)).toEqual([]); // a resting order is a known state
    const id = r.execution.order.clientOrderId as string;
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/v1/orders/${id}/cancel`,
          headers: H.viewer,
        })
      ).statusCode,
    ).toBe(403);
    const c = json(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/orders/${id}/cancel`,
        headers: H.operator,
      }),
    );
    expect(c.outcome).toBe('CANCELLED');
  });
});
