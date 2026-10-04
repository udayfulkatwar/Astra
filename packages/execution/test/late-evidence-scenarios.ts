/**
 * S001-R3: broker evidence about an order whose reservation was ALREADY released. Shared by the
 * in-memory store and the PostgreSQL repository (two handles = two processes). Each scenario uses
 * its own account, because a quarantine blocks the whole account and nothing clears it.
 */
import { expect } from 'vitest';
import type {
  BrokerOrderState,
  ExecutionStore,
  ExposureReservation,
  OrderRecord,
  ReserveResult,
} from '../src/types';

export interface LateEvidenceHarness {
  readonly a: ExecutionStore;
  readonly b: ExecutionStore;
  /** Reserves (and, unless told otherwise, marks dispatched) a fresh order on `account`. */
  newOrder(
    account: string,
    symbol: string,
    quantity: number,
    opts?: { dispatch?: boolean },
  ): Promise<string>;
  /** Attempts a fresh reservation on `account` at its current ledger version. */
  tryReserve(account: string, symbol: string): Promise<ReserveResult>;
  recordClosure(account: string, clientOrderId: string, quantity: number): Promise<void>;
  order(clientOrderId: string): Promise<OrderRecord | null>;
  events(clientOrderId: string): Promise<string[]>;
}

const AT = '2026-09-28T14:00:05.000Z';
export const lateState = (
  id: string,
  status: BrokerOrderState['status'],
  filled: number,
  quantity = 1,
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

async function exposure(h: LateEvidenceHarness, account: string) {
  return h.a.accountExposure(account);
}

async function expectQuarantined(h: LateEvidenceHarness, account: string, id: string) {
  const e = await exposure(h, account);
  expect(e.quarantines.map((q) => q.clientOrderId)).toEqual([id]);
  const r = await h.tryReserve(account, 'ZB');
  expect(r).toMatchObject({ ok: false, code: 'ACCOUNT_QUARANTINED' });
  // Both handles ("processes") see the same durable block.
  expect((await h.b.accountExposure(account)).quarantines).toHaveLength(1);
}

export async function runLateEvidenceScenarios(h: LateEvidenceHarness): Promise<void> {
  // 1. REJECTED with nothing filled releases; a later FILLED from another process is a
  //    contradiction: the order becomes UNKNOWN with the late fill, the account is quarantined,
  //    the released exposure is NOT silently re-created, and repeats are idempotent.
  {
    const acct = 'late-1';
    const x = await h.newOrder(acct, 'NQ', 1);
    expect((await h.a.updateOrder(x, lateState(x, 'REJECTED', 0))).contradiction).toBeNull();
    expect((await exposure(h, acct)).reservations).toHaveLength(0);
    const before = (await exposure(h, acct)).version;
    const late = await h.b.updateOrder(x, lateState(x, 'FILLED', 1));
    expect(late.contradiction).toMatch(/after its exposure was released/);
    expect(late.contradiction).toMatch(/ended as REJECTED but is now reported FILLED/);
    expect(await h.order(x)).toMatchObject({ status: 'UNKNOWN', filledQuantity: 1 });
    expect(await h.events(x)).toContain('STATE_CONTRADICTORY');
    const after = await exposure(h, acct);
    expect(after.version).toBeGreaterThan(before);
    expect(after.reservations).toHaveLength(0);
    await expectQuarantined(h, acct, x);
    // Repeated and stale evidence: nothing durable changes (no second quarantine, no version bump),
    // and a stale "REJECTED 0" never un-quarantines.
    expect((await h.a.updateOrder(x, lateState(x, 'FILLED', 1))).contradiction).not.toBeNull();
    expect((await h.b.updateOrder(x, lateState(x, 'REJECTED', 0))).contradiction).toBeNull();
    const again = await exposure(h, acct);
    expect(again.version).toBe(after.version);
    expect(again.quarantines).toHaveLength(1);
    expect(await h.order(x)).toMatchObject({ status: 'UNKNOWN', filledQuantity: 1 });
  }

  // 2. An intervening commitment on the SAME symbol: the late fill must neither erase nor collide
  //    with it (no silent rollback of the evidence); the account is quarantined.
  {
    const acct = 'late-2';
    const x = await h.newOrder(acct, 'NQ', 1);
    await h.a.updateOrder(x, lateState(x, 'CANCELLED', 0));
    const y = await h.newOrder(acct, 'NQ', 2);
    const held = (await exposure(h, acct)).reservations;
    expect(held.map((r) => r.clientOrderId)).toEqual([y]);
    const late = await h.b.updateOrder(x, lateState(x, 'FILLED', 1));
    expect(late.contradiction).toMatch(/after its exposure was released/);
    const after = (await exposure(h, acct)).reservations;
    expect(after).toHaveLength(1);
    const keep = (r: ExposureReservation) => ({
      clientOrderId: r.clientOrderId,
      symbol: r.symbol,
      quantity: r.quantity,
      reservedQuantity: r.reservedQuantity,
      orderStatus: r.orderStatus,
      dispatched: r.dispatched,
    });
    expect(keep(after[0]!)).toEqual(keep(held[0]!));
    expect(await h.order(x)).toMatchObject({ status: 'UNKNOWN', filledQuantity: 1 });
    await expectQuarantined(h, acct, x);
  }

  // 3. Released by CUMULATIVE closure coverage (fill 1, cancelled, closed 1): a consistent repeat
  //    changes nothing; a later report that it FILLED 3 is a contradiction → quarantine.
  {
    const acct = 'late-3';
    const x = await h.newOrder(acct, 'ES', 3);
    await h.a.updateOrder(x, lateState(x, 'PARTIALLY_FILLED', 1, 3));
    await h.a.updateOrder(x, lateState(x, 'CANCELLED', 1, 3));
    await h.recordClosure(acct, x, 1);
    expect(await h.b.reconcileReservations(acct, AT)).toBe(1);
    expect((await h.a.updateOrder(x, lateState(x, 'CANCELLED', 1, 3))).contradiction).toBeNull();
    expect((await exposure(h, acct)).quarantines).toHaveLength(0);
    const late = await h.b.updateOrder(x, lateState(x, 'FILLED', 3, 3));
    expect(late.contradiction).toMatch(/after its exposure was released/);
    expect(await h.order(x)).toMatchObject({ status: 'UNKNOWN', filledQuantity: 3 });
    await expectQuarantined(h, acct, x);
  }

  // 4. Released as never transmitted: ANY broker trace of the order (here a resting ACCEPTED) is a
  //    contradiction; a quarantined account can no longer dispatch another reserved order.
  {
    const acct = 'late-4';
    const x = await h.newOrder(acct, 'CL', 1, { dispatch: false });
    expect(await h.a.releaseUntransmitted(x, 'final gate refused', AT)).toBe(true);
    const z = await h.newOrder(acct, 'GC', 1, { dispatch: false });
    const late = await h.b.updateOrder(x, lateState(x, 'ACCEPTED', 0));
    expect(late.contradiction).toMatch(/not transmitted/);
    await expectQuarantined(h, acct, x);
    await expect(h.a.markDispatching(z, AT)).rejects.toThrow(/quarantined/);
  }

  // 5. UNKNOWN about a released order (the gateway lost track after the release) quarantines too.
  {
    const acct = 'late-5';
    const x = await h.newOrder(acct, 'SI', 1);
    await h.a.updateOrder(x, lateState(x, 'EXPIRED', 0));
    const late = await h.b.updateOrder(x, lateState(x, 'UNKNOWN', 0));
    expect(late.contradiction).toMatch(/UNKNOWN after its exposure was released/);
    await expectQuarantined(h, acct, x);
  }

  // 6. Consistent repeats after a release are not evidence of anything: no quarantine, no version
  //    change, entries continue.
  {
    const acct = 'late-6';
    const x = await h.newOrder(acct, 'HG', 1);
    await h.a.updateOrder(x, lateState(x, 'REJECTED', 0));
    const v = (await exposure(h, acct)).version;
    expect((await h.b.updateOrder(x, lateState(x, 'REJECTED', 0))).contradiction).toBeNull();
    expect((await h.a.updateOrder(x, lateState(x, 'REJECTED', 0))).contradiction).toBeNull();
    const e = await exposure(h, acct);
    expect(e.version).toBe(v);
    expect(e.quarantines).toHaveLength(0);
    expect(await h.order(x)).toMatchObject({ status: 'REJECTED', filledQuantity: 0 });
    expect(await h.tryReserve(acct, 'HG')).toEqual({ ok: true });
  }
}
