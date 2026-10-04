/**
 * S001-R3 on a REAL PostgreSQL with separate connection pools ("processes"):
 *  - evidence after a released reservation quarantines the ACCOUNT durably (late fills, a
 *    different ending, a trace of an untransmitted order, UNKNOWN), idempotently, without
 *    touching a newer same-symbol reservation, enforced by every gateway and after restart;
 *  - corrective migration 0012 (prematurely released uncovered rows, legacy unknown fills);
 *  - completed-day tracking history across concurrent writers.
 * Fake broker only; no network, no money.
 */
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrokerOrderState, OrderRecord } from '@astra/execution';
import {
  computeAccountState,
  unresolvedDayConflicts,
  updateAccountTracking,
  type AccountTracking,
} from '@astra/prop-firm';
import {
  decide,
  instrument,
  makeBroker,
  makeGateway,
  makeWorld,
} from '../../execution/test/gate-world';
import { lateState, runLateEvidenceScenarios } from '../../execution/test/late-evidence-scenarios';
import { lookup, makeProfile } from '../../prop-firm/test/fixtures';
import { createDb } from '../src/client';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/migrate';
import { AccountRepository } from '../src/repositories/accounts';
import { AuditRepository } from '../src/repositories/audit';
import { DecisionRepository } from '../src/repositories/decisions';
import { ExecutionRepository } from '../src/repositories/execution';
import { TEST_DB_URL, createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();
const AT = '2026-09-28T14:00:05.000Z';
const reasons = (r: { reasons: readonly string[] }) => r.reasons.join(' | ');
type Db = ReturnType<typeof createDb>;

/** A second (or third) pool on the same schema: another process on the same database. */
const pool = (db: TestDb, name: string) =>
  createDb({ url: TEST_DB_URL, schema: db.schema, maxConnections: 3, applicationName: name });

async function plainApproval(sql: Db, id: string, account: string, symbol: string, qty: number) {
  await sql`insert into trade_decisions (id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status,
              reasons, checks, sizing, order_plan, explanation, config_hash, inputs, approval_id, approval_expires_at, approval_state)
            values (${`d_${id}`}, now(), ${account}, 's', ${`sg_${id}`}, ${symbol}, 'LONG', 'PAPER', 'APPROVED', '[]', '[]', 'null',
                    ${sql.json({ symbol, direction: 'LONG', entryType: 'MARKET', entry: 20000, stop: 19990, target: 20030, quantity: qty })},
                    '{}', 'h', '{}', ${`apr_${id}`}, '2026-09-28T15:00:00Z', 'PENDING')`;
  const order: OrderRecord = {
    orderId: `o_${id}`,
    clientOrderId: `astra-apr_${id}`,
    approvalId: `apr_${id}`,
    decisionId: `d_${id}`,
    accountId: account,
    strategyId: 's',
    signalId: `sg_${id}`,
    adapterId: 'paper',
    mode: 'PAPER',
    symbol,
    direction: 'LONG',
    quantity: qty,
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
  return order;
}

describe.skipIf(!available)('late evidence after a release on PostgreSQL (two pools)', () => {
  let db: TestDb;
  let db2: Db;
  beforeAll(async () => {
    db = await createTestDb();
    db2 = pool(db, 'astra-late-2');
  });
  afterAll(async () => {
    await db2.end({ timeout: 5 });
    await db.cleanup();
  });

  it('shared scenarios: quarantine is durable, account-wide, idempotent and never collides with a newer reservation', async () => {
    const a = new ExecutionRepository(db.sql);
    const b = new ExecutionRepository(db2);
    let n = 0;
    const reserve = async (account: string, symbol: string, qty: number) => {
      const order = await plainApproval(db.sql, `late${++n}`, account, symbol, qty);
      const v = (await a.accountExposure(account)).version;
      return {
        id: order.clientOrderId,
        r: await b.reserveAndConsume({ order, expectedVersion: v, at: AT, intent: {} }),
      };
    };
    await runLateEvidenceScenarios({
      a,
      b,
      async newOrder(account, symbol, qty, opts) {
        const { id, r } = await reserve(account, symbol, qty);
        expect(r).toEqual({ ok: true });
        if (opts?.dispatch !== false) await a.markDispatching(id, AT);
        return id;
      },
      tryReserve: async (account, symbol) => (await reserve(account, symbol, 1)).r,
      async recordClosure(account, id, q) {
        await new AccountRepository(db.sql).recordClosedTrade({
          id: `ct_${id}_${q}`,
          accountId: account,
          clientOrderId: id,
          symbol: 'ES',
          direction: 'LONG',
          quantity: q,
          entryPrice: 1,
          exitPrice: 1,
          exitReason: 'STOP',
          realizedPnl: 0,
          openedAt: AT,
          closedAt: AT,
        });
      },
      order: (id) => b.orderByClientId(id),
      events: async (id) => (await a.orderEvents(id)).map((e) => e.type),
    });
    // The released tombstones are unchanged evidence; the quarantine rows are append-only evidence.
    const tomb = await db.sql<
      { order_status: string; filled_quantity: string; released_at: Date }[]
    >`
      select order_status, filled_quantity, released_at from exposure_reservations
       where account_id = 'late-1'`;
    expect(tomb).toHaveLength(1);
    expect(tomb[0]).toMatchObject({ order_status: 'REJECTED', filled_quantity: '0' });
    expect(tomb[0]!.released_at).not.toBeNull();
    await expect(db.sql`delete from exposure_quarantines`).rejects.toThrow(/evidence/);
    await expect(
      db.sql`update exposure_quarantines set reason = 'edited' where account_id = 'late-1'`,
    ).rejects.toThrow(/evidence/);
    expect((await new AuditRepository(db.sql).verifyChain()).ok).toBe(true);
    const audited = await db.sql<{ c: number }[]>`
      select count(*)::int as c from audit_log where action = 'ACCOUNT_QUARANTINED'`;
    expect(audited[0]!.c).toBe(5); // scenarios 1–5, once each despite repeated evidence
  });
});

describe.skipIf(!available)('gateways on PostgreSQL: late fill after release', () => {
  async function world() {
    const db = await createTestDb();
    const w = makeWorld();
    w.clock.advance(5_000);
    const decisions = new DecisionRepository(db.sql);
    let n = 0;
    const approve = async (symbol: string) => {
      const id = ++n;
      const d = decide(w, {
        approvalId: `apr_g${id}`,
        signalId: `sig-g${id}`,
        decisionId: `dec_g${id}`,
        symbol,
      });
      await decisions.record(d.decision, d.inputs);
      return d.approval.approvalId;
    };
    const prior = (a: string, s: string, e: string) => decisions.priorApprovedForSignal(a, s, e);
    return { db, w, approve, prior, decisions };
  }

  it('submit REJECTED 0 then poll FILLED 1 in ONE call: UNKNOWN, quarantined; another pool and a restarted process refuse; never resent', async () => {
    const { db, w, approve, prior } = await world();
    const db2 = pool(db, 'astra-g2');
    const db3 = pool(db, 'astra-g3-restart');
    try {
      const a1 = await approve('NQ');
      const a2 = await approve('ES');
      const paper = makeBroker(w);
      const id = `astra-${a1}`;
      const submit = vi
        .spyOn(paper, 'submitOrder')
        .mockResolvedValueOnce(lateState(id, 'REJECTED', 0));
      vi.spyOn(paper, 'getOrder').mockResolvedValue(lateState(id, 'FILLED', 1));
      const unknown = vi.fn(() => Promise.resolve());
      const broker = instrument(w, paper);
      const gwA = makeGateway(w, new ExecutionRepository(db.sql), broker, {
        priorApproved: prior,
        onExecutionUnknown: unknown,
      });
      const r1 = await gwA.execute(a1);
      expect(r1.outcome).toBe('UNKNOWN');
      expect(reasons(r1)).toMatch(/after its exposure was released/);
      expect(unknown).toHaveBeenCalled();
      // Another process (pool 2) and a restarted one (pool 3, fresh gateway) both refuse.
      for (const sql of [db2, db3]) {
        const gw = makeGateway(w, new ExecutionRepository(sql), broker, {
          priorApproved: (a, s, e) => new DecisionRepository(sql).priorApprovedForSignal(a, s, e),
        });
        const r = await gw.execute(a2);
        expect(r.outcome).toBe('REJECTED');
        expect(reasons(r)).toMatch(/quarantined/);
      }
      expect(submit).toHaveBeenCalledTimes(1);
      const restarted = new ExecutionRepository(db3);
      expect(await restarted.orderByClientId(id)).toMatchObject({
        status: 'UNKNOWN',
        filledQuantity: 1,
      });
      const e = await restarted.accountExposure('acct-a');
      expect(e.reservations).toHaveLength(0);
      expect(e.quarantines.map((q) => q.clientOrderId)).toEqual([id]);
      // The direct reservation step refuses too (no gateway in the way).
      const order = await plainApproval(db3, 'direct', 'acct-a', 'GC', 1);
      expect(
        await restarted.reserveAndConsume({
          order,
          expectedVersion: e.version,
          at: AT,
          intent: {},
        }),
      ).toMatchObject({ ok: false, code: 'ACCOUNT_QUARANTINED' });
    } finally {
      await db2.end({ timeout: 5 });
      await db3.end({ timeout: 5 });
      await db.cleanup();
    }
  });

  it('a late fill committed by another pool WHILE the first or the final validation waits is caught before submit', async () => {
    for (const which of [1, 2] as const) {
      const { db, w, approve, prior, decisions } = await world();
      const db2 = pool(db, 'astra-g-wait');
      try {
        const a0 = await approve('NQ');
        const a1 = await approve('ES');
        const paper = makeBroker(w);
        const id0 = `astra-${a0}`;
        const submit = vi
          .spyOn(paper, 'submitOrder')
          .mockResolvedValueOnce(lateState(id0, 'REJECTED', 0));
        const getOrder = vi
          .spyOn(paper, 'getOrder')
          .mockResolvedValue(lateState(id0, 'REJECTED', 0));
        const gw = makeGateway(w, new ExecutionRepository(db.sql), instrument(w, paper), {
          priorApproved: prior,
        });
        expect((await gw.execute(a0)).outcome).toBe('REJECTED');
        getOrder.mockRestore();
        let calls = 0;
        w.onRevalidate = async () => {
          if (++calls === which)
            await new ExecutionRepository(db2).updateOrder(id0, lateState(id0, 'FILLED', 1));
        };
        const r = await gw.execute(a1);
        expect(r.outcome).toBe('REJECTED');
        expect(reasons(r)).toMatch(/quarantined/);
        expect(submit).toHaveBeenCalledTimes(1); // only a0
        const store = new ExecutionRepository(db.sql);
        if (which === 1) {
          // Nothing was consumed or reserved.
          expect(await store.orderByClientId(`astra-${a1}`)).toBeNull();
          expect((await decisions.get(`dec_g2`))!.approvalState).toBe('PENDING');
        } else {
          // Reserved, provably never transmitted, released.
          expect(await store.orderByClientId(`astra-${a1}`)).toMatchObject({ status: 'REJECTED' });
          expect((await store.accountExposure('acct-a')).reservations).toHaveLength(0);
        }
      } finally {
        await db2.end({ timeout: 5 });
        await db.cleanup();
      }
    }
  });

  it('lost acknowledgement after the quarantine committed: UNKNOWN, idempotent on re-apply, durable across a restart', async () => {
    const { db, w, approve, prior } = await world();
    const db2 = pool(db, 'astra-g-lost');
    try {
      const a1 = await approve('NQ');
      const a2 = await approve('ES');
      const paper = makeBroker(w);
      const id = `astra-${a1}`;
      const submit = vi
        .spyOn(paper, 'submitOrder')
        .mockResolvedValueOnce(lateState(id, 'REJECTED', 0));
      vi.spyOn(paper, 'getOrder').mockResolvedValue(lateState(id, 'FILLED', 1));
      const real = new ExecutionRepository(db.sql);
      let lost = false;
      const flaky = Object.create(real) as ExecutionRepository;
      flaky.updateOrder = async (cid: string, s: BrokerOrderState) => {
        const out = await real.updateOrder(cid, s);
        if (s.status === 'FILLED' && !lost) {
          lost = true;
          throw new Error('connection reset after commit');
        }
        return out;
      };
      const gw = makeGateway(w, flaky, instrument(w, paper), {
        priorApproved: prior,
      });
      expect((await gw.execute(a1)).outcome).toBe('UNKNOWN');
      const v = (await real.accountExposure('acct-a')).version;
      const other = new ExecutionRepository(db2);
      expect(
        (await other.updateOrder(id, lateState(id, 'FILLED', 1))).contradiction,
      ).not.toBeNull();
      const e = await other.accountExposure('acct-a');
      expect(e.version).toBe(v);
      expect(e.quarantines).toHaveLength(1);
      const q = await db.sql<{ c: number }[]>`select count(*)::int as c from exposure_quarantines`;
      expect(q[0]!.c).toBe(1);
      const gw2 = makeGateway(w, other, instrument(w, paper), {
        priorApproved: (a, s, ex) => new DecisionRepository(db2).priorApprovedForSignal(a, s, ex),
      });
      expect(reasons(await gw2.execute(a2))).toMatch(/quarantined/);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      await db2.end({ timeout: 5 });
      await db.cleanup();
    }
  });
});

describe.skipIf(!available)('migration 0012: released-row repair and legacy unknown fills', () => {
  async function upgradeFrom(
    applied: '0010' | '0011',
    seed: (sql: Db) => Promise<void>,
  ): Promise<{ sql: Db; store: ExecutionRepository; done(): Promise<void> }> {
    const schema = `mig12_${applied}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create schema ${schema}`);
    const sql = createDb({ url: TEST_DB_URL, schema, maxConnections: 2, applicationName: 'mig12' });
    const old = mkdtempSync(join(tmpdir(), 'astra-mig12-'));
    const limit = applied === '0010' ? '0011' : '0012';
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR))
      if (f < limit) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    await migrate(sql, old);
    await seed(sql);
    return {
      sql,
      store: new ExecutionRepository(sql),
      async done() {
        await sql.end({ timeout: 5 });
        await admin.unsafe(`drop schema if exists ${schema} cascade`);
        await admin.end();
      },
    };
  }
  let seq = 0;
  /** A legacy order (+ optional reservation row, active or released, + linked closures). */
  async function legacy(
    sql: Db,
    o: {
      account?: string;
      symbol: string;
      status: string;
      qty: number;
      filled: number;
      closed?: number[];
      reservation?: { released: string | null; status?: string; reserved?: number };
    },
  ): Promise<string> {
    const id = `l${++seq}`;
    const account = o.account ?? 'acct-m';
    const cid = `astra-apr_${id}`;
    await sql`insert into trade_decisions (id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status,
                reasons, checks, sizing, order_plan, explanation, config_hash, inputs, approval_id, approval_expires_at, approval_state)
              values (${`d_${id}`}, now(), ${account}, 's', ${`sg_${id}`}, ${o.symbol}, 'LONG', 'PAPER', 'APPROVED', '[]', '[]', 'null',
                      'null', '{}', 'h', '{}', ${`apr_${id}`}, now(), 'CONSUMED')`;
    await sql`insert into orders (id, client_order_id, approval_id, decision_id, account_id, strategy_id, signal_id, adapter_id, mode,
                symbol, direction, quantity, entry_type, planned_entry, stop_loss, take_profit, status, filled_quantity, created_at, updated_at)
              values (${`o_${id}`}, ${cid}, ${`apr_${id}`}, ${`d_${id}`}, ${account}, 's', ${`sg_${id}`}, 'paper', 'PAPER',
                      ${o.symbol}, 'LONG', ${o.qty}, 'MARKET', 20000, 19990, 20030, ${o.status}, ${o.filled}, now(), now())`;
    if (o.reservation)
      await sql`insert into exposure_reservations (id, account_id, client_order_id, approval_id, strategy_id, symbol, direction,
                  entry, stop, target, quantity, reserved_quantity, filled_quantity, order_status, dispatched_at, reserved_at,
                  released_at, release_reason)
                values (${`rsv_${id}`}, ${account}, ${cid}, ${`apr_${id}`}, 's', ${o.symbol}, 'LONG', 20000, 19990, 20030, ${o.qty},
                        ${o.reservation.reserved ?? Math.max(o.filled, 0)}, ${o.filled}, ${o.reservation.status ?? o.status},
                        now(), now(), ${o.reservation.released === null ? null : new Date()}, ${o.reservation.released})`;
    for (const [i, q] of (o.closed ?? []).entries())
      await sql`insert into closed_trades (id, account_id, client_order_id, symbol, direction, quantity, entry_price, exit_price,
                  exit_reason, realized_pnl, opened_at, closed_at)
                values (${`ct_${id}_${i}`}, ${account}, ${cid}, ${o.symbol}, 'LONG', ${q}, 1, 1, 'STOP', 0, now(), now())`;
    return cid;
  }

  for (const from of ['0010', '0011'] as const) {
    it(`upgrade from ${from}: a prematurely released, uncovered fill (3 filled, 1 closed) is reinstated with its prior release kept as evidence; partial closure keeps it`, async () => {
      let ids: Record<string, string> = {};
      const h = await upgradeFrom(from, async (sql) => {
        ids = {
          premature: await legacy(sql, {
            symbol: 'NQ',
            status: 'FILLED',
            qty: 3,
            filled: 3,
            closed: [1],
            reservation: { released: 'prior candidate: flat snapshot' },
          }),
          proven: await legacy(sql, {
            symbol: 'YM',
            status: 'FILLED',
            qty: 2,
            filled: 2,
            closed: [1, 1],
            reservation: {
              released: 'closures recorded for this order cover its cumulative fill (2 of 2)',
            },
          }),
          rejected: await legacy(sql, {
            symbol: 'CL',
            status: 'REJECTED',
            qty: 1,
            filled: 0,
            reservation: { released: 'broker REJECTED with nothing filled', reserved: 0 },
          }),
        };
      });
      try {
        // (Read raw: the repository expects the post-0012 schema.)
        const ledger = await h.sql<{ version: string }[]>`
          select version from account_exposure_ledger where account_id = 'acct-m'`;
        const before = Number(ledger[0]?.version ?? 0);
        await migrate(h.sql);
        const e = await h.store.accountExposure('acct-m');
        expect(e.reservations.map((r) => r.clientOrderId)).toEqual([ids.premature]);
        expect(e.reservations[0]).toMatchObject({
          symbol: 'NQ',
          reservedQuantity: 3,
          filledQuantity: 3,
          orderStatus: 'FILLED',
        });
        expect(e.quarantines).toHaveLength(0);
        expect(e.version).toBeGreaterThan(before);
        const ev = (await h.store.orderEvents(ids.premature!)).find(
          (x) => x.type === 'RESERVATION_REINSTATED',
        );
        expect(ev?.detail).toMatchObject({
          previousReleaseReason: 'prior candidate: flat snapshot',
        });
        // Fully proven closures and rejections stay exactly as they were.
        const kept = await h.sql<{ client_order_id: string; release_reason: string }[]>`
          select client_order_id, release_reason from exposure_reservations
           where client_order_id in ${h.sql([ids.proven!, ids.rejected!])} order by client_order_id`;
        expect(kept.every((k) => k.release_reason !== null)).toBe(true);
        // Cumulative coverage: one more closure (2 of 3) keeps it, the last one releases it.
        const close = async (n: string, q: number) =>
          h.sql`insert into closed_trades (id, account_id, client_order_id, symbol, direction, quantity, entry_price, exit_price,
                  exit_reason, realized_pnl, opened_at, closed_at)
                values (${n}, 'acct-m', ${ids.premature!}, 'NQ', 'LONG', ${q}, 1, 1, 'STOP', 0, now(), now())`;
        await close('ct_more_1', 1);
        expect(await h.store.reconcileReservations('acct-m', AT)).toBe(0);
        await close('ct_more_2', 1);
        expect(await h.store.reconcileReservations('acct-m', AT)).toBe(1);
      } finally {
        await h.done();
      }
    });
  }

  it('ambiguous or contradictory legacy evidence quarantines the account; tombstones and the active reservation are untouched', async () => {
    let ids: Record<string, string> = {};
    const h = await upgradeFrom('0011', async (sql) => {
      ids = {
        active: await legacy(sql, {
          account: 'acct-x',
          symbol: 'NQ',
          status: 'ACCEPTED',
          qty: 1,
          filled: 0,
          reservation: { released: null, reserved: 1 },
        }),
        colliding: await legacy(sql, {
          account: 'acct-x',
          symbol: 'NQ',
          status: 'FILLED',
          qty: 2,
          filled: 2,
          reservation: { released: 'prior candidate: flat snapshot' },
        }),
        // Released "with nothing filled" but the order record now shows a fill (blind late update).
        contradictory: await legacy(sql, {
          account: 'acct-y',
          symbol: 'ES',
          status: 'FILLED',
          qty: 1,
          filled: 1,
          reservation: {
            released: 'broker REJECTED with nothing filled',
            status: 'REJECTED',
            reserved: 0,
          },
        }),
      };
    });
    try {
      await migrate(h.sql);
      const x = await h.store.accountExposure('acct-x');
      expect(x.reservations.map((r) => r.clientOrderId)).toEqual([ids.active]);
      expect(x.quarantines.map((q) => q.clientOrderId)).toEqual([ids.colliding]);
      expect(x.quarantines[0]!.reason).toMatch(/collides/);
      const y = await h.store.accountExposure('acct-y');
      expect(y.reservations).toHaveLength(0);
      expect(y.quarantines.map((q) => q.clientOrderId)).toEqual([ids.contradictory]);
      expect(y.quarantines[0]!.reason).toMatch(/contradicts its order record/);
      const tombs = await h.sql<{ client_order_id: string; release_reason: string | null }[]>`
        select client_order_id, release_reason from exposure_reservations
         where client_order_id in ${h.sql([ids.colliding!, ids.contradictory!])}`;
      expect(tombs.every((t) => t.release_reason !== null)).toBe(true);
    } finally {
      await h.done();
    }
  });

  it('legacy FILLED with no recorded fill becomes UNKNOWN + quarantined and blocks every new entry (real gateway)', async () => {
    const w = makeWorld();
    w.clock.advance(5_000);
    let unknownFill = '';
    const h = await upgradeFrom('0011', async (sql) => {
      // As 0011 left it: full quantity held, labelled FILLED (apparently known).
      unknownFill = await legacy(sql, {
        account: 'acct-a',
        symbol: 'ES',
        status: 'FILLED',
        qty: 2,
        filled: 0,
        reservation: { released: null, reserved: 2 },
      });
    });
    try {
      await migrate(h.sql);
      const e = await h.store.accountExposure('acct-a');
      expect(e.reservations[0]).toMatchObject({
        clientOrderId: unknownFill,
        orderStatus: 'UNKNOWN',
        reservedQuantity: 2,
      });
      expect(e.quarantines.map((q) => q.clientOrderId)).toEqual([unknownFill]);
      // Startup reconciliation now polls it (non-terminal), never resends it.
      expect((await h.store.workingOrdersForAccount('acct-a')).map((o) => o.clientOrderId)).toEqual(
        [unknownFill],
      );
      expect((await h.store.orderEvents(unknownFill)).map((x) => x.type)).toContain(
        'LEGACY_FILL_UNKNOWN',
      );
      const decisions = new DecisionRepository(h.sql);
      const d = decide(w, { approvalId: 'apr_new', signalId: 'sig-new', symbol: 'NQ' });
      await decisions.record(d.decision, d.inputs);
      const paper = makeBroker(w);
      const submit = vi.spyOn(paper, 'submitOrder');
      const gw = makeGateway(w, h.store, instrument(w, paper), {
        priorApproved: (a, s, x) => decisions.priorApprovedForSignal(a, s, x),
      });
      const r = await gw.execute('apr_new');
      expect(r.outcome).toBe('REJECTED');
      expect(reasons(r)).toMatch(/quarantined/);
      expect(submit).not.toHaveBeenCalled();
      // Even an authoritative broker state for the legacy order does not lift the block by itself.
      await h.store.updateOrder(unknownFill, {
        ...lateState(unknownFill, 'FILLED', 2, 2),
      });
      expect((await h.store.accountExposure('acct-a')).quarantines).toHaveLength(1);
    } finally {
      await h.done();
    }
  });
});

describe.skipIf(!available)('tracking: concurrent stale completed-day history (two pools)', () => {
  const reset = { timeZone: 'America/New_York', time: '17:00' };
  const opts = { reset, tradedToday: false, lateObservationThresholdMs: 300_000 };
  const snap = (asOf: string, balance: number) => ({
    accountId: 'acct-a',
    asOf,
    currency: 'USD',
    balance,
    equity: balance,
    openPositions: [],
    pendingOrders: 0,
  });
  const p0: AccountTracking = {
    accountId: 'acct-a',
    initialBalance: 50_000,
    tradingDayKey: '2026-09-28',
    dayStartBalance: 50_000,
    dayStartEquity: 50_000,
    dayStartSource: 'OBSERVED_AT_RESET',
    equityPeak: 50_100,
    balancePeak: 50_100,
    endOfDayBalancePeak: 50_000,
    lastBalance: 50_100,
    completedDays: [{ day: '2026-09-25', pnl: 200, basisAt: '2026-09-25T20:50:00.000Z' }],
    tradingDaysCount: 2,
    currentDayCounted: true,
    updatedAt: '2026-09-28T19:00:00.000Z',
  };
  const consistency = (t: AccountTracking, balance: number) =>
    computeAccountState({
      profile: makeProfile({
        consistency: { maxDayProfitSharePct: 40, enforcement: 'BLOCK_NEW_TRADES' },
      }),
      tracking: t,
      snapshot: snap(t.updatedAt, balance),
      instruments: lookup,
    }).consistency!;

  for (const variant of ['history-saved-first', 'pre-reset-only'] as const) {
    it(`a writer that read before the latest pre-reset balance cannot lower the largest day or gain permission (${variant})`, async () => {
      const db = await createTestDb();
      const db2 = createDb({
        url: TEST_DB_URL,
        schema: db.schema,
        maxConnections: 2,
        applicationName: 'trk-2',
      });
      try {
        const a = new AccountRepository(db.sql);
        const b = new AccountRepository(db2);
        await a.saveTracking(p0);
        const staleRead = (await b.getTracking('acct-a'))!; // B reads BEFORE the latest pre-reset balance
        await a.saveTracking(
          updateAccountTracking(
            (await a.getTracking('acct-a'))!,
            snap('2026-09-28T20:55:00.000Z', 51_000),
            opts,
          ),
        );
        let correct: AccountTracking | null = null;
        if (variant === 'history-saved-first') {
          correct = await a.saveTracking(
            updateAccountTracking(
              (await a.getTracking('acct-a'))!,
              snap('2026-09-28T21:00:10.000Z', 51_000),
              opts,
            ),
          );
          expect(correct.completedDays.find((d) => d.day === '2026-09-28')?.pnl).toBe(1_000);
        }
        // B now writes a LATER post-reset snapshot with day P&L computed from its older read (100).
        const stale = updateAccountTracking(
          staleRead,
          snap('2026-09-28T21:00:20.000Z', 51_000),
          opts,
        );
        expect(stale.completedDays.find((d) => d.day === '2026-09-28')?.pnl).toBe(100);
        const merged = await b.saveTracking(stale);
        expect(merged.updatedAt).toBe('2026-09-28T21:00:20.000Z');
        expect(merged.completedDays.find((d) => d.day === '2026-09-28')).toMatchObject({
          pnl: 1_000,
          basisAt: '2026-09-28T20:55:00.000Z',
        });
        expect(merged.endOfDayBalancePeak).toBe(51_000);
        expect(unresolvedDayConflicts(merged)).toEqual([]);
        // The superseded value is preserved as evidence.
        expect(merged.completedDayConflicts).toEqual([
          expect.objectContaining({
            day: '2026-09-28',
            resolution: 'LATER_BASIS',
            other: expect.objectContaining({ pnl: 100 }),
          }),
        ]);
        // Consistency: the largest profitable day (1 000) is not lowered, so its share is not either.
        const c = consistency(merged, 51_000);
        expect(c.bestDayPnl).toBe(1_000);
        const wrong = consistency({ ...merged, completedDays: stale.completedDays }, 51_000);
        expect(c.bestDaySharePct!).toBeGreaterThan(wrong.bestDaySharePct!);
        expect(await a.getTracking('acct-a')).toMatchObject({
          completedDays: merged.completedDays,
        });
      } finally {
        await db2.end({ timeout: 5 });
        await db.cleanup();
      }
    });
  }

  it('contradictory history the evidence cannot order (legacy entries without a basis) is kept, recorded UNRESOLVED and fails closed', async () => {
    const db = await createTestDb();
    try {
      const a = new AccountRepository(db.sql);
      await a.saveTracking({ ...p0, completedDays: [{ day: '2026-09-25', pnl: 900 }] });
      const merged = await a.saveTracking({
        ...p0,
        completedDays: [{ day: '2026-09-25', pnl: 50 }],
        updatedAt: '2026-09-28T19:30:00.000Z',
      });
      expect(merged.completedDays.find((d) => d.day === '2026-09-25')?.pnl).toBe(900);
      expect(unresolvedDayConflicts(merged)).toHaveLength(1);
      // A later writer that never saw the conflict cannot erase it.
      const later = await a.saveTracking({
        ...p0,
        completedDays: [],
        updatedAt: '2026-09-28T19:40:00.000Z',
      });
      expect(unresolvedDayConflicts(later)).toHaveLength(1);
    } finally {
      await db.cleanup();
    }
  });
});
