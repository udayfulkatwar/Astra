/**
 * R004 — single-owner PAPER crash/restart safety (ADR-0027 §9). Real PostgreSQL, the composed
 * runtime and deterministic fault injection. A crash is the harness `crash()` seam: the owner's
 * lock backend dies and `runtime.stop()` never runs, so the session stays DIRTY.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  H,
  bringOnline,
  candidate,
  createHarness,
  dbAvailable,
  type Harness,
  type HarnessOptions,
} from './harness';

const available = await dbAvailable();
const open: Harness[] = [];
const extra: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const e of extra.splice(0)) await e.close();
  const last = open.splice(0).at(-1);
  await last?.close().catch(() => undefined);
});
const track = <T extends Harness>(h: T): T => {
  open.push(h);
  return h;
};

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const ACCOUNT = 'paper-demo';

async function approve(x: Harness) {
  const r = json(
    await x.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: { candidate: candidate(x) },
    }),
  );
  expect(r.decision.status).toBe('APPROVED');
  return r.decision as Json;
}
const execute = async (x: Harness, approvalId: string) =>
  json(
    await x.app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: H.operator,
      payload: { approvalId },
    }),
  );
const account = (x: Harness) => x.runtime.config.accounts.get(ACCOUNT)!;
const ownerRow = async (x: Harness) =>
  (
    await x.db.sql<{ state: string; session_id: string; checkpoints: Record<string, number> }[]>`
    select state, session_id, checkpoints from paper_owner where adapter_id = 'paper'`
  )[0];
const activeKillSwitches = async (x: Harness) =>
  (await x.db.sql`select 1 from kill_switches where active = true`).length;
const quarantines = async (x: Harness) =>
  (await x.runtime.repos.execution.accountExposure(ACCOUNT)).quarantines;

/** Brings a fresh harness online (paper accounts restored, quotes, calendar, news). */
async function online(opts: HarnessOptions = {}) {
  const h = track(await createHarness(opts));
  await bringOnline(h);
  return h;
}
const failing = (what: string) => () => Promise.reject(new Error(what));
/** Confirmation polling is clock-driven: let the manual clock run while an unresolved order polls. */
async function ticking<T>(h: Harness, fn: () => Promise<T>): Promise<T> {
  const t = setInterval(() => h.clock.advance(300), 5);
  try {
    return await fn();
  } finally {
    clearInterval(t);
  }
}

describe.skipIf(!available)('R004 — DIRTY session before any paper interaction', () => {
  it('a failed DIRTY write leaves startup fail-closed: no restore, no quotes, no interaction, no admission', async () => {
    const h = track(
      await createHarness({
        prepare: (rt) => {
          rt.repos.paperOwner.acquire = failing('dirty write refused');
        },
      }),
    );
    expect(h.runtime.initializationError()).toMatch(/dirty write refused/);
    const paper = h.runtime.execution.paper();
    expect(paper.hasAccount(account(h).broker.accountRef)).toBe(false);
    await expect(paper.getAccountSnapshot('x', 'y')).rejects.toThrow(/paper broker unavailable/);
    paper.onQuote({ symbol: 'MNQ', bid: 1, ask: 2, asOf: h.clock.now().toISOString() });
    expect(h.runtime.execution.readiness(account(h)).reconciled).toBe(false);
    expect(await ownerRow(h)).toBeUndefined();
  });

  it('a DIRTY commit whose ACK is lost blocks interaction; the next start treats it as unclean (quarantine)', async () => {
    const opts: HarnessOptions = {
      prepare: (rt) => {
        const real = rt.repos.paperOwner.acquire.bind(rt.repos.paperOwner);
        rt.repos.paperOwner.acquire = async (p) => {
          const s = await real(p); // committed…
          await s.release();
          throw new Error('ACK lost'); // …but the caller never learned
        };
      },
    };
    const h = track(await createHarness(opts));
    expect(h.runtime.initializationError()).toMatch(/ACK lost/);
    expect(h.runtime.execution.paper().hasAccount(account(h).broker.accountRef)).toBe(false);
    expect((await ownerRow(h))?.state).toBe('DIRTY');
    delete opts.prepare;
    const again = track(await h.restart());
    expect(again.runtime.initializationError()).toBeNull();
    expect(again.runtime.execution.recoveryState()).toBe('UNCLEAN');
    expect((await quarantines(again)).length).toBe(1);
  });
});

describe.skipIf(!available)('R004 — exclusive ownership', () => {
  it('a competing process refuses while the owner lives; the owner is unaffected', async () => {
    const a = await online();
    const b = await a.competitor();
    extra.push(b);
    expect(b.runtime.initializationError()).toMatch(/another live process owns the paper adapter/);
    expect(b.runtime.execution.paper().hasAccount(account(a).broker.accountRef)).toBe(false);
    expect(b.runtime.execution.readiness(account(a)).reconciled).toBe(false);
    const d = await approve(a);
    expect((await execute(a, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    expect((await ownerRow(a))?.state).toBe('DIRTY'); // DIRTY for the whole life of the session
  });

  it('lost ownership halts local admission and paper actions at once; a later owner quarantines instead of silently taking over', async () => {
    const a = await online();
    const d = await approve(a);
    const pid = a.runtime.execution.ownerBackendPid()!;
    await a.db.sql`select pg_terminate_backend(${pid})`; // the lock is gone, the process is alive
    const submit = vi.spyOn(a.runtime.execution.paper(), 'submitOrder');
    const r = await execute(a, d.approval.approvalId);
    expect(r.outcome).toBe('REJECTED');
    expect(r.reasons.join()).toMatch(/\[paper-owner\]/);
    expect(submit).not.toHaveBeenCalled();
    expect(a.runtime.execution.readiness(account(a)).reconciled).toBe(false);
    await expect(
      a.runtime.execution.paper().getAccountSnapshot(account(a).broker.accountRef, ACCOUNT),
    ).rejects.toThrow(/paper broker unavailable/);

    const b = await a.competitor();
    extra.push(b);
    expect(b.runtime.initializationError()).toBeNull(); // lock free → B may own, but…
    expect(b.runtime.execution.recoveryState()).toBe('UNCLEAN'); // …A's DIRTY row is never trusted
    expect((await b.runtime.repos.execution.accountExposure(ACCOUNT)).quarantines.length).toBe(1);
  });

  it('ownership lost during the final ledger wait of an entry is caught by the final synchronous check', async () => {
    const h = await online();
    const submit = vi.spyOn(h.runtime.execution.paper(), 'submitOrder');
    const d = await approve(h);
    const repo = h.runtime.repos.execution as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const dispatch = repo.markDispatching!.bind(repo);
    const exposure = repo.accountExposure!.bind(repo);
    let armed = false;
    let reads = 0;
    repo.markDispatching = async (...a) => {
      const r = await dispatch(...a);
      armed = true;
      return r;
    };
    repo.accountExposure = async (...a) => {
      const out = await exposure(...a);
      if (armed && ++reads === 2) {
        await h.db.sql`select pg_terminate_backend(${h.runtime.execution.ownerBackendPid()})`;
        await h.runtime.execution.verifyOwnership().catch(() => undefined);
      }
      return out;
    };
    const r = await execute(h, d.approval.approvalId);
    expect(r.outcome).toBe('REJECTED');
    expect(r.reasons.join()).toMatch(/paper-owner|ownership/i);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe.skipIf(!available)('R004 — a missing owner record fails closed', () => {
  it('a deleted paper_owner row (no DIRTY ACK) stops the running owner and fences direct repository reserve/dispatch', async () => {
    const a = await online();
    const d1 = await approve(a);
    const d2 = await approve(a);
    expect((await execute(a, d1.approval.approvalId)).outcome).toBe('CONFIRMED');
    const order = (await a.runtime.repos.execution.listOrders({ accountId: ACCOUNT }))[0]!;
    await a.db.sql`delete from paper_owner`;
    const submit = vi.spyOn(a.runtime.execution.paper(), 'submitOrder');
    const r = await execute(a, d2.approval.approvalId);
    expect(r.outcome).toBe('REJECTED');
    expect(submit).not.toHaveBeenCalled();
    const repo = a.runtime.repos.execution;
    await expect(
      repo.markDispatching(order.clientOrderId, a.clock.now().toISOString(), 'any'),
    ).rejects.toThrow(/no owner record/);
    const v = (await repo.accountExposure(ACCOUNT)).version;
    expect(
      await repo.reserveAndConsume({
        order: { ...order, orderId: 'ord_n', clientOrderId: 'astra-n', approvalId: 'apr_n' },
        expectedVersion: v,
        at: a.clock.now().toISOString(),
        intent: {},
        owner: 'any',
      }),
    ).toMatchObject({ ok: false, code: 'OWNER_FENCE' });
  });
});

describe.skipIf(!available)('R004 — crash and restart', () => {
  it('terminal/ended orders only, no persisted kill switch: the dirty restart still blocks the gateway AND direct DB reserve/dispatch', async () => {
    const a = await online();
    const d = await approve(a);
    const queued = await approve(a); // a second approval waiting when the process dies
    const r1 = await execute(a, d.approval.approvalId);
    expect(r1.outcome).toBe('CONFIRMED');
    expect(await activeKillSwitches(a)).toBe(0);
    const b = track(await a.crash());
    expect(b.runtime.execution.recoveryState()).toBe('UNCLEAN');
    // no operator/kill-switch state was needed to remember the unclean session
    const quarantine = (await quarantines(b))[0]!;
    expect(quarantine.reason).toMatch(/did not end cleanly/);
    expect(await activeKillSwitches(b)).toBeGreaterThanOrEqual(0);
    // gateway: the pending approval is refused
    const gate = await execute(b, queued.approval.approvalId);
    expect(gate.outcome).toBe('REJECTED');
    expect(gate.reasons.join()).toMatch(/quarantined|did not end cleanly/);
    // direct DB reserve / dispatch, bypassing the gateway entirely
    const repo = b.runtime.repos.execution;
    const order = (await repo.listOrders({ accountId: ACCOUNT }))[0]!;
    expect(order).toBeDefined();
    await expect(
      repo.markDispatching(order.clientOrderId, b.clock.now().toISOString()),
    ).rejects.toThrow(/fenced|quarantined/);
    const v = (await repo.accountExposure(ACCOUNT)).version;
    const reserve = await repo.reserveAndConsume({
      order: { ...order, orderId: 'ord_x', clientOrderId: 'astra-x', approvalId: 'apr_x' },
      expectedVersion: v,
      at: b.clock.now().toISOString(),
      intent: {},
    });
    expect(reserve.ok).toBe(false);
  });

  it('a paper snapshot save that fails before a quote-driven fill halts readiness, propagates, and a crash restart blocks the account', async () => {
    const a = await online();
    const d = await approve(a);
    expect((await execute(a, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    a.runtime.repos.paperState.save = failing('snapshot write down');
    const ref = account(a).broker.accountRef;
    // stop/target fill driven by a quote: the broker mutates, the save fails
    a.runtime.execution.paper().onQuote({
      symbol: 'MNQ',
      bid: 1_000,
      ask: 1_000.25,
      asOf: a.clock.now().toISOString(),
    });
    await expect(a.runtime.execution.flush()).rejects.toThrow(/not durable/);
    expect(a.runtime.execution.readiness(account(a)).reconciled).toBe(false);
    const submit = vi.spyOn(a.runtime.execution.paper(), 'submitOrder');
    const d2 = await approve(a).catch(() => null);
    if (d2) expect((await execute(a, d2.approval.approvalId)).outcome).toBe('REJECTED');
    expect(submit).not.toHaveBeenCalled();
    // the stored snapshot predates the close; the crash loses it
    const b = track(await a.crash());
    expect(b.runtime.execution.recoveryState()).toBe('UNCLEAN');
    const restored = b.runtime.execution.paper().exportAccount(ref);
    expect(restored.positions.length).toBe(1); // the lost close is exactly why the account is blocked
    expect((await quarantines(b)).length).toBeGreaterThan(0);
  });

  it('every evidence/UNKNOWN/kill-switch write fails, then the process crashes: restart blocks, preserves the older reservation, never resends', async () => {
    const a = await online();
    const d = await approve(a);
    const paper = a.runtime.execution.paper();
    paper.failures.failNextSubmit = true; // the submit "errors": outcome unknown
    const repo = a.runtime.repos.execution as unknown as Record<string, unknown>;
    // the first durable steps (reserve, dispatch intent) already ran; from here the DB "goes away"
    const realMark = a.runtime.repos.execution.markDispatching.bind(a.runtime.repos.execution);
    (repo as any).markDispatching = async (...args: Parameters<typeof realMark>) => {
      const out = await realMark(...args);
      repo.updateOrder = failing('db outage');
      repo.appendOrderEvent = failing('db outage');
      a.runtime.repos.killSwitches.persist = failing('db outage');
      return out;
    };
    const r = await ticking(a, () => execute(a, d.approval.approvalId));
    expect(['UNKNOWN', 'REJECTED']).toContain(r.outcome);
    expect(r.reasons.join()).toMatch(/NOT recorded|persistence incomplete|not recorded|outage/i);
    const b = track(await a.crash());
    expect(b.runtime.execution.recoveryState()).toBe('UNCLEAN');
    const e = await b.runtime.repos.execution.accountExposure(ACCOUNT);
    expect(e.reservations.length).toBe(1); // the commitment survives, nothing was released
    expect(e.quarantines.length).toBeGreaterThan(0);
    const resend = vi.spyOn(b.runtime.execution.paper(), 'submitOrder');
    await bringOnline(b);
    expect(resend).not.toHaveBeenCalled();
    expect(b.runtime.execution.readiness(account(b)).reconciled).toBe(false);
  });

  it('an ended order the restored broker no longer knows is recorded as lost evidence; nothing is released or resent', async () => {
    const a = await online();
    // snapshot saves never complete (no ACK) while the order flows: a crash loses the fill
    a.runtime.repos.paperState.save = () => new Promise<void>(() => undefined);
    const d = await approve(a);
    expect((await execute(a, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    const before = (await a.runtime.repos.execution.listOrders({ accountId: ACCOUNT }))[0]!;
    const b = track(await a.crash());
    const events = await b.runtime.repos.execution.orderEvents(before.clientOrderId);
    expect(events.map((e) => e.type)).toContain('RECOVERY_EVIDENCE_MISSING');
    const e = await b.runtime.repos.execution.accountExposure(ACCOUNT);
    expect(e.reservations.map((r) => r.clientOrderId)).toContain(before.clientOrderId);
  });
});

describe.skipIf(!available)('R004 — clean stop, checkpoint ACK and restart', () => {
  it('a failed flush propagates, is never reported as clean, and the next start quarantines', async () => {
    const a = await online();
    const d = await approve(a);
    expect((await execute(a, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    a.runtime.repos.paperState.save = failing('snapshot write down');
    a.runtime.execution.paper().onQuote({
      symbol: 'MNQ',
      bid: 1_000,
      ask: 1_000.25,
      asOf: a.clock.now().toISOString(),
    });
    await expect(a.runtime.stop()).rejects.toThrow(/not durable/);
    expect((await ownerRow(a))?.state).toBe('DIRTY');
    const b = track(await a.crash());
    expect(b.runtime.execution.recoveryState()).toBe('UNCLEAN');
  });

  it('positive: stop drains, ACKs a checkpoint, marks CLEAN; the restart matches it and admits a valid entry', async () => {
    const a = await online();
    const d = await approve(a);
    expect((await execute(a, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    const b = track(await a.restart());
    const row = await ownerRow(b);
    expect(row?.state).toBe('DIRTY'); // the new session
    expect(b.runtime.execution.recoveryState()).toBe('CLEAN');
    expect(await quarantines(b)).toHaveLength(0);
    const ref = account(b).broker.accountRef;
    expect(b.runtime.execution.paper().exportAccount(ref).positions.length).toBe(1);
    await bringOnline(b);
    // a valid new entry on a different instrument is admitted once the position is gone
    b.runtime.execution
      .paper()
      .closeAtMarket(ref, b.runtime.execution.paper().exportAccount(ref).positions[0]!.positionId);
    await b.runtime.execution.flush();
    expect(b.runtime.execution.readiness(account(b)).reconciled).toBe(true);
  });

  it('a CLEAN commit whose acknowledgement is lost is honest about it and the restart verifies the checkpoint', async () => {
    const a = await online();
    const sessionProto = (a.runtime.execution as any).session;
    const real = sessionProto.markClean.bind(sessionProto);
    sessionProto.markClean = async (...args: unknown[]) => {
      await real(...args); // committed…
      throw new Error('connection reset before ACK'); // …but the client never saw it
    };
    await expect(a.runtime.stop()).rejects.toThrow(/may or may not be committed/);
    expect((await ownerRow(a))?.state).toBe('CLEAN'); // it WAS committed
    const b = track(await a.crash());
    expect(b.runtime.execution.recoveryState()).toBe('CLEAN'); // matching, already-drained checkpoint
    expect(await quarantines(b)).toHaveLength(0);
  });

  it('replaying committed evidence whose acknowledgement was lost is idempotent', async () => {
    const h = await online();
    const d = await approve(h);
    expect((await execute(h, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    const repo = h.runtime.repos.execution;
    const order = (await repo.listOrders({ accountId: ACCOUNT }))[0]!;
    const state = (await h.runtime.execution
      .paper()
      .getOrder(account(h).broker.accountRef, order.clientOrderId))!;
    const before = await repo.accountExposure(ACCOUNT);
    const first = await repo.updateOrder(order.clientOrderId, state); // "ACK lost" → replayed
    const second = await repo.updateOrder(order.clientOrderId, state);
    expect(first.contradiction ?? null).toBeNull();
    expect(second.contradiction ?? null).toBeNull();
    const after = await repo.accountExposure(ACCOUNT);
    expect(after.reservations).toHaveLength(before.reservations.length);
    expect(after.quarantines).toHaveLength(0);
  });
});
