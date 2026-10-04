/**
 * R004 on a REAL PostgreSQL: pinned lock identity that can never be revived, legacy evidence,
 * exact CLEAN checkpoint sets, durable session fencing of snapshot saves and of reserve/dispatch
 * (including an ownership change DURING their wait). Each test isolates itself in a fresh schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaperAccountState } from '@astra/execution';
import { decide, makeWorld } from '../../execution/test/gate-world';
import { dedicatedClient } from '../src/client';
import { DecisionRepository } from '../src/repositories/decisions';
import { ExecutionRepository } from '../src/repositories/execution';
import {
  PaperBrokerStateRepository,
  PaperOwnerRepository,
  PaperOwnershipError,
} from '../src/repositories/paper';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();
const AT = '2026-09-28T14:00:05.000Z';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = (balance: number): PaperAccountState => ({
  balance,
  currency: 'USD',
  positions: [],
  orders: [],
  closed: [],
});

describe.skipIf(!available)('paper owner on PostgreSQL (R004 corrections)', () => {
  let db: TestDb;
  let owners: PaperOwnerRepository;
  let states: PaperBrokerStateRepository;
  const live: { release(): Promise<void> }[] = [];
  beforeEach(async () => {
    db = await createTestDb();
    owners = new PaperOwnerRepository(db.sql);
    states = new PaperBrokerStateRepository(db.sql);
  });
  afterEach(async () => {
    for (const s of live.splice(0)) await s.release().catch(() => undefined);
    await db.cleanup();
  });
  const acquire = async (sessionId: string, accountIds: string[] = ['acct-a']) => {
    const s = await owners.acquire({ adapterId: 'paper', sessionId, accountIds, at: AT });
    live.push(s);
    return s;
  };
  const quarantines = async (accountId = 'acct-a') =>
    (
      await db.sql<{ reason: string }[]>`
        select reason from exposure_quarantines where account_id = ${accountId} and cleared_at is null`
    ).map((r) => r.reason);
  const kill = (pid: number) => db.sql`select pg_terminate_backend(${pid})`;

  describe('lock identity is pinned and a loss latches permanently', () => {
    it('the lock connection is never recycled (no idle close, no max lifetime)', () => {
      const lock = dedicatedClient(db.sql, 'probe');
      try {
        expect(lock.options.idle_timeout).toBeFalsy();
        expect(lock.options.max_lifetime).toBeFalsy();
        expect(lock.options.max).toBe(1);
      } finally {
        void lock.end({ timeout: 1 });
      }
    });

    it('a silently dropped and transparently RECONNECTED backend never revives ownership', async () => {
      const s = await acquire('S1');
      await s.verify(); // healthy: the original backend holds the lock
      await kill(s.backendPid);
      await sleep(400); // the socket close is observed; the next query would reconnect quietly
      expect(s.ownerLost).toMatch(/closed|no longer/); // halted at once, with no query at all
      await expect(s.verify()).rejects.toBeInstanceOf(PaperOwnershipError);
      // a later query on the (reconnected) lock client succeeds — and must NOT revive ownership
      await sleep(100);
      await expect(s.verify()).rejects.toBeInstanceOf(PaperOwnershipError);
      await expect(s.markClean({}, AT)).rejects.toBeInstanceOf(PaperOwnershipError);
      expect(s.ownerLost).not.toBeNull();
    });

    it('a failed check already happened, then a later successful SELECT still cannot revive it', async () => {
      const s = await acquire('S1');
      await kill(s.backendPid);
      await expect(s.verify()).rejects.toThrow(); // first failing query/latch
      const lock = (s as unknown as { lock: (q: TemplateStringsArray) => Promise<unknown[]> }).lock;
      let rows: unknown[] | undefined;
      for (let i = 0; i < 10 && !rows; i++) {
        try {
          rows = await lock`select 1 as ok`; // reconnects and SUCCEEDS on a later attempt
        } catch {
          await sleep(100);
        }
      }
      expect(rows).toHaveLength(1);
      await expect(s.verify()).rejects.toThrow();
    });

    it('the proof is the lock itself: a backend without the advisory lock fails verify', async () => {
      const s = await acquire('S1');
      const lock = (s as unknown as { lock: { (q: TemplateStringsArray): Promise<unknown> } }).lock;
      await lock`select pg_advisory_unlock_all()`; // same backend, but the lock is gone
      await expect(s.verify()).rejects.toThrow(/no longer holds the paper advisory lock/);
    });

    it('a competitor can never overlap a live owner, and a replaced owner stays dead', async () => {
      const a = await acquire('A');
      await expect(
        owners.acquire({ adapterId: 'paper', sessionId: 'B', accountIds: ['acct-a'], at: AT }),
      ).rejects.toMatchObject({ code: 'BUSY' });
      await kill(a.backendPid);
      await sleep(300);
      const b = await acquire('B'); // lock is free now; A's DIRTY row is never trusted
      expect(b.prior).toBe('UNCLEAN');
      expect((await quarantines()).length).toBe(1);
      await expect(a.verify()).rejects.toThrow();
      await expect(b.verify()).resolves.toBeUndefined();
      await expect(
        states.save('paper', 'r1', state(1), AT, { sessionId: 'A', revision: 1 }),
      ).rejects.toMatchObject({ code: 'LOST' });
    });
  });

  describe('legacy paper evidence with no ownership record', () => {
    it('a truly empty install is NONE and quarantines nothing', async () => {
      const s = await acquire('S1');
      expect(s.prior).toBe('NONE');
      expect(await quarantines()).toHaveLength(0);
    });

    it('a pre-0015 snapshot with no owner row is UNCLEAN and quarantines before readiness', async () => {
      await db.sql`insert into paper_broker_state (adapter_id, account_ref, state, updated_at)
                   values ('paper', 'PAPER-A', ${db.sql.json(state(50_000) as never)}, ${AT})`;
      const s = await acquire('S1');
      expect(s.prior).toBe('UNCLEAN');
      expect((await quarantines())[0]).toMatch(/legacy paper state/);
    });

    it('a legacy TERMINAL order (reservation released, no snapshot, no kill switch) is UNCLEAN', async () => {
      const w = makeWorld();
      const d = decide(w, {
        approvalId: 'apr_legacy',
        signalId: 'sig-legacy',
        decisionId: 'dec_legacy',
      });
      await new DecisionRepository(db.sql).record(d.decision, d.inputs);
      await new ExecutionRepository(db.sql).createOrder({
        orderId: 'ord_legacy',
        clientOrderId: 'astra-apr_legacy',
        approvalId: 'apr_legacy',
        decisionId: 'dec_legacy',
        accountId: 'acct-a',
        strategyId: 'test-strategy',
        signalId: 'sig-legacy',
        adapterId: 'paper',
        mode: 'PAPER',
        symbol: 'NQ',
        direction: 'LONG',
        quantity: 1,
        entryType: 'MARKET',
        plannedEntry: 20_000,
        stopLoss: 19_990,
        takeProfit: 20_030,
        status: 'REJECTED',
        brokerOrderId: null,
        filledQuantity: 0,
        averageFillPrice: null,
        rejectReason: 'legacy',
        expiresAt: null,
        createdAt: AT,
        updatedAt: AT,
      });
      expect((await db.sql`select 1 from kill_switches where active = true`).length).toBe(0);
      const s = await acquire('S1');
      expect(s.prior).toBe('UNCLEAN');
      expect((await quarantines())[0]).toMatch(/legacy paper state/);
    });
  });

  describe('CLEAN means EXACT checkpoint sets', () => {
    /** Runs one session that checkpoints r1 (and optionally r2) and ends CLEAN. */
    async function cleanSession(refs: string[] = ['r1']) {
      const s = await acquire('S1');
      const cp: Record<string, number> = {};
      for (const r of refs) {
        await states.save('paper', r, state(1), AT, { sessionId: 'S1', revision: 1 });
        cp[r] = 1;
      }
      await s.markClean(cp, AT);
      await s.release();
      live.length = 0;
      return cp;
    }

    it('positive: an exactly matching CLEAN session is admitted without quarantine', async () => {
      await cleanSession(['r1', 'r2']);
      const s = await acquire('S2');
      expect(s.prior).toBe('CLEAN');
      expect(await quarantines()).toHaveLength(0);
    });

    it('a DELETED snapshot row is not vacuously clean', async () => {
      await cleanSession(['r1', 'r2']);
      await db.sql`delete from paper_broker_state where account_ref = 'r2'`;
      const s = await acquire('S2');
      expect(s.prior).toBe('UNCLEAN');
      expect((await quarantines())[0]).toMatch(/do not exactly match/);
    });

    it('an EXTRA snapshot row, a changed revision and a foreign session each quarantine', async () => {
      for (const damage of [
        () => db.sql`insert into paper_broker_state (adapter_id, account_ref, state, updated_at, revision, session_id)
                     values ('paper', 'rX', '{}'::jsonb, ${AT}, 1, 'S1')`,
        () =>
          db.sql`update paper_broker_state set revision = revision + 1 where account_ref = 'r1'`,
        () => db.sql`update paper_broker_state set session_id = 'OTHER' where account_ref = 'r1'`,
      ]) {
        await cleanSession(['r1']);
        await damage();
        const s = await acquire('S2');
        expect(s.prior).toBe('UNCLEAN');
        await s.release();
        live.length = 0;
        await db.sql`delete from paper_owner`;
        await db.sql`delete from paper_broker_state`;
        await db.sql`update exposure_quarantines set cleared_at = ${AT}, clear_reason = 'test reset' where cleared_at is null`;
      }
    });

    it('markClean refuses a missing or extra checkpoint account', async () => {
      const s = await acquire('S1');
      await states.save('paper', 'r1', state(1), AT, { sessionId: 'S1', revision: 1 });
      await states.save('paper', 'r2', state(1), AT, { sessionId: 'S1', revision: 1 });
      await expect(s.markClean({ r1: 1 }, AT)).rejects.toMatchObject({ code: 'STALE' }); // missing r2
      await expect(s.markClean({ r1: 1, r2: 1, r3: 1 }, AT)).rejects.toMatchObject({
        code: 'STALE',
      }); // extra
      await expect(s.markClean({ r1: 1, r2: 2 }, AT)).rejects.toMatchObject({ code: 'STALE' }); // revision
      await s.markClean({ r1: 1, r2: 1 }, AT); // exact
    });
  });

  describe('durable session fencing of reserve/dispatch', () => {
    async function seed(n: number) {
      const w = makeWorld();
      const d = decide(w, {
        approvalId: `apr_f${n}`,
        signalId: `sig-f${n}`,
        decisionId: `dec_f${n}`,
      });
      await new DecisionRepository(db.sql).record(d.decision, d.inputs);
      const store = new ExecutionRepository(db.sql);
      const e = await store.accountExposure('acct-a');
      const order = {
        orderId: `ord_f${n}`,
        clientOrderId: `astra-apr_f${n}`,
        approvalId: `apr_f${n}`,
        decisionId: `dec_f${n}`,
        accountId: 'acct-a',
        strategyId: 'test-strategy',
        signalId: `sig-f${n}`,
        adapterId: 'paper',
        mode: 'PAPER' as const,
        symbol: 'NQ',
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
        createdAt: AT,
        updatedAt: AT,
      };
      return { store, order, version: e.version };
    }

    it('direct repository reserve/dispatch cannot bypass the owner (no fence, wrong fence, no live owner)', async () => {
      const s = await acquire('X');
      const { store, order, version } = await seed(1);
      const req = { order, expectedVersion: version, at: AT, intent: {} };
      expect(await store.reserveAndConsume(req)).toMatchObject({ ok: false, code: 'OWNER_FENCE' });
      expect(await store.reserveAndConsume({ ...req, owner: 'WRONG' })).toMatchObject({
        ok: false,
        code: 'OWNER_FENCE',
      });
      expect(await store.reserveAndConsume({ ...req, owner: 'X' })).toEqual({ ok: true });
      await expect(store.markDispatching(order.clientOrderId, AT)).rejects.toThrow(/fenced/);
      await expect(store.markDispatching(order.clientOrderId, AT, 'WRONG')).rejects.toThrow(
        /fenced/,
      );
      await store.markDispatching(order.clientOrderId, AT, 'X');
      // after a clean end there is no live owner at all: still refused
      await states.save('paper', 'r1', state(1), AT, { sessionId: 'X', revision: 1 });
      await s.markClean({ r1: 1 }, AT);
      const second = await seed(2);
      expect(
        await second.store.reserveAndConsume({
          order: second.order,
          expectedVersion: (await second.store.accountExposure('acct-a')).version,
          at: AT,
          intent: {},
          owner: 'X',
        }),
      ).toMatchObject({ ok: false, code: 'OWNER_FENCE' });
    });

    it('an ownership change DURING the wait of a reserve fails closed', async () => {
      await acquire('X');
      const { store, order, version } = await seed(3);
      let locked!: () => void;
      const hasLock = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const change = db.sql.begin(async (tx) => {
        await tx`select 1 from paper_owner where adapter_id = 'paper' for update`;
        locked();
        await gate;
        await tx`update paper_owner set session_id = 'Y' where adapter_id = 'paper'`;
      });
      await hasLock;
      const pending = store.reserveAndConsume({
        order,
        expectedVersion: version,
        at: AT,
        intent: {},
        owner: 'X',
      });
      await sleep(200); // the reserve is waiting on the owner row
      release();
      await change;
      expect(await pending).toMatchObject({ ok: false, code: 'OWNER_FENCE' });
    });
  });

  describe('durable session fencing of snapshot saves', () => {
    it('a save held on a snapshot conflict completes before an owner change; afterwards the stale owner is refused, even for an identical retry', async () => {
      await acquire('X');
      await states.save('paper', 'r1', state(1), AT, { sessionId: 'X', revision: 1 });
      let held!: () => void;
      const rowLocked = new Promise<void>((r) => (held = r));
      let releaseRow!: () => void;
      const rowGate = new Promise<void>((r) => (releaseRow = r));
      const holder = db.sql.begin(async (tx) => {
        await tx`select 1 from paper_broker_state where account_ref = 'r1' for update`;
        held();
        await rowGate;
      });
      await rowLocked;
      const save2 = states.save('paper', 'r1', state(2), AT, { sessionId: 'X', revision: 2 });
      await sleep(200); // save waits on the snapshot row, holding the owner row FOR SHARE
      let replaced = false;
      const replace = db.sql
        .begin(async (tx) => {
          await tx`update paper_owner set session_id = 'Y' where adapter_id = 'paper'`;
        })
        .then(() => (replaced = true));
      await sleep(200);
      expect(replaced).toBe(false); // the owner change waits for the in-flight save
      releaseRow();
      await holder;
      await save2; // the save was ordered before the replacement and is a valid ACK
      await replace;
      expect(replaced).toBe(true);
      const stored = await states.loadWithRevision('paper', 'r1');
      expect(stored?.revision).toBe(2);
      // after replacement the stale session can neither persist nor be ACKed idempotently
      await expect(
        states.save('paper', 'r1', state(2), AT, { sessionId: 'X', revision: 2 }),
      ).rejects.toMatchObject({ code: 'LOST' });
      await expect(
        states.save('paper', 'r1', state(3), AT, { sessionId: 'X', revision: 3 }),
      ).rejects.toMatchObject({ code: 'LOST' });
      expect((await states.loadWithRevision('paper', 'r1'))?.revision).toBe(2);
    });

    it('a retry of the same revision with DIFFERENT content is never ACKed; identical content (any key order) is', async () => {
      await acquire('X');
      const a = state(10);
      await states.save('paper', 'r1', a, AT, { sessionId: 'X', revision: 1 });
      await expect(
        states.save('paper', 'r1', state(11), AT, { sessionId: 'X', revision: 1 }),
      ).rejects.toMatchObject({ code: 'STALE' });
      await states.save('paper', 'r1', a, AT, { sessionId: 'X', revision: 1 }); // lost-ACK resend
      const reordered = Object.fromEntries(Object.entries(a).reverse()) as PaperAccountState;
      await states.save('paper', 'r1', reordered, AT, { sessionId: 'X', revision: 1 });
      expect((await states.loadWithRevision('paper', 'r1'))?.state.balance).toBe(10);
    });
  });
});
