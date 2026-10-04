/**
 * S001 — fresh pre-submit validation and durable account-wide reservations, in-memory store.
 * The DB-backed (separate gateways, real PG) equivalents live in packages/db/test.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrokerAdapter } from '../src/types';
import { InMemoryExecutionStore } from '../src/memory-store';
import { PaperBrokerAdapter } from '../src/paper/paper-broker';
import { confirmedClosures, snapshotWithReservations } from '../src/reservations';
import { runEvidenceScenarios } from './evidence-scenarios';
import {
  ES,
  decide,
  instrument,
  makeBroker,
  makeGateway,
  makeWorld,
  realRevalidator,
  type World,
} from './gate-world';

function setup(w: World = makeWorld()) {
  const store = new InMemoryExecutionStore();
  const paper = makeBroker(w);
  const submit = vi.spyOn(paper, 'submitOrder');
  const broker: BrokerAdapter = instrument(w, paper);
  const gateway = makeGateway(w, store, broker);
  const add = (o: Parameters<typeof decide>[1]) => {
    const d = decide(w, o);
    store.addApproval(d.approval);
    return d;
  };
  return { w, store, paper, submit, broker, gateway, add };
}
const reasons = (r: { reasons: readonly string[] }) => r.reasons.join(' | ');

describe('queued approvals cannot survive a changed control plane (regression for the queued-change bug)', () => {
  /** a1 holds the account lock inside its broker snapshot while a2 queues behind it. */
  async function queued(mutate: (s: ReturnType<typeof setup>) => void) {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    s.w.onSnapshot = async () => {
      if (first) {
        first = false;
        await held;
      }
    };
    const p1 = s.gateway.execute('a1');
    await new Promise((r) => setTimeout(r, 5));
    const p2 = s.gateway.execute('a2');
    await new Promise((r) => setTimeout(r, 5));
    mutate(s);
    release();
    return { s, r1: await p1, r2: await p2 };
  }

  it('kill switch set while queued', async () => {
    const { s, r1, r2 } = await queued((x) =>
      x.w.ks.activate({
        scope: 'INSTRUMENT',
        target: 'ES',
        reason: 'operator stop',
        actor: { type: 'HUMAN', id: 'u' },
      }),
    );
    expect(r1.outcome).toBe('CONFIRMED');
    expect(r2.outcome).toBe('REJECTED');
    expect(reasons(r2)).toMatch(/operator stop/);
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.store.rejections.map((x) => x.approvalId)).toContain('a2');
  });

  it('approval expiring while queued', async () => {
    const { s, r2 } = await queued((x) => x.w.clock.advance(60_000));
    expect(reasons(r2)).toMatch(/expired/);
    expect(s.store.approvals.get('a2')!.state).toBe('EXPIRED');
    expect(s.submit).not.toHaveBeenCalled(); // a1 was queued behind the same clock jump
  });

  it('mode changing while queued', async () => {
    const { s, r2 } = await queued((x) => (x.w.mode = 'HALTED'));
    expect(reasons(r2)).toMatch(/mode changed/);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('account suspended while queued', async () => {
    const { s, r2 } = await queued((x) => (x.w.accountStatus = 'SUSPENDED'));
    expect(reasons(r2)).toMatch(/account status SUSPENDED/);
    expect(s.submit).not.toHaveBeenCalled();
  });
});

describe('re-checks after relevant awaited work and right before submit', () => {
  it('kill switch raised during the broker snapshot', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.onSnapshot = () => {
      s.w.ks.activate({
        scope: 'GLOBAL',
        target: null,
        reason: 'mid-snapshot stop',
        actor: { type: 'HUMAN', id: 'u' },
      });
    };
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/mid-snapshot stop/);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.store.approvals.get('a1')!.state).toBe('PENDING');
  });

  it('mode changed during revalidation', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    const real = realRevalidator(s.w, s.store);
    const gw = makeGateway(s.w, s.store, s.broker, {
      revalidate: async (req) => {
        const v = await real(req);
        s.w.mode = 'SHADOW';
        return v;
      },
    });
    const r = await gw.execute('a1');
    expect(reasons(r)).toMatch(/mode changed from PAPER to SHADOW/);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('live authorization revoked during revalidation (LIVE)', async () => {
    const s = setup();
    s.w.mode = 'LIVE';
    s.w.liveEnv = true;
    s.w.accountLiveAuth = true;
    const d = s.add({ approvalId: 'a1', signalId: 's1' });
    s.store.addApproval({ ...d.approval, mode: 'LIVE' });
    const liveBroker = new Proxy(s.broker, {
      get: (t, p) => (p === 'kind' ? 'LIVE' : (Reflect.get(t, p) as unknown)),
    });
    const gw = makeGateway(s.w, s.store, liveBroker, {
      revalidate: () => {
        s.w.accountLiveAuth = false;
        return Promise.resolve({ ok: true, permittedQuantity: 99, entry: 20_000, checks: 1 });
      },
    });
    const r = await gw.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/live trading not authorized/);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('final check right before submit: a stop set while the intent is persisted prevents the send and releases the reservation', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    const mark = s.store.markDispatching.bind(s.store);
    s.store.markDispatching = async (id, at) => {
      await mark(id, at);
      s.w.ks.activate({
        scope: 'GLOBAL',
        target: null,
        reason: 'last-moment stop',
        actor: { type: 'HUMAN', id: 'u' },
      });
    };
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/last-moment stop.*nothing was transmitted/);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.store.orders.get('astra-a1')!.status).toBe('REJECTED');
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
    expect(s.store.events.map((e) => e.type)).toContain('NOT_TRANSMITTED');
  });

  it('rejects invalid approval and LIMIT timestamps instead of treating NaN as "not expired"', async () => {
    const s = setup();
    const d = s.add({ approvalId: 'a1', signalId: 's1' });
    s.store.addApproval({ ...d.approval, expiresAt: 'not-a-date' });
    expect(reasons(await s.gateway.execute('a1'))).toMatch(/not a valid timestamp/);
    const l = s.add({ approvalId: 'a2', signalId: 's2', limit: true });
    s.store.addApproval({
      ...l.approval,
      orderPlan: { ...l.approval.orderPlan, expiresAt: 'garbage' },
    });
    expect(reasons(await s.gateway.execute('a2'))).toMatch(
      /LIMIT expiry garbage is not a valid timestamp/,
    );
    expect(s.submit).not.toHaveBeenCalled();
  });
});

describe('a wait after the fresh validation cannot carry stale inputs to the broker (final gate)', () => {
  /** Delays one persistence step, and lets the world change while it waits. */
  const delayed = (
    s: ReturnType<typeof setup>,
    step: 'reserveAndConsume' | 'markDispatching',
    during: () => void,
  ) => {
    const real = s.store[step].bind(s.store) as (...a: unknown[]) => Promise<unknown>;
    (s.store as unknown as Record<string, unknown>)[step] = async (...a: unknown[]) => {
      const r = await real(...a);
      during(); // the database/audit write "took" a while
      return r;
    };
  };
  const refusedUntransmitted = async (
    s: ReturnType<typeof setup>,
    r: { outcome: string; reasons: readonly string[] },
  ) => {
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/nothing was transmitted/);
    expect(s.submit).not.toHaveBeenCalled();
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
    expect(s.store.orders.get('astra-a1')!.status).toBe('REJECTED');
  };

  it('quote that goes stale during the persistence wait', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.quoteAsOf = '2026-09-28T13:59:59.500Z'; // fresh now, 5s limit
    delayed(s, 'markDispatching', () => s.w.clock.advance(10_000)); // approval (30s) still valid
    const r = await s.gateway.execute('a1');
    await refusedUntransmitted(s, r);
    expect(reasons(r)).toMatch(/quote/i);
  });

  it('same, while waiting for the reservation commit itself', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.quoteAsOf = '2026-09-28T13:59:59.500Z';
    delayed(s, 'reserveAndConsume', () => s.w.clock.advance(10_000));
    await refusedUntransmitted(s, await s.gateway.execute('a1'));
  });

  it('calendar blackout that appears during the wait', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    delayed(s, 'markDispatching', () => {
      s.w.calendarEvents = [
        {
          id: 'nfp',
          title: 'Surprise NFP',
          impact: 'HIGH',
          scheduledAt: '2026-09-28T14:05:00.000Z',
          affectedInstruments: [],
        },
      ];
    });
    const r = await s.gateway.execute('a1');
    await refusedUntransmitted(s, r);
    expect(reasons(r)).toMatch(/Surprise NFP/);
  });

  it('account limit changed during the wait', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    delayed(s, 'markDispatching', () => {
      s.w.riskPolicy = {
        ...s.w.riskPolicy,
        perTrade: { ...s.w.riskPolicy.perTrade, riskPercentOfEquity: 0.05 },
      };
    });
    await refusedUntransmitted(s, await s.gateway.execute('a1'));
  });

  it('equity that drops during the wait reaches the gate through a NEW broker snapshot', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    delayed(s, 'markDispatching', () => (s.w.equity = 20_000));
    await refusedUntransmitted(s, await s.gateway.execute('a1'));
  });

  it('a clean run takes a fresh broker snapshot for the final gate as well (no stale snapshot reuse)', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    let snapshots = 0;
    s.w.onSnapshot = () => void snapshots++;
    expect((await s.gateway.execute('a1')).outcome).toBe('CONFIRMED');
    expect(snapshots).toBe(2);
    expect(s.submit).toHaveBeenCalledTimes(1);
  });
});

describe('entry revalidation on fresh data (real assembler + Decision Engine)', () => {
  it('passes unchanged conditions and sends exactly the approved quantity', async () => {
    const s = setup();
    const d = s.add({ approvalId: 'a1', signalId: 's1' });
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(s.submit.mock.calls[0]![0].quantity).toBe(d.approval.orderPlan.quantity);
  });

  it('never enlarges a trade even when the gate would now permit more', async () => {
    const s = setup();
    const d = s.add({ approvalId: 'a1', signalId: 's1' });
    const gw = makeGateway(s.w, s.store, s.broker, {
      revalidate: () =>
        Promise.resolve({ ok: true, permittedQuantity: 50, entry: 20_000, checks: 1 }),
    });
    await gw.execute('a1');
    expect(s.submit.mock.calls[0]![0].quantity).toBe(d.approval.orderPlan.quantity);
  });

  it('stale quote', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.quoteAgeMs = 60_000;
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/revalidation.*quote/i);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.store.approvals.get('a1')!.state).toBe('PENDING');
  });

  it('spread widened beyond the instrument limit', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.quotes.NQ = { bid: 19_998, ask: 20_000 };
    expect(reasons(await s.gateway.execute('a1'))).toMatch(/spread/);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('high-impact news/calendar blackout that appeared after approval', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.calendarEvents = [
      {
        id: 'cpi',
        title: 'Late CPI',
        impact: 'HIGH',
        scheduledAt: '2026-09-28T14:05:00.000Z',
        affectedInstruments: [],
      },
    ];
    const r = await s.gateway.execute('a1');
    expect(reasons(r)).toMatch(/Late CPI/);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('equity reduced after approval leaves too little permitted size', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.equity = 20_000; // fresh broker equity must reach tracking and every risk/firm rule
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/daily|drawdown|loss|breach|restricted|halt/i);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.store.approvals.get('a1')!.state).toBe('PENDING');
  });

  it('configuration changed since the decision', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.configHash = 'sha256:edited';
    expect(reasons(await s.gateway.execute('a1'))).toMatch(/configuration changed/);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('revalidation error and timeout both refuse', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    const boom = makeGateway(s.w, s.store, s.broker, {
      revalidate: () => Promise.reject(new Error('feed down')),
    });
    expect(reasons(await boom.execute('a1'))).toMatch(/feed down/);
    const hang = makeGateway(s.w, s.store, s.broker, {
      revalidate: () => new Promise(() => undefined),
      revalidationTimeoutMs: 20,
    });
    expect(reasons(await hang.execute('a1'))).toMatch(/timed out after 20ms/);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.store.approvals.get('a1')!.state).toBe('PENDING');
  });

  it('duplicate recheck exempts ONLY the current original decision', async () => {
    const approved = [
      { decisionId: 'dec_a1', signalId: 's1' },
      { decisionId: 'dec_unrelated', signalId: 's1' }, // a second approval of the same signal
    ];
    const priorApproved = (_acct: string, signalId: string, exclude: string) =>
      Promise.resolve(
        approved.find((d) => d.signalId === signalId && d.decisionId !== exclude)?.decisionId ??
          null,
      );
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    const gw = makeGateway(s.w, s.store, s.broker, { priorApproved });
    const blocked = await gw.execute('a1');
    expect(reasons(blocked)).toMatch(/already approved in decision dec_unrelated/);
    approved.pop();
    expect((await gw.execute('a1')).outcome).toBe('CONFIRMED');
  });
});

describe('account-wide reservations across symbols and gateway instances', () => {
  const tight = (w: World) => {
    // Open-risk cap of 0.6% of equity ($300): one NQ/ES entry (~$210) fits, two do not.
    w.riskPolicy = {
      ...w.riskPolicy,
      exposure: { ...w.riskPolicy.exposure, maxOpenRiskPercentOfEquity: 0.6 },
    };
  };

  it('two symbols whose combined risk exceeds the allowance: exactly one trades (one gateway)', async () => {
    const w = makeWorld();
    tight(w);
    const s = setup(w);
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    const [r1, r2] = await Promise.all([s.gateway.execute('a1'), s.gateway.execute('a2')]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['CONFIRMED', 'REJECTED']);
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect([r1, r2].find((r) => r.outcome === 'REJECTED')!.reasons.join()).toMatch(/risk|open/i);
  });

  it('separate gateways sharing one store cannot overspend even when their validations overlap', async () => {
    const w = makeWorld();
    tight(w);
    const s = setup(w);
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    const second = makeGateway(w, s.store, s.broker);
    // Barrier: both validations read the ledger at version 0 before either commits.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((r) => (open = r));
    w.onSnapshot = async () => {
      if (++arrived === 2) open();
      await both;
    };
    const [r1, r2] = await Promise.all([s.gateway.execute('a1'), second.execute('a2')]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['CONFIRMED', 'REJECTED']);
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(arrived).toBeGreaterThanOrEqual(3); // the loser re-validated against the winner's reservation
  });

  it('a symbol with active reserved exposure cannot be reserved again', async () => {
    const s = setup();
    const d = s.add({ approvalId: 'a1', signalId: 's1' });
    await s.gateway.execute('a1');
    s.store.addApproval({ ...d.approval, approvalId: 'a9', decisionId: 'dec_9' });
    const e = await s.store.accountExposure('acct-a');
    const r = await s.store.reserveAndConsume({
      order: {
        ...s.store.orders.get('astra-a1')!,
        clientOrderId: 'astra-a9',
        approvalId: 'a9',
        orderId: 'o9',
      },
      expectedVersion: e.version,
      at: '2026-09-28T14:00:05.000Z',
      intent: {},
    });
    expect(r).toMatchObject({ ok: false });
  });
});

describe('reservation lifecycle', () => {
  const NOWISO = '2026-09-28T14:00:05.000Z';

  async function withLimit() {
    const s = setup();
    s.paper.onQuote({
      symbol: 'NQ',
      bid: 19_999.75,
      ask: 20_000,
      asOf: s.w.clock.now().toISOString(),
    });
    s.add({ approvalId: 'l1', signalId: 'sl1', limit: true });
    const r = await s.gateway.execute('l1');
    return { s, r };
  }

  it("a resting LIMIT keeps its exposure reserved account-wide, blocks other symbols' headroom, and releases on authoritative cancel", async () => {
    const w = makeWorld();
    w.riskPolicy = {
      ...w.riskPolicy,
      exposure: { ...w.riskPolicy.exposure, maxOpenRiskPercentOfEquity: 0.6 },
    };
    const s = setup(w);
    s.paper.onQuote({
      symbol: 'NQ',
      bid: 19_999.75,
      ask: 20_000,
      asOf: w.clock.now().toISOString(),
    });
    s.add({ approvalId: 'l1', signalId: 'sl1', limit: true });
    const r = await s.gateway.execute('l1');
    expect(r.brokerState!.status).toBe('ACCEPTED');
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    expect((await s.gateway.execute('a2')).outcome).toBe('REJECTED');
    // Time passing alone releases nothing.
    w.clock.advance(20_000); // time passing alone releases nothing (approvals live 30s)
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
    const cancelled = await s.gateway.cancelWorking({
      accountId: 'acct-a',
      clientOrderId: 'astra-l1',
      reason: 't',
    });
    expect(cancelled.outcome).toBe('CANCELLED');
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
    s.add({ approvalId: 'a3', signalId: 's3', symbol: 'ES' });
    expect((await s.gateway.execute('a3')).outcome).toBe('CONFIRMED');
  });

  it('a fill keeps its exposure reserved: neither a visible position nor a flat snapshot releases it, only linked closure does', async () => {
    const { s } = await withLimit();
    const clientOrderId = 'astra-l1';
    await s.store.updateOrder(clientOrderId, {
      clientOrderId,
      brokerOrderId: 'b',
      status: 'FILLED',
      quantity: 1,
      filledQuantity: 1,
      averageFillPrice: 19_995,
      rejectReason: null,
      updatedAt: NOWISO,
    });
    const e = await s.store.accountExposure('acct-a');
    expect(e.reservations[0]).toMatchObject({ orderStatus: 'FILLED', reservedQuantity: 1 });
    // The gate-time reconcile (flat or not) finds no closure linked to this order: nothing released.
    expect(await s.store.reconcileReservations('acct-a', NOWISO)).toBe(0);
    // A closure for ANOTHER order is no evidence.
    s.store.recordClosure('astra-someone-else', 1);
    expect(await s.store.reconcileReservations('acct-a', NOWISO)).toBe(0);
    // Closure recorded for this very order: released exactly once.
    s.store.recordClosure(clientOrderId, 1);
    expect(await s.store.reconcileReservations('acct-a', NOWISO)).toBe(1);
    expect(await s.store.reconcileReservations('acct-a', NOWISO)).toBe(0);
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
  });

  it('a filled-but-open order is counted on top of its visible position (never netted by symbol)', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    expect((await s.gateway.execute('a1')).outcome).toBe('CONFIRMED'); // MARKET fill → FILLED, position open
    const e = await s.store.accountExposure('acct-a');
    expect(e.reservations).toHaveLength(1);
    const broker = await s.paper.getAccountSnapshot('PAPER-A', 'acct-a');
    const { snapshot, added } = snapshotWithReservations(broker, e.reservations);
    expect(broker.openPositions).toHaveLength(1);
    expect(added).toBe(1);
    expect(snapshot.workingOrders).toHaveLength(1);
  });

  it('a partially filled order that is then cancelled keeps the filled quantity reserved, not the remainder', async () => {
    const { s } = await withLimit();
    await s.store.updateOrder('astra-l1', {
      clientOrderId: 'astra-l1',
      brokerOrderId: 'b',
      status: 'PARTIALLY_FILLED',
      quantity: 3,
      filledQuantity: 1,
      averageFillPrice: 19_995,
      rejectReason: null,
      updatedAt: NOWISO,
    });
    expect((await s.store.accountExposure('acct-a')).reservations[0]).toMatchObject({
      reservedQuantity: 1,
      quantity: 1,
    });
  });

  it('UNKNOWN keeps the reservation and blocks every new entry until reconciled', async () => {
    const w = makeWorld();
    const s = setup(w);
    s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    // Lost response and no trace at the broker.
    s.submit.mockRejectedValueOnce(new Error('socket hang up'));
    vi.spyOn(s.paper, 'getOrder').mockResolvedValue(null);
    const unknown = vi.fn(() => Promise.resolve());
    const gw = makeGateway(w, s.store, s.broker, { onExecutionUnknown: unknown });
    const r1 = await gw.execute('a1');
    expect(r1.outcome).toBe('UNKNOWN');
    expect(unknown).toHaveBeenCalled();
    const e = await s.store.accountExposure('acct-a');
    expect(e.reservations[0]).toMatchObject({ orderStatus: 'UNKNOWN', reservedQuantity: 1 });
    const r2 = await gw.execute('a2');
    expect(reasons(r2)).toMatch(/unresolved \(UNKNOWN\)/);
    expect(s.submit).toHaveBeenCalledTimes(1); // never resent
  });

  it('a broker rejection with nothing filled releases; the reservation never outlives authoritative evidence', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.submit.mockResolvedValueOnce({
      clientOrderId: 'astra-a1',
      brokerOrderId: null,
      status: 'REJECTED',
      quantity: 1,
      filledQuantity: 0,
      averageFillPrice: null,
      rejectReason: 'margin',
      updatedAt: NOWISO,
    });
    vi.spyOn(s.paper, 'getOrder').mockResolvedValue({
      clientOrderId: 'astra-a1',
      brokerOrderId: null,
      status: 'REJECTED',
      quantity: 1,
      filledQuantity: 0,
      averageFillPrice: null,
      rejectReason: 'margin',
      updatedAt: NOWISO,
    });
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
  });
});

describe('closure must cover the cumulative fill (partial closure retains exposure)', () => {
  const at = '2026-09-28T14:00:05.000Z';
  it('qty 3: fill 1, close that 1, then the remaining 2 fill → the reservation stays until all 3 are closed', async () => {
    const s = setup();
    const d = s.add({ approvalId: 'a1', signalId: 's1' });
    const order = {
      orderId: 'o1',
      clientOrderId: 'astra-a1',
      approvalId: 'a1',
      decisionId: d.approval.decisionId,
      accountId: 'acct-a',
      strategyId: 's',
      signalId: 's1',
      adapterId: 'paper',
      mode: 'PAPER' as const,
      symbol: 'NQ',
      direction: 'LONG' as const,
      quantity: 3,
      entryType: 'MARKET' as const,
      plannedEntry: 20_000,
      stopLoss: 19_990,
      takeProfit: 20_030,
      status: 'PENDING_SUBMIT' as const,
      brokerOrderId: null,
      filledQuantity: 0,
      averageFillPrice: null,
      rejectReason: null,
      expiresAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const v = (await s.store.accountExposure('acct-a')).version;
    expect(await s.store.reserveAndConsume({ order, expectedVersion: v, at, intent: {} })).toEqual({
      ok: true,
    });
    const state = (status: 'PARTIALLY_FILLED' | 'FILLED', filled: number) => ({
      clientOrderId: 'astra-a1',
      brokerOrderId: 'b',
      status,
      quantity: 3,
      filledQuantity: filled,
      averageFillPrice: 20_000,
      rejectReason: null,
      updatedAt: at,
    });
    await s.store.updateOrder('astra-a1', state('PARTIALLY_FILLED', 1));
    s.store.recordClosure('astra-a1', 1); // the first unit was closed
    await s.store.updateOrder('astra-a1', state('FILLED', 3)); // then the remaining 2 filled
    expect(await s.store.reconcileReservations('acct-a', at)).toBe(0);
    expect((await s.store.accountExposure('acct-a')).reservations[0]).toMatchObject({
      reservedQuantity: 3,
      filledQuantity: 3,
    });
    s.store.recordClosure('astra-a1', 1); // 2 of 3 closed: still open exposure
    expect(await s.store.reconcileReservations('acct-a', at)).toBe(0);
    s.store.recordClosure('astra-a1', 1); // all 3 closed
    expect(await s.store.reconcileReservations('acct-a', at)).toBe(1);
  });

  it('confirmedClosures is cumulative-quantity based and never releases on a non-ended order', () => {
    const r = (status: 'ACCEPTED' | 'FILLED' | 'CANCELLED', reserved: number) =>
      ({ clientOrderId: 'x', orderStatus: status, reservedQuantity: reserved }) as never;
    expect(confirmedClosures([r('FILLED', 3)], new Map([['x', 2.999]]))).toHaveLength(0);
    expect(confirmedClosures([r('FILLED', 3)], new Map([['x', 3]]))).toHaveLength(1);
    expect(confirmedClosures([r('CANCELLED', 1)], new Map([['x', 1]]))).toHaveLength(1);
    expect(confirmedClosures([r('ACCEPTED', 1)], new Map([['x', 5]]))).toHaveLength(0);
    expect(confirmedClosures([r('FILLED', 3)], new Map())).toHaveLength(0);
  });
});

describe('contradictory broker evidence never frees risk (in-memory parity)', () => {
  it('zero/decreasing/malformed fills and out-of-order states retain the reservation', async () => {
    const store = new InMemoryExecutionStore();
    let n = 0;
    const at = '2026-09-28T14:00:00.000Z';
    await runEvidenceScenarios({
      a: store,
      b: store,
      async newOrder(symbol, quantity) {
        const id = ++n;
        store.addApproval({
          approvalId: `apr_e${id}`,
          decisionId: `dec_e${id}`,
          accountId: 'acct-a',
          strategyId: 's',
          signalId: `sg${id}`,
          mode: 'PAPER',
          expiresAt: '2026-09-28T14:10:00.000Z',
          state: 'PENDING',
          orderPlan: {
            symbol,
            direction: 'LONG',
            entryType: 'MARKET',
            entry: 20_000,
            stop: 19_990,
            target: 20_030,
            quantity,
          },
        });
        const order = {
          orderId: `o_e${id}`,
          clientOrderId: `astra-apr_e${id}`,
          approvalId: `apr_e${id}`,
          decisionId: `dec_e${id}`,
          accountId: 'acct-a',
          strategyId: 's',
          signalId: `sg${id}`,
          adapterId: 'paper',
          mode: 'PAPER' as const,
          symbol,
          direction: 'LONG' as const,
          quantity,
          entryType: 'MARKET' as const,
          plannedEntry: 20_000,
          stopLoss: 19_990,
          takeProfit: 20_030,
          status: 'PENDING_SUBMIT' as const,
          brokerOrderId: null,
          filledQuantity: 0,
          averageFillPrice: null,
          rejectReason: null,
          expiresAt: null,
          createdAt: at,
          updatedAt: at,
        };
        const v = (await store.accountExposure('acct-a')).version;
        expect(
          await store.reserveAndConsume({ order, expectedVersion: v, at, intent: {} }),
        ).toEqual({ ok: true });
        await store.markDispatching(order.clientOrderId, at);
        return order.clientOrderId;
      },
      recordClosure: (id, q) => Promise.resolve(store.recordClosure(id, q)),
      order: (id) => Promise.resolve(store.orders.get(id) ?? null),
      events: (id) =>
        Promise.resolve(store.events.filter((e) => e.clientOrderId === id).map((e) => e.type)),
    });
  });
});

describe('a synchronous submit failure is handled as uncertainty, not as "nothing transmitted"', () => {
  it('adapter records the order, then throws synchronously: polled and confirmed, never resent', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    // The class method, not the spy that setup() installed on the instance.
    const real = PaperBrokerAdapter.prototype.submitOrder.bind(s.paper);
    s.submit.mockImplementation((req) => {
      void real(req); // the broker received and recorded it ...
      throw new Error('socket reset after write'); // ... but the call threw synchronously
    });
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(reasons(r)).not.toMatch(/nothing was transmitted/);
    expect(r.brokerState).toMatchObject({ status: 'FILLED' });
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.store.events.map((e) => e.type)).toContain('SUBMIT_ERROR');
    expect(s.store.orders.get('astra-a1')!.status).toBe('FILLED');
  });

  it('adapter throws synchronously with no trace at the broker: UNKNOWN, execution halted, reservation kept, never resent', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.submit.mockImplementation(() => {
      throw new Error('ECONNRESET');
    });
    vi.spyOn(s.paper, 'getOrder').mockResolvedValue(null);
    const unknown = vi.fn(() => Promise.resolve());
    const gw = makeGateway(s.w, s.store, s.broker, { onExecutionUnknown: unknown });
    const r = await gw.execute('a1');
    expect(r.outcome).toBe('UNKNOWN');
    expect(reasons(r)).toMatch(/submission error \(ECONNRESET\)/);
    expect(reasons(r)).not.toMatch(/nothing was transmitted/);
    expect(unknown).toHaveBeenCalledTimes(1);
    expect(s.store.orders.get('astra-a1')!.status).toBe('UNKNOWN');
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
    expect((await gw.execute('a1')).outcome).toBe('REJECTED'); // duplicate execution
    expect(s.submit).toHaveBeenCalledTimes(1);
  });
});

describe('persistence failures and restart', () => {
  it('reservation failure → no broker submit, approval stays PENDING, refusal audited', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.store.reserveAndConsume = () => Promise.reject(new Error('connection terminated'));
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/nothing was transmitted/);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.store.approvals.get('a1')!.state).toBe('PENDING');
  });

  it('submit-intent persistence failure → nothing sent; reservation kept for reconciliation if it cannot be released either', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.store.markDispatching = () => Promise.reject(new Error('db down'));
    s.store.releaseUntransmitted = () => Promise.reject(new Error('db down'));
    const r = await s.gateway.execute('a1');
    expect(reasons(r)).toMatch(
      /submit intent could not be persisted.*reservation kept until reconciliation.*nothing was transmitted/,
    );
    expect(s.submit).not.toHaveBeenCalled();
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
  });

  it('database outage after the broker accepted: UNKNOWN, execution halted, reservation retained, never resent', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.store.updateOrder = () => Promise.reject(new Error('db down'));
    const unknown = vi.fn(() => Promise.resolve());
    const gw = makeGateway(s.w, s.store, s.broker, { onExecutionUnknown: unknown });
    const r = await gw.execute('a1');
    expect(r.outcome).toBe('UNKNOWN');
    expect(reasons(r)).toMatch(/could not be recorded/);
    expect(unknown).toHaveBeenCalledTimes(1);
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
    expect((await gw.execute('a1')).outcome).toBe('REJECTED'); // duplicate execution
    expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it('restart: an order never marked dispatched is provably untransmitted and is released; a dispatched one is not', async () => {
    const s = setup();
    const d1 = s.add({ approvalId: 'a1', signalId: 's1', symbol: 'NQ' });
    const d2 = s.add({ approvalId: 'a2', signalId: 's2', symbol: 'ES' });
    const mk = async (d: typeof d1, id: string) => {
      const order = {
        orderId: `o_${id}`,
        clientOrderId: `astra-${id}`,
        approvalId: id,
        decisionId: d.approval.decisionId,
        accountId: 'acct-a',
        strategyId: 's',
        signalId: d.approval.signalId,
        adapterId: 'paper',
        mode: 'PAPER' as const,
        symbol: d.approval.orderPlan.symbol,
        direction: 'LONG' as const,
        quantity: 1,
        entryType: 'MARKET' as const,
        plannedEntry: 20_000,
        stopLoss: 19_990,
        takeProfit: 20_030,
        status: 'PENDING_SUBMIT' as const,
        brokerOrderId: null,
        filledQuantity: 0,
        averageFillPrice: null,
        rejectReason: null,
        expiresAt: null,
        createdAt: '2026-09-28T14:00:01.000Z',
        updatedAt: '2026-09-28T14:00:01.000Z',
      };
      const v = (await s.store.accountExposure('acct-a')).version;
      expect(
        await s.store.reserveAndConsume({
          order,
          expectedVersion: v,
          at: order.createdAt,
          intent: {},
        }),
      ).toEqual({ ok: true });
    };
    await mk(d1, 'a1');
    await mk(d2, 'a2');
    await s.store.markDispatching('astra-a2', '2026-09-28T14:00:02.000Z'); // crashed after this
    const at = '2026-09-28T14:00:09.000Z';
    expect(
      await s.store.releaseUntransmitted('astra-a1', 'restart: never dispatched', at, {
        onlyIfUndispatched: true,
      }),
    ).toBe(true);
    expect(
      await s.store.releaseUntransmitted('astra-a2', 'restart', at, { onlyIfUndispatched: true }),
    ).toBe(false);
    const left = (await s.store.accountExposure('acct-a')).reservations;
    expect(left.map((r) => r.clientOrderId)).toEqual(['astra-a2']);
    // A released order can no longer be dispatched by a stalled process.
    await expect(s.store.markDispatching('astra-a1', at)).rejects.toThrow(/no active reservation/);
    void ES;
  });
});

describe('SHADOW semantics are preserved', () => {
  it('records without transmitting, without a reservation and without revalidation', async () => {
    const s = setup();
    s.w.mode = 'SHADOW';
    const d = decide(s.w, { approvalId: 'a1', signalId: 's1' });
    s.store.addApproval({ ...d.approval, mode: 'SHADOW' });
    const revalidate = vi.fn();
    const gw = makeGateway(s.w, s.store, s.broker, { revalidate });
    const r = await gw.execute('a1');
    expect(r.outcome).toBe('SHADOW_RECORDED');
    expect(revalidate).not.toHaveBeenCalled();
    expect(s.submit).not.toHaveBeenCalled();
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
  });
});
