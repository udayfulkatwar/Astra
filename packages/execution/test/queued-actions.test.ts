/**
 * S002 — queued risk-reducing actions. A cancel / protective close that waits behind another
 * action for the account lock must re-read mode, kill switches, the account's CURRENT broker
 * binding, the adapter kind and the LIVE authorization INSIDE the lock, after its awaited reads,
 * and immediately before the broker call. Fake broker only; zero broker calls after the change.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionGateway, clientOrderIdFor } from '../src/gateway';
import { InMemoryExecutionStore } from '../src/memory-store';
import type { OrderRecord } from '../src/types';
import {
  accountDef,
  decide,
  instrument,
  makeBroker,
  makeWorld,
  realRevalidator,
} from './gate-world';

type Cfg = {
  mode: 'PAPER' | 'SHADOW' | 'BACKTEST' | 'LIVE' | 'HALTED';
  adapterId: string;
  accountRef: string;
  kind: 'PAPER' | 'LIVE';
  ksLoaded: boolean;
  env: boolean;
  acct: boolean;
};

function rig() {
  const w = makeWorld();
  const store = new InMemoryExecutionStore();
  const paper = makeBroker(w);
  paper.openAccount('PAPER-B', 50_000);
  const cancel = vi.spyOn(paper, 'cancelOrder');
  const close = vi.spyOn(paper, 'closePosition');
  const cfg: Cfg = {
    mode: 'PAPER',
    adapterId: 'paper',
    accountRef: 'PAPER-A',
    kind: 'PAPER',
    ksLoaded: true,
    env: false,
    acct: false,
  };
  const inst = instrument(w, paper);
  const broker = new Proxy(inst, {
    get: (t, p, r) => (p === 'kind' ? cfg.kind : (Reflect.get(t, p, r) as unknown)),
  });
  const unknownCalls: string[] = [];
  const hooks = {
    onUnknown: (_a: string, _c: string, r: string): Promise<void> => (
      unknownCalls.push(r),
      Promise.resolve()
    ),
  };
  const gateway = new ExecutionGateway({
    store,
    adapter: (id) => (id === cfg.adapterId ? broker : undefined),
    account: (id) =>
      id === 'acct-a'
        ? ({
            ...accountDef(w),
            broker: { adapterId: cfg.adapterId, accountRef: cfg.accountRef },
            liveTradingAuthorized: cfg.acct,
          } as never)
        : undefined,
    mode: () => cfg.mode,
    killSwitches: (ctx) =>
      cfg.ksLoaded
        ? w.ks.evaluate(ctx)
        : { blocked: true, loaded: false, blocking: [], reasons: ['kill-switch state not loaded'] },
    liveTradingEnvironmentAuthorized: () => cfg.env,
    onExecutionUnknown: (a, c, r) => hooks.onUnknown(a, c, r),
    revalidate: realRevalidator(w, store),
    revalidationTimeoutMs: 1_000,
    clock: w.clock,
    confirmation: { timeoutMs: 2_000, pollIntervalMs: 250 },
    sleep: (ms) => {
      w.clock.advance(ms);
      return Promise.resolve();
    },
  });
  const add = (o: Parameters<typeof decide>[1]) => store.addApproval(decide(w, o).approval);
  /** Holds the account lock inside an entry's broker snapshot until `release()`. */
  const holdLock = async () => {
    add({ approvalId: 'hold', signalId: 'sig-hold', symbol: 'ES' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    w.onSnapshot = async () => {
      w.onSnapshot = null;
      entered();
      await gate;
    };
    const entry = gateway.execute('hold');
    await inside;
    return { release, entry };
  };
  const withPosition = async () => {
    add({ approvalId: 'a0', signalId: 'sig-0' });
    expect((await gateway.execute('a0')).outcome).toBe('CONFIRMED');
    const snap = await inst.getAccountSnapshot('PAPER-A', 'acct-a');
    return snap.openPositions[0]!.positionId;
  };
  const withResting = async () => {
    paper.onQuote({ symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf: w.clock.now().toISOString() });
    add({ approvalId: 'l1', signalId: 'sig-l', limit: true });
    expect((await gateway.execute('l1')).brokerState?.status).toBe('ACCEPTED');
    return clientOrderIdFor('l1');
  };
  const closeReq = (positionId: string, id = 'protect:test') => ({
    accountId: 'acct-a',
    positionId,
    clientCloseId: id,
    reason: 'test',
  });
  const cancelReq = (clientOrderId: string) => ({
    accountId: 'acct-a',
    clientOrderId,
    reason: 'test',
  });
  return {
    w,
    store,
    paper,
    cancel,
    close,
    cfg,
    gateway,
    holdLock,
    withPosition,
    withResting,
    closeReq,
    cancelReq,
    hooks,
    unknownCalls,
    inst,
  };
}

/** Changes applied while the action waits in the queue. `pre` runs before the action is queued. */
const CHANGES: {
  name: string;
  pre?: (s: ReturnType<typeof rig>) => void;
  change: (s: ReturnType<typeof rig>) => void;
  outcome: 'SKIPPED' | 'REJECTED';
  why: RegExp;
}[] = [
  {
    name: 'mode SHADOW',
    change: (s) => (s.cfg.mode = 'SHADOW'),
    outcome: 'SKIPPED',
    why: /never transmits/,
  },
  {
    name: 'mode BACKTEST',
    change: (s) => (s.cfg.mode = 'BACKTEST'),
    outcome: 'SKIPPED',
    why: /never transmits/,
  },
  {
    name: 'EXECUTION kill switch activated',
    change: (s) =>
      s.w.ks.activate({
        scope: 'EXECUTION',
        target: 'acct-a',
        reason: 'exec unsafe',
        actor: { type: 'HUMAN', id: 'u' },
      }),
    outcome: 'SKIPPED',
    why: /EXECUTION kill switch active/,
  },
  {
    name: 'controls unloaded',
    change: (s) => (s.cfg.ksLoaded = false),
    outcome: 'SKIPPED',
    why: /not loaded/,
  },
  {
    name: 'broker account binding changed',
    change: (s) => (s.cfg.accountRef = 'PAPER-B'),
    outcome: 'REJECTED',
    why: /binding changed/,
  },
  {
    name: 'broker adapter binding changed',
    change: (s) => (s.cfg.adapterId = 'other'),
    outcome: 'REJECTED',
    why: /binding changed/,
  },
  {
    name: 'LIVE authorization revoked',
    pre: (s) => Object.assign(s.cfg, { mode: 'LIVE', kind: 'LIVE', env: true, acct: true }),
    change: (s) => (s.cfg.acct = false),
    outcome: 'REJECTED',
    why: /live trading not authorized/,
  },
  {
    name: 'LIVE environment authorization revoked',
    pre: (s) => Object.assign(s.cfg, { mode: 'LIVE', kind: 'LIVE', env: true, acct: true }),
    change: (s) => (s.cfg.env = false),
    outcome: 'REJECTED',
    why: /live trading not authorized/,
  },
  {
    name: 'adapter kind no longer matches the mode',
    change: (s) => (s.cfg.kind = 'LIVE'),
    outcome: 'REJECTED',
    why: /requires PAPER/,
  },
];

describe('queued protective close re-reads permission inside the lock', () => {
  for (const c of CHANGES) {
    it(`${c.name} while queued → no broker call`, async () => {
      const s = rig();
      const positionId = await s.withPosition();
      const held = await s.holdLock();
      c.pre?.(s); // e.g. LIVE configuration, in place when the action is queued
      const queued = s.gateway.protectiveClose(s.closeReq(positionId));
      await Promise.resolve();
      c.change(s);
      held.release();
      const r = await queued;
      await held.entry;
      expect(r.outcome).toBe(c.outcome);
      expect(r.reason).toMatch(c.why);
      expect(s.close).not.toHaveBeenCalled();
    });
  }

  it('entry-only kill switches and HALTED mode never prevent the permitted reduction', async () => {
    for (const change of [
      (s: ReturnType<typeof rig>) =>
        s.w.ks.activate({
          scope: 'GLOBAL',
          target: null,
          reason: 'g',
          actor: { type: 'HUMAN', id: 'u' },
        }),
      (s: ReturnType<typeof rig>) =>
        s.w.ks.activate({
          scope: 'ACCOUNT',
          target: 'acct-a',
          reason: 'a',
          actor: { type: 'HUMAN', id: 'u' },
        }),
      (s: ReturnType<typeof rig>) =>
        s.w.ks.activate({
          scope: 'INSTRUMENT',
          target: 'NQ',
          reason: 'i',
          actor: { type: 'HUMAN', id: 'u' },
        }),
      (s: ReturnType<typeof rig>) => (s.cfg.mode = 'HALTED'),
    ]) {
      const s = rig();
      const positionId = await s.withPosition();
      const held = await s.holdLock();
      const queued = s.gateway.protectiveClose(s.closeReq(positionId));
      await Promise.resolve();
      change(s);
      held.release();
      expect((await queued).outcome).toBe('CLOSED');
      await held.entry;
      expect(s.close).toHaveBeenCalledTimes(1);
    }
  });

  it('a queued duplicate is idempotent and never closes twice', async () => {
    const s = rig();
    const positionId = await s.withPosition();
    const held = await s.holdLock();
    const a = s.gateway.protectiveClose(s.closeReq(positionId));
    const b = s.gateway.protectiveClose(s.closeReq(positionId));
    held.release();
    const [ra, rb] = await Promise.all([a, b]);
    await held.entry;
    expect(ra.outcome).toBe('CLOSED');
    expect(rb.outcome).toBe('CLOSED');
    expect(rb.realizedPnl).toBe(ra.realizedPnl); // the broker's idempotent answer, not a second close
  });

  it('an unknown broker outcome halts execution and the result says so', async () => {
    const s = rig();
    const positionId = await s.withPosition();
    s.close.mockRejectedValueOnce(new Error('transport reset'));
    const r = await s.gateway.protectiveClose(s.closeReq(positionId));
    expect(r.outcome).toBe('UNKNOWN');
    expect(s.unknownCalls.join()).toMatch(/outcome unknown: transport reset/);
  });

  it('a failed halt write is reported, never swallowed into a clean-looking result', async () => {
    const s = rig();
    const positionId = await s.withPosition();
    s.close.mockRejectedValueOnce(new Error('transport reset'));
    s.hooks.onUnknown = () => Promise.reject(new Error('kill switch write down'));
    const r = await s.gateway.protectiveClose(s.closeReq(positionId));
    expect(r.outcome).toBe('UNKNOWN');
    expect(r.reason).toMatch(/execution halt NOT persisted \(kill switch write down\)/);
  });
});

describe('queued cancel of a resting entry re-reads permission inside the lock', () => {
  for (const c of CHANGES) {
    it(`${c.name} while queued → no broker call`, async () => {
      const s = rig();
      const id = await s.withResting();
      const held = await s.holdLock();
      c.pre?.(s); // e.g. LIVE configuration, in place when the action is queued
      const queued = s.gateway.cancelWorking(s.cancelReq(id));
      await Promise.resolve();
      c.change(s);
      held.release();
      const r = await queued;
      await held.entry;
      expect(r.outcome).toBe(c.outcome);
      expect(r.reason).toMatch(c.why);
      expect(s.cancel).not.toHaveBeenCalled();
    });
  }

  it('a change during the final ASYNCHRONOUS read (the target lookup) still prevents the call', async () => {
    const s = rig();
    const id = await s.withResting();
    const real = s.store.orderByClientId.bind(s.store);
    let reached!: () => void;
    const inside = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.store.orderByClientId = async (cid: string) => {
      reached();
      await gate;
      return real(cid);
    };
    const queued = s.gateway.cancelWorking(s.cancelReq(id));
    await inside;
    s.w.ks.activate({
      scope: 'EXECUTION',
      target: 'acct-a',
      reason: 'late',
      actor: { type: 'HUMAN', id: 'u' },
    });
    release();
    const r = await queued;
    expect(r.outcome).toBe('SKIPPED');
    expect(s.cancel).not.toHaveBeenCalled();
  });

  it('entry-only kill switches never prevent the permitted cancel', async () => {
    const s = rig();
    const id = await s.withResting();
    const held = await s.holdLock();
    const queued = s.gateway.cancelWorking(s.cancelReq(id));
    await Promise.resolve();
    s.w.ks.activate({
      scope: 'GLOBAL',
      target: null,
      reason: 'g',
      actor: { type: 'HUMAN', id: 'u' },
    });
    held.release();
    expect((await queued).outcome).toBe('CANCELLED');
    await held.entry;
  });

  it('never redirects a request onto another account or adapter', async () => {
    const s = rig();
    const id = await s.withResting();
    const other: OrderRecord = {
      ...(await s.store.orderByClientId(id))!,
      accountId: 'acct-b',
      clientOrderId: 'astra-foreign',
      orderId: 'ord_foreign',
    };
    s.store.orders.set(other.clientOrderId, other);
    const foreign = await s.gateway.cancelWorking(s.cancelReq('astra-foreign'));
    expect(foreign.outcome).toBe('REJECTED');
    expect(foreign.reason).toMatch(/does not belong to account/);
    s.store.orders.set(id, { ...s.store.orders.get(id)!, adapterId: 'some-other-adapter' });
    const wrongAdapter = await s.gateway.cancelWorking(s.cancelReq(id));
    expect(wrongAdapter.outcome).toBe('REJECTED');
    expect(wrongAdapter.reason).toMatch(/was placed through adapter/);
    expect(s.cancel).not.toHaveBeenCalled();
  });

  it('a queued duplicate cancel is idempotent: one cancel, then ALREADY_FINAL', async () => {
    const s = rig();
    const id = await s.withResting();
    const held = await s.holdLock();
    const a = s.gateway.cancelWorking(s.cancelReq(id));
    const b = s.gateway.cancelWorking(s.cancelReq(id));
    held.release();
    const [ra, rb] = await Promise.all([a, b]);
    await held.entry;
    expect(ra.outcome).toBe('CANCELLED');
    expect(['ALREADY_FINAL', 'CANCELLED']).toContain(rb.outcome);
  });

  it('failed evidence writes after the broker answered: UNKNOWN with the exact persistence outcome, reservation kept, execution halted', async () => {
    const s = rig();
    const id = await s.withResting();
    s.store.updateOrder = () => Promise.reject(new Error('orders write down'));
    const r = await s.gateway.cancelWorking(s.cancelReq(id));
    expect(r.outcome).toBe('UNKNOWN');
    expect(r.reason).toMatch(/evidence was NOT recorded \(orders write down\)/);
    expect(s.unknownCalls.join()).toMatch(/NOT recorded/);
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
  });

  it('failed evidence AND halt writes are both reported', async () => {
    const s = rig();
    const id = await s.withResting();
    s.store.updateOrder = () => Promise.reject(new Error('orders write down'));
    s.hooks.onUnknown = () => Promise.reject(new Error('kill switch write down'));
    const r = await s.gateway.cancelWorking(s.cancelReq(id));
    expect(r.outcome).toBe('UNKNOWN');
    expect(r.reason).toMatch(/NOT recorded/);
    expect(r.reason).toMatch(/execution halt NOT persisted \(kill switch write down\)/);
  });

  it('an unknown broker outcome halts execution without releasing anything', async () => {
    const s = rig();
    const id = await s.withResting();
    s.cancel.mockRejectedValueOnce(new Error('transport reset'));
    const r = await s.gateway.cancelWorking(s.cancelReq(id));
    expect(r.outcome).toBe('UNKNOWN');
    expect(s.unknownCalls.join()).toMatch(/outcome unknown: transport reset/);
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
  });
});
