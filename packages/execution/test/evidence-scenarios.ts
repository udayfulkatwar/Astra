/**
 * Broker-evidence scenarios shared by the in-memory store and the PostgreSQL repository (run through
 * TWO store handles, i.e. two "processes"): zero/decreasing/malformed fills and out-of-order states
 * must never free risk — the reservation stays, the known fill is preserved, the order is UNKNOWN.
 */
import { expect } from 'vitest';
import type {
  BrokerOrderState,
  ExecutionStore,
  ExposureReservation,
  OrderRecord,
} from '../src/types';

export interface EvidenceHarness {
  /** Two handles on the same state (two repository instances / the same memory store twice). */
  readonly a: ExecutionStore;
  readonly b: ExecutionStore;
  /** Reserves a fresh dispatched order of the given quantity on its own symbol. */
  newOrder(symbol: string, quantity: number): Promise<string>;
  recordClosure(clientOrderId: string, quantity: number): Promise<void>;
  order(clientOrderId: string): Promise<OrderRecord | null>;
  events(clientOrderId: string): Promise<string[]>;
}

const AT = '2026-09-28T14:00:05.000Z';
export const st = (
  id: string,
  status: BrokerOrderState['status'],
  filled: number,
  quantity = 3,
): BrokerOrderState => ({
  clientOrderId: id,
  brokerOrderId: 'b',
  status,
  quantity,
  filledQuantity: filled,
  averageFillPrice: filled > 0 ? 20_000 : null,
  rejectReason: null,
  updatedAt: AT,
});

const find = async (h: EvidenceHarness, id: string): Promise<ExposureReservation | undefined> =>
  (await h.a.accountExposure('acct-a')).reservations.find((r) => r.clientOrderId === id);

/** Asserts risk was NOT freed: still reserved in full, known fill kept, order unresolved. */
async function heldUnresolved(
  h: EvidenceHarness,
  id: string,
  o: { filled: number; reserved: number },
) {
  expect(await find(h, id)).toMatchObject({
    orderStatus: 'UNKNOWN',
    filledQuantity: o.filled,
    reservedQuantity: o.reserved,
  });
  expect(await h.order(id)).toMatchObject({ status: 'UNKNOWN', filledQuantity: o.filled });
  expect(await h.events(id)).toContain('STATE_CONTRADICTORY');
}

export async function runEvidenceScenarios(h: EvidenceHarness): Promise<void> {
  // 1. partial fill 1, then CANCELLED / REJECTED / EXPIRED reporting filled 0 → must NOT release.
  for (const [i, ended] of (['CANCELLED', 'REJECTED', 'EXPIRED'] as const).entries()) {
    const id = await h.newOrder(['NQ', 'ES', 'MNQ'][i]!, 3);
    expect((await h.a.updateOrder(id, st(id, 'PARTIALLY_FILLED', 1))).contradiction).toBeNull();
    const r = await h.b.updateOrder(id, st(id, ended, 0)); // the other instance sees the zero
    expect(r.contradiction).toMatch(/fill decreased from 1 to 0/);
    await heldUnresolved(h, id, { filled: 1, reserved: 3 });
  }

  // 2. FILLED reported with 0 (after a partial, and as the first evidence) must NOT release.
  const f1 = await h.newOrder('YM', 3);
  await h.a.updateOrder(f1, st(f1, 'PARTIALLY_FILLED', 1));
  expect((await h.b.updateOrder(f1, st(f1, 'FILLED', 0))).contradiction).toMatch(/decreased/);
  await heldUnresolved(h, f1, { filled: 1, reserved: 3 });
  const f2 = await h.newOrder('GC', 3);
  expect((await h.a.updateOrder(f2, st(f2, 'FILLED', 0))).contradiction).toMatch(
    /FILLED with fill 0 below/,
  );
  await heldUnresolved(h, f2, { filled: 0, reserved: 3 });

  // 3. decreasing fills.
  const d = await h.newOrder('CL', 3);
  await h.a.updateOrder(d, st(d, 'PARTIALLY_FILLED', 2));
  expect((await h.b.updateOrder(d, st(d, 'PARTIALLY_FILLED', 1))).contradiction).toMatch(
    /decreased from 2 to 1/,
  );
  await heldUnresolved(h, d, { filled: 2, reserved: 3 });

  // 4. out-of-order / contradictory lifecycle: ended then backwards, or ended then a different ending.
  const o1 = await h.newOrder('SI', 3);
  await h.a.updateOrder(o1, st(o1, 'FILLED', 3));
  expect((await h.b.updateOrder(o1, st(o1, 'PARTIALLY_FILLED', 1))).contradiction).toMatch(
    /backwards|decreased/,
  );
  await heldUnresolved(h, o1, { filled: 3, reserved: 3 });
  const o2 = await h.newOrder('NG', 3);
  await h.a.updateOrder(o2, st(o2, 'FILLED', 3));
  expect((await h.b.updateOrder(o2, st(o2, 'CANCELLED', 3))).contradiction).toMatch(
    /ended as FILLED/,
  );
  await heldUnresolved(h, o2, { filled: 3, reserved: 3 });
  const o3 = await h.newOrder('HG', 3);
  await h.a.updateOrder(o3, st(o3, 'PARTIALLY_FILLED', 2));
  expect((await h.b.updateOrder(o3, st(o3, 'ACCEPTED', 2))).contradiction).toMatch(/backwards/);
  await heldUnresolved(h, o3, { filled: 2, reserved: 3 });

  // 5. malformed evidence: non-finite, negative, overfilled.
  const m1 = await h.newOrder('PL', 3);
  await h.a.updateOrder(m1, st(m1, 'PARTIALLY_FILLED', 1));
  expect((await h.b.updateOrder(m1, st(m1, 'CANCELLED', Number.NaN))).contradiction).toMatch(
    /malformed/,
  );
  await heldUnresolved(h, m1, { filled: 1, reserved: 3 });
  const m2 = await h.newOrder('PA', 3);
  expect((await h.a.updateOrder(m2, st(m2, 'CANCELLED', -2))).contradiction).toMatch(/malformed/);
  await heldUnresolved(h, m2, { filled: 0, reserved: 3 });
  const m3 = await h.newOrder('ZN', 3);
  expect((await h.a.updateOrder(m3, st(m3, 'FILLED', 5))).contradiction).toMatch(
    /exceeds the order quantity/,
  );
  expect(await find(h, m3)).toMatchObject({
    orderStatus: 'UNKNOWN',
    filledQuantity: 5,
    reservedQuantity: 5,
  });

  // 6. contradictions block new entries (unresolved) and a later CONSISTENT state resolves them:
  //    the cumulative fill is preserved, and only linked closures covering it release the risk.
  const ex = (await h.a.accountExposure('acct-a')).reservations.find(
    (r) => r.clientOrderId === f1,
  )!;
  expect(ex.orderStatus).toBe('UNKNOWN');
  expect((await h.a.updateOrder(f1, st(f1, 'CANCELLED', 1))).contradiction).toBeNull();
  expect(await find(h, f1)).toMatchObject({
    orderStatus: 'CANCELLED',
    reservedQuantity: 1,
    filledQuantity: 1,
  });
  expect(await h.b.reconcileReservations('acct-a', AT)).toBe(0);
  await h.recordClosure(f1, 1);
  expect(await h.b.reconcileReservations('acct-a', AT)).toBeGreaterThanOrEqual(1);
  expect(await find(h, f1)).toBeUndefined();

  // 7. consistent progress and idempotent repeats are still accepted.
  const ok = await h.newOrder('RB', 3);
  for (const s of [
    st(ok, 'ACCEPTED', 0),
    st(ok, 'PARTIALLY_FILLED', 1),
    st(ok, 'PARTIALLY_FILLED', 1),
    st(ok, 'PARTIALLY_FILLED', 2),
    st(ok, 'FILLED', 3),
    st(ok, 'FILLED', 3),
  ])
    expect((await h.b.updateOrder(ok, s)).contradiction).toBeNull();
  expect(await find(h, ok)).toMatchObject({
    orderStatus: 'FILLED',
    reservedQuantity: 3,
    filledQuantity: 3,
  });
}
