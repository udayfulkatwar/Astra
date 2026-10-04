/**
 * S001-R3 — evidence that arrives AFTER a reservation was released (in-memory store; the
 * PostgreSQL equivalents with two pools live in packages/db/test/late-evidence.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryExecutionStore } from '../src/memory-store';
import type { BrokerOrderState, ExecutionStore, OrderRecord } from '../src/types';
import { lateState, runLateEvidenceScenarios } from './late-evidence-scenarios';
import { decide, instrument, makeBroker, makeGateway, makeWorld, type World } from './gate-world';

const AT = '2026-09-28T14:00:00.000Z';
const reasons = (r: { reasons: readonly string[] }) => r.reasons.join(' | ');

function plainOrder(id: number, account: string, symbol: string, quantity: number): OrderRecord {
  return {
    orderId: `o_l${id}`,
    clientOrderId: `astra-apr_l${id}`,
    approvalId: `apr_l${id}`,
    decisionId: `dec_l${id}`,
    accountId: account,
    strategyId: 's',
    signalId: `sg_l${id}`,
    adapterId: 'paper',
    mode: 'PAPER',
    symbol,
    direction: 'LONG',
    quantity,
    entryType: 'MARKET',
    plannedEntry: 20_000,
    stopLoss: 19_990,
    takeProfit: 20_030,
    status: 'PENDING_SUBMIT',
    brokerOrderId: null,
    filledQuantity: 0,
    averageFillPrice: null,
    rejectReason: null,
    expiresAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function addPlainApproval(store: InMemoryExecutionStore, o: OrderRecord): void {
  store.addApproval({
    approvalId: o.approvalId,
    decisionId: o.decisionId,
    accountId: o.accountId,
    strategyId: o.strategyId,
    signalId: o.signalId,
    mode: 'PAPER',
    expiresAt: '2026-09-28T14:10:00.000Z',
    state: 'PENDING',
    orderPlan: {
      symbol: o.symbol,
      direction: 'LONG',
      entryType: 'MARKET',
      entry: 20_000,
      stop: 19_990,
      target: 20_030,
      quantity: o.quantity,
    },
  });
}

describe('late evidence after a release (in-memory parity)', () => {
  it('late fill / different ending / trace of an untransmitted order quarantine the account durably; repeats are idempotent', async () => {
    const store = new InMemoryExecutionStore();
    let n = 0;
    const reserve = async (account: string, symbol: string, quantity: number) => {
      const o = plainOrder(++n, account, symbol, quantity);
      addPlainApproval(store, o);
      const v = (await store.accountExposure(account)).version;
      return {
        id: o.clientOrderId,
        r: await store.reserveAndConsume({ order: o, expectedVersion: v, at: AT, intent: {} }),
      };
    };
    await runLateEvidenceScenarios({
      a: store,
      b: store,
      async newOrder(account, symbol, quantity, opts) {
        const { id, r } = await reserve(account, symbol, quantity);
        expect(r).toEqual({ ok: true });
        if (opts?.dispatch !== false) await store.markDispatching(id, AT);
        return id;
      },
      tryReserve: async (account, symbol) => (await reserve(account, symbol, 1)).r,
      recordClosure: (_a, id, q) => Promise.resolve(store.recordClosure(id, q)),
      order: (id) => Promise.resolve(store.orders.get(id) ?? null),
      events: (id) =>
        Promise.resolve(store.events.filter((e) => e.clientOrderId === id).map((e) => e.type)),
    });
  });
});

/** The production wiring of onExecutionUnknown: an EXECUTION kill switch on the world. */
function halting(w: World) {
  return vi.fn((accountId: string, clientOrderId: string, reason: string) => {
    w.ks.activate({
      scope: 'EXECUTION',
      target: accountId,
      reason: `order ${clientOrderId} state unknown: ${reason}`,
      actor: { type: 'SYSTEM', id: 'execution-gateway' },
    });
    return Promise.resolve();
  });
}

function setup(
  w: World = makeWorld(),
  store: InMemoryExecutionStore = new InMemoryExecutionStore(),
) {
  const paper = makeBroker(w);
  const submit = vi.spyOn(paper, 'submitOrder');
  const broker = instrument(w, paper);
  const add = (o: Parameters<typeof decide>[1]) => {
    const d = decide(w, o);
    store.addApproval(d.approval);
    return d;
  };
  return { w, store, paper, submit, broker, add };
}

const st = (id: string, status: BrokerOrderState['status'], filled: number) =>
  lateState(id, status, filled);

describe('gateway: one call — submit says REJECTED 0, the poll says FILLED 1', () => {
  it('is UNKNOWN (never CONFIRMED), halts, quarantines durably, and blocks every later entry in every gateway', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    s.submit.mockResolvedValueOnce(st('astra-a1', 'REJECTED', 0));
    vi.spyOn(s.paper, 'getOrder').mockResolvedValue(st('astra-a1', 'FILLED', 1));
    const unknown = halting(s.w);
    const gw = makeGateway(s.w, s.store, s.broker, { onExecutionUnknown: unknown });
    const r = await gw.execute('a1');
    expect(r.outcome).toBe('UNKNOWN');
    expect(reasons(r)).toMatch(/after its exposure was released/);
    expect(unknown).toHaveBeenCalled();
    expect(s.store.orders.get('astra-a1')).toMatchObject({ status: 'UNKNOWN', filledQuantity: 1 });
    const e = await s.store.accountExposure('acct-a');
    expect(e.quarantines.map((q) => q.clientOrderId)).toEqual(['astra-a1']);
    // A different gateway (e.g. after a restart, with the process-local kill switch gone) still
    // refuses: the block lives in the shared store.
    s.w.ks.load([]);
    const other = makeGateway(s.w, s.store, s.broker);
    const r2 = await other.execute('a2');
    expect(r2.outcome).toBe('REJECTED');
    expect(reasons(r2)).toMatch(/quarantined/);
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.store.approvals.get('a2')!.state).toBe('PENDING');
  });
});

describe('evidence arriving while a validation waits', () => {
  /** Releases an earlier order (REJECTED 0) so its late fill can arrive mid-validation. */
  async function releasedEarlier(s: ReturnType<typeof setup>) {
    s.add({ approvalId: 'a0', signalId: 's0', symbol: 'NQ' });
    s.submit.mockResolvedValueOnce(st('astra-a0', 'REJECTED', 0));
    const getOrder = vi.spyOn(s.paper, 'getOrder').mockResolvedValue(st('astra-a0', 'REJECTED', 0));
    const gw = makeGateway(s.w, s.store, s.broker);
    expect((await gw.execute('a0')).outcome).toBe('REJECTED');
    getOrder.mockRestore();
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
    return gw;
  }

  it('first validation: the gate re-reads the ledger after the async revalidation and refuses', async () => {
    const s = setup();
    const gw = await releasedEarlier(s);
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'ES' });
    s.w.onRevalidate = async () => {
      s.w.onRevalidate = null;
      await s.store.updateOrder('astra-a0', st('astra-a0', 'FILLED', 1));
    };
    const r = await gw.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/quarantined/);
    expect(s.submit).toHaveBeenCalledTimes(1); // only a0, long ago
    expect(s.store.approvals.get('a1')!.state).toBe('PENDING'); // nothing consumed
  });

  it('final gate (after the reservation): refuses, releases the untransmitted reservation, sends nothing', async () => {
    const s = setup();
    const gw = await releasedEarlier(s);
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'ES' });
    let calls = 0;
    s.w.onRevalidate = async () => {
      if (++calls === 2) await s.store.updateOrder('astra-a0', st('astra-a0', 'FILLED', 1));
    };
    const r = await gw.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/quarantined.*nothing was transmitted/);
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.store.orders.get('astra-a1')).toMatchObject({ status: 'REJECTED' });
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
  });

  it('final gate: an unrelated ledger change during validation re-runs the gate (bounded) instead of trusting the stale verdict', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'ES' });
    // Another account activity bumps the shared ledger while the final validation waits.
    const other = plainOrder(99, 'acct-a', 'NQ', 1);
    addPlainApproval(s.store, other);
    let calls = 0;
    s.w.onRevalidate = async () => {
      if (++calls !== 2) return;
      const v = (await s.store.accountExposure('acct-a')).version;
      await s.store.reserveAndConsume({ order: other, expectedVersion: v, at: AT, intent: {} });
      await s.store.markDispatching(other.clientOrderId, AT);
      await s.store.updateOrder(other.clientOrderId, st(other.clientOrderId, 'REJECTED', 0));
    };
    const r = await gw(s).execute('a1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(calls).toBe(3); // first gate, final gate (ledger moved), final gate again
  });
  const gw = (s: ReturnType<typeof setup>) => makeGateway(s.w, s.store, s.broker);
});

describe('database failure and lost acknowledgements around the quarantine', () => {
  it('lost acknowledgement AFTER the quarantine committed: UNKNOWN + halt; re-applying is idempotent; the block survives a restart', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    s.submit.mockResolvedValueOnce(st('astra-a1', 'REJECTED', 0));
    vi.spyOn(s.paper, 'getOrder').mockResolvedValue(st('astra-a1', 'FILLED', 1));
    const real = s.store.updateOrder.bind(s.store);
    let lose = false;
    const flaky: ExecutionStore = Object.assign(Object.create(s.store) as ExecutionStore, {
      async updateOrder(id: string, state: BrokerOrderState) {
        const out = await real(id, state);
        if (state.status === 'FILLED' && !lose) {
          lose = true;
          throw new Error('connection reset after commit');
        }
        return out;
      },
    });
    const unknown = halting(s.w);
    const gw = makeGateway(s.w, flaky, s.broker, { onExecutionUnknown: unknown });
    expect((await gw.execute('a1')).outcome).toBe('UNKNOWN');
    expect(unknown).toHaveBeenCalled();
    const v = (await s.store.accountExposure('acct-a')).version;
    await real('astra-a1', st('astra-a1', 'FILLED', 1)); // reconciliation re-applies the evidence
    const e = await s.store.accountExposure('acct-a');
    expect(e.version).toBe(v);
    expect(e.quarantines).toHaveLength(1);
    s.w.ks.load([]); // "restart": process-local state gone
    const r = await makeGateway(s.w, s.store, s.broker).execute('a2');
    expect(reasons(r)).toMatch(/quarantined/);
    expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it('write failure BEFORE the quarantine: UNKNOWN + halt (nothing durable yet); the evidence quarantines when re-applied; nothing is sent meanwhile', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    s.submit.mockResolvedValueOnce(st('astra-a1', 'REJECTED', 0));
    vi.spyOn(s.paper, 'getOrder').mockResolvedValue(st('astra-a1', 'FILLED', 1));
    const real = s.store.updateOrder.bind(s.store);
    let down = true;
    const failing: ExecutionStore = Object.assign(Object.create(s.store) as ExecutionStore, {
      updateOrder(id: string, state: BrokerOrderState) {
        if (down && state.status !== 'REJECTED') return Promise.reject(new Error('db down'));
        return real(id, state);
      },
    });
    const unknown = halting(s.w);
    const gw = makeGateway(s.w, failing, s.broker, { onExecutionUnknown: unknown });
    const r1 = await gw.execute('a1');
    expect(r1.outcome).toBe('UNKNOWN');
    expect(unknown).toHaveBeenCalled();
    expect((await s.store.accountExposure('acct-a')).quarantines).toHaveLength(0);
    // Meanwhile the process is halted: nothing is sent.
    expect((await gw.execute('a2')).outcome).toBe('REJECTED');
    // The database recovers; the broker evidence is re-applied (reconciliation / refresh).
    down = false;
    expect((await real('astra-a1', st('astra-a1', 'FILLED', 1))).contradiction).not.toBeNull();
    expect((await s.store.accountExposure('acct-a')).quarantines).toHaveLength(1);
    s.w.ks.load([]);
    expect(reasons(await makeGateway(s.w, s.store, s.broker).execute('a2'))).toMatch(/quarantined/);
    expect(s.submit).toHaveBeenCalledTimes(1);
  });
});
