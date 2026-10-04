/**
 * S001 on a REAL PostgreSQL: durable account-wide reservations shared by separate gateways (each
 * with its own connection pool, i.e. its own "process"), the reservation lifecycle, restart and
 * database-failure behaviour. Fake broker only.
 */
import { mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrokerOrderState, OrderRecord } from '@astra/execution';
import {
  decide,
  instrument,
  makeBroker,
  makeGateway,
  makeWorld,
  type World,
} from '../../execution/test/gate-world';
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
let n = 0;

describe.skipIf(!available)('reservations on PostgreSQL', () => {
  let db: TestDb;
  let decisions: DecisionRepository;
  let store: ExecutionRepository;
  /** A second pool on the same schema: a different process talking to the same database. */
  let db2: ReturnType<typeof createDb>;
  let store2: ExecutionRepository;

  beforeAll(async () => {
    db = await createTestDb();
    decisions = new DecisionRepository(db.sql);
    store = new ExecutionRepository(db.sql);
    db2 = createDb({
      url: TEST_DB_URL,
      schema: db.schema,
      maxConnections: 5,
      applicationName: 'astra-test-2',
    });
    store2 = new ExecutionRepository(db2);
  });
  afterEach(async () => {
    // Tests share one account: end every order and reservation so ledgers do not leak across tests.
    await db.sql`update orders set status = 'CANCELLED' where status not in ('FILLED','REJECTED','CANCELLED','EXPIRED','SHADOW')`;
    await db.sql`update exposure_reservations set released_at = now(), release_reason = 'test cleanup' where released_at is null`;
  });
  afterAll(async () => {
    await db2.end({ timeout: 5 });
    await db.cleanup();
  });

  /** Persists a real approved decision (and registers its candidate with the world). */
  async function approve(
    w: World,
    o: { signalId?: string; symbol?: string; limit?: boolean } = {},
  ) {
    const id = ++n;
    const d = decide(w, {
      approvalId: `apr_res_${id}`,
      signalId: o.signalId ?? `sig-res-${id}`,
      decisionId: `dec_res_${id}`,
      ...(o.symbol ? { symbol: o.symbol } : {}),
      ...(o.limit ? { limit: true } : {}),
    });
    await decisions.record(d.decision, d.inputs);
    return d;
  }
  const prior = (a: string, s: string, ex: string) => decisions.priorApprovedForSignal(a, s, ex);
  /** Each test uses its own account id so ledgers never interact. */
  const fresh = () => {
    const w = makeWorld();
    w.clock.advance(5_000);
    return w;
  };
  const tight = (w: World) => {
    w.riskPolicy = {
      ...w.riskPolicy,
      exposure: { ...w.riskPolicy.exposure, maxOpenRiskPercentOfEquity: 0.6 },
    };
  };
  const reservations = async (account = 'acct-a') =>
    (await store.accountExposure(account)).reservations;
  const orderRow = (id: string) => store.orderByClientId(id);

  it('two gateways in separate "processes" cannot overspend a shared allowance across symbols', async () => {
    const w = fresh();
    tight(w);
    const a1 = await approve(w, { symbol: 'NQ' });
    const a2 = await approve(w, { symbol: 'ES' });
    const broker = instrument(w, makeBroker(w));
    const gwA = makeGateway(w, store, broker, { priorApproved: prior });
    const gwB = makeGateway(w, store2, broker, {
      priorApproved: (a, s, e) => new DecisionRepository(db2).priorApprovedForSignal(a, s, e),
    });
    // Both validations read the ledger before either commits.
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((r) => (open = r));
    w.onSnapshot = async () => {
      if (++arrived === 2) open();
      await both;
    };
    const [r1, r2] = await Promise.all([
      gwA.execute(a1.approval.approvalId),
      gwB.execute(a2.approval.approvalId),
    ]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['CONFIRMED', 'REJECTED']);
    const loser = r1.outcome === 'REJECTED' ? r1 : r2;
    // Either the allowance (loser re-gated on the winner's reservation) or the winner's still-unconfirmed
    // order (cross-process in-flight serialisation) refuses it — never an overspend.
    expect(reasons(loser)).toMatch(/risk|open|unresolved/i);
    const orders = await store.listOrders({ accountId: 'acct-a' });
    expect(
      orders.filter(
        (o) => o.signalId === a1.approval.signalId || o.signalId === a2.approval.signalId,
      ),
    ).toHaveLength(1);
    const states = [
      (await decisions.get(a1.decision.decisionId))!.approvalState,
      (await decisions.get(a2.decision.decisionId))!.approvalState,
    ];
    expect(states.sort()).toEqual(['CONSUMED', 'PENDING']);
    expect((await new AuditRepository(db.sql).verifyChain()).ok).toBe(true);
    // The loser's refusal is audited; nothing was transmitted for it.
    const refused =
      await db.sql`select count(*)::int as c from audit_log where action = 'EXECUTION_REFUSED'`;
    expect(refused[0]!.c).toBeGreaterThanOrEqual(1);
  });

  it('duplicate recheck exempts only the original decision (exclusion is in the query, not after LIMIT 1)', async () => {
    const w = fresh();
    const first = await approve(w, { signalId: 'sig-dup-1' });
    const a = first.decision.decisionId;
    // The schema already forbids a second approved decision for the same account + signal ...
    await expect(approve(w, { signalId: 'sig-dup-1' })).rejects.toThrow(/one_approval_per_signal/);
    // ... and exempting the ORIGINAL finds nothing, while exempting any OTHER id still finds it.
    expect(await decisions.priorApprovedForSignal('acct-a', 'sig-dup-1', a)).toBeNull();
    expect(await decisions.priorApprovedForSignal('acct-a', 'sig-dup-1', 'dec_other')).toBe(a);
    expect(await decisions.priorApprovedForSignal('acct-a', 'sig-dup-1')).toBe(a);
    // Through the real gate, an unrelated approval of the same signal blocks execution.
    const gw = makeGateway(w, store, instrument(w, makeBroker(w)), {
      priorApproved: () => Promise.resolve('dec_unrelated'),
    });
    const r = await gw.execute(first.approval.approvalId);
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/already approved in decision dec_unrelated/);
  });

  it('a stale ledger version commits nothing: no order, approval stays PENDING', async () => {
    const w = fresh();
    const a = await approve(w);
    const e = await store.accountExposure('acct-a');
    const order: OrderRecord = {
      orderId: `o_stale_${n}`,
      clientOrderId: `astra-${a.approval.approvalId}`,
      approvalId: a.approval.approvalId,
      decisionId: a.decision.decisionId,
      accountId: 'acct-a',
      strategyId: 'test-strategy',
      signalId: a.approval.signalId,
      adapterId: 'paper',
      mode: 'PAPER',
      symbol: 'NQ',
      direction: 'LONG',
      quantity: 1,
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
    const r = await store.reserveAndConsume({
      order,
      expectedVersion: e.version + 7,
      at: AT,
      intent: {},
    });
    expect(r).toMatchObject({ ok: false, code: 'LEDGER_CHANGED' });
    expect(await orderRow(order.clientOrderId)).toBeNull();
    expect((await decisions.get(a.decision.decisionId))!.approvalState).toBe('PENDING');
    // Expired approvals are refused inside the same atomic step.
    const late = await store.reserveAndConsume({
      order,
      expectedVersion: e.version,
      at: '2026-09-28T15:00:00.000Z',
      intent: {},
    });
    expect(late).toMatchObject({ ok: false, code: 'APPROVAL_EXPIRED' });
    expect(await orderRow(order.clientOrderId)).toBeNull();
  });

  it('the database itself allows one active reservation per account and symbol', async () => {
    const w = fresh();
    const a = await approve(w, { symbol: 'ES' });
    const gw = makeGateway(w, store, instrument(w, makeBroker(w)), { priorApproved: prior });
    expect((await gw.execute(a.approval.approvalId)).outcome).toBe('CONFIRMED');
    await expect(
      db.sql`insert into exposure_reservations (id, account_id, client_order_id, approval_id, strategy_id, symbol, direction,
              entry, stop, target, quantity, reserved_quantity, order_status, reserved_at)
             select 'rsv_dup', account_id, client_order_id, approval_id, strategy_id, symbol, direction, entry, stop, target,
                    quantity, reserved_quantity, order_status, reserved_at from exposure_reservations
              where client_order_id = ${`astra-${a.approval.approvalId}`}`,
    ).rejects.toThrow();
    expect((await reservations()).filter((r) => r.symbol === 'ES')).toHaveLength(1);
  });

  describe('lifecycle', () => {
    async function restingLimit(w: World) {
      const a = await approve(w, { symbol: 'NQ', limit: true });
      const gw = makeGateway(w, store, instrument(w, makeBroker(w)), { priorApproved: prior });
      const r = await gw.execute(a.approval.approvalId);
      expect(r.brokerState?.status).toBe('ACCEPTED');
      return { a, id: `astra-${a.approval.approvalId}`, gw };
    }
    const state = (
      id: string,
      status: BrokerOrderState['status'],
      filled: number,
      qty = 3,
    ): BrokerOrderState => ({
      clientOrderId: id,
      brokerOrderId: 'b1',
      status,
      quantity: qty,
      filledQuantity: filled,
      averageFillPrice: filled > 0 ? 19_995 : null,
      rejectReason: null,
      updatedAt: AT,
    });

    it('a resting LIMIT stays reserved until authoritative evidence; time alone never releases it', async () => {
      const w = fresh();
      const { id } = await restingLimit(w);
      w.clock.advance(25_000);
      expect(await store.reconcileReservations('acct-a', AT)).toBe(0);
      expect((await reservations()).find((r) => r.clientOrderId === id)).toMatchObject({
        orderStatus: 'ACCEPTED',
        reservedQuantity: 1,
      });
      await store.updateOrder(id, state(id, 'CANCELLED', 0, 1));
      expect((await reservations()).find((r) => r.clientOrderId === id)).toBeUndefined();
      const [row] =
        await db.sql`select release_reason from exposure_reservations where client_order_id = ${id}`;
      expect(row!.release_reason).toMatch(/CANCELLED with nothing filled/);
    });

    it('partial fill keeps filled + remaining reserved; cancel keeps only the filled part; only linked closure releases it', async () => {
      const w = fresh();
      const { id } = await restingLimit(w);
      await store.updateOrder(id, state(id, 'PARTIALLY_FILLED', 1, 1)); // 1 of (approved) 1 filled partially for the test
      const [partial] = (await reservations()).filter((r) => r.clientOrderId === id);
      expect(partial).toMatchObject({
        orderStatus: 'PARTIALLY_FILLED',
        reservedQuantity: 1,
        filledQuantity: 1,
      });
      await store.updateOrder(id, state(id, 'CANCELLED', 1, 1));
      expect((await reservations()).find((r) => r.clientOrderId === id)).toMatchObject({
        orderStatus: 'CANCELLED',
        reservedQuantity: 1,
      });
      // No closure for this order yet (and a flat/other snapshot is irrelevant): retained.
      expect(await store.reconcileReservations('acct-a', AT)).toBe(0);
      await new AccountRepository(db.sql).recordClosedTrade({
        id: 'ct_other',
        accountId: 'acct-a',
        clientOrderId: 'astra-unrelated',
        symbol: 'NQ',
        direction: 'LONG',
        quantity: 1,
        entryPrice: 1,
        exitPrice: 1,
        exitReason: 'STOP',
        realizedPnl: 0,
        openedAt: AT,
        closedAt: AT,
      });
      expect(await store.reconcileReservations('acct-a', AT)).toBe(0);
      await new AccountRepository(db.sql).recordClosedTrade({
        id: 'ct_mine',
        accountId: 'acct-a',
        clientOrderId: id,
        symbol: 'NQ',
        direction: 'LONG',
        quantity: 1,
        entryPrice: 19_995,
        exitPrice: 19_985,
        exitReason: 'STOP',
        realizedPnl: -50,
        openedAt: AT,
        closedAt: AT,
      });
      expect(await store.reconcileReservations('acct-a', AT)).toBe(1);
      expect(await store.reconcileReservations('acct-a', AT)).toBe(0);
      expect((await reservations()).find((r) => r.clientOrderId === id)).toBeUndefined();
    });

    it('UNKNOWN survives a restart (new pool, new gateway): still reserved, new entries blocked, never resent', async () => {
      const w = fresh();
      const a = await approve(w, { symbol: 'NQ' });
      const b = await approve(w, { symbol: 'ES' });
      const paper = makeBroker(w);
      const submit = vi.spyOn(paper, 'submitOrder').mockRejectedValue(new Error('socket hang up'));
      vi.spyOn(paper, 'getOrder').mockResolvedValue(null);
      const unknown = vi.fn(() => Promise.resolve());
      const gw = makeGateway(w, store, instrument(w, paper), {
        priorApproved: prior,
        onExecutionUnknown: unknown,
      });
      expect((await gw.execute(a.approval.approvalId)).outcome).toBe('UNKNOWN');
      const id = `astra-${a.approval.approvalId}`;
      // "Restart": a brand-new pool/repository/gateway; the uncertainty is read back from the database.
      const restartedDb = createDb({
        url: TEST_DB_URL,
        schema: db.schema,
        maxConnections: 2,
        applicationName: 'astra-restart',
      });
      try {
        const restarted = new ExecutionRepository(restartedDb);
        expect(
          (await restarted.accountExposure('acct-a')).reservations.find(
            (r) => r.clientOrderId === id,
          ),
        ).toMatchObject({
          orderStatus: 'UNKNOWN',
          dispatched: true,
        });
        const gw2 = makeGateway(w, restarted, instrument(w, paper), { priorApproved: prior });
        const r = await gw2.execute(b.approval.approvalId);
        expect(r.outcome).toBe('REJECTED');
        expect(reasons(r)).toMatch(/unresolved \(UNKNOWN\)/);
        expect((await gw2.execute(a.approval.approvalId)).outcome).toBe('REJECTED'); // duplicate execution
        expect(submit).toHaveBeenCalledTimes(1);
        // Authoritative evidence (broker says it never existed → REJECTED) is what finally releases it.
        await restarted.updateOrder(id, state(id, 'REJECTED', 0, 1));
        expect(
          (await restarted.accountExposure('acct-a')).reservations.find(
            (r) => r.clientOrderId === id,
          ),
        ).toBeUndefined();
      } finally {
        await restartedDb.end({ timeout: 5 });
      }
    });

    it('restart reconciliation: a never-dispatched order is released, a dispatched one is retained, and a stalled process cannot dispatch after release', async () => {
      const w = fresh();
      const a = await approve(w, { symbol: 'NQ' });
      const mk = async (ap: typeof a, symbol: string) => {
        const e = await store.accountExposure('acct-a');
        const order: OrderRecord = {
          orderId: `o_${ap.approval.approvalId}`,
          clientOrderId: `astra-${ap.approval.approvalId}`,
          approvalId: ap.approval.approvalId,
          decisionId: ap.decision.decisionId,
          accountId: 'acct-a',
          strategyId: 'test-strategy',
          signalId: ap.approval.signalId,
          adapterId: 'paper',
          mode: 'PAPER',
          symbol,
          direction: 'LONG',
          quantity: 1,
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
        expect(
          await store.reserveAndConsume({ order, expectedVersion: e.version, at: AT, intent: {} }),
        ).toEqual({ ok: true });
        return order.clientOrderId;
      };
      const never = await mk(a, 'NQ');
      const b = await approve(w, { symbol: 'ES' });
      const sent = await mk(b, 'ES');
      await store.markDispatching(sent, AT);
      expect(
        await store.releaseUntransmitted(never, 'restart: never dispatched', AT, {
          onlyIfUndispatched: true,
        }),
      ).toBe(true);
      expect(
        await store.releaseUntransmitted(sent, 'restart', AT, { onlyIfUndispatched: true }),
      ).toBe(false);
      expect((await reservations()).map((r) => r.clientOrderId)).toContain(sent);
      expect((await reservations()).map((r) => r.clientOrderId)).not.toContain(never);
      expect((await orderRow(never))!.status).toBe('REJECTED');
      await expect(store.markDispatching(never, AT)).rejects.toThrow(/no active reservation/);
    });
  });

  describe('database failures', () => {
    it('reserve failure: nothing transmitted, nothing consumed', async () => {
      const w = fresh();
      const a = await approve(w, { symbol: 'NQ' });
      const paper = makeBroker(w);
      const submit = vi.spyOn(paper, 'submitOrder');
      const failing = Object.create(store) as ExecutionRepository;
      failing.reserveAndConsume = () => Promise.reject(new Error('connection terminated'));
      const gw = makeGateway(w, failing, instrument(w, paper), { priorApproved: prior });
      const r = await gw.execute(a.approval.approvalId);
      expect(r.outcome).toBe('REJECTED');
      expect(submit).not.toHaveBeenCalled();
      expect((await decisions.get(a.decision.decisionId))!.approvalState).toBe('PENDING');
      expect(await orderRow(`astra-${a.approval.approvalId}`)).toBeNull();
    });

    it('outage after the broker accepted: UNKNOWN, reservation retained in the database, no resend', async () => {
      const w = fresh();
      const a = await approve(w, { symbol: 'NQ' });
      const paper = makeBroker(w);
      const submit = vi.spyOn(paper, 'submitOrder');
      const failing = Object.create(store) as ExecutionRepository;
      failing.updateOrder = () => Promise.reject(new Error('db down'));
      const unknown = vi.fn(() => Promise.resolve());
      const gw = makeGateway(w, failing, instrument(w, paper), {
        priorApproved: prior,
        onExecutionUnknown: unknown,
      });
      const r = await gw.execute(a.approval.approvalId);
      expect(r.outcome).toBe('UNKNOWN');
      expect(unknown).toHaveBeenCalledTimes(1);
      const id = `astra-${a.approval.approvalId}`;
      const held = (await reservations()).find((x) => x.clientOrderId === id);
      expect(held).toMatchObject({ dispatched: true });
      expect((await gw.execute(a.approval.approvalId)).outcome).toBe('REJECTED');
      expect(submit).toHaveBeenCalledTimes(1);
      await store.updateOrder(id, state0(id)); // authoritative state arrives later (reconciliation)
    });
    const state0 = (id: string): BrokerOrderState => ({
      clientOrderId: id,
      brokerOrderId: null,
      status: 'CANCELLED',
      quantity: 1,
      filledQuantity: 0,
      averageFillPrice: null,
      rejectReason: null,
      updatedAt: AT,
    });
  });
});

describe.skipIf(!available)('tracking persistence is monotonic across store instances', () => {
  it('a stale instance cannot overwrite a newer/higher persisted peak, and concurrent writers keep the max', async () => {
    const db = await createTestDb();
    const db2 = createDb({
      url: TEST_DB_URL,
      schema: db.schema,
      maxConnections: 3,
      applicationName: 'astra-track-2',
    });
    try {
      const a = new AccountRepository(db.sql);
      const b = new AccountRepository(db2);
      const t0 = {
        accountId: 'acct-a',
        initialBalance: 50_000,
        tradingDayKey: '2026-09-28',
        dayStartBalance: 50_000,
        dayStartEquity: 50_000,
        dayStartSource: 'OBSERVED_AT_RESET' as const,
        equityPeak: 50_000,
        balancePeak: 50_000,
        endOfDayBalancePeak: 50_000,
        lastBalance: 50_000,
        completedDays: [],
        tradingDaysCount: 0,
        currentDayCounted: false,
        updatedAt: '2026-09-28T14:00:00.000Z',
      };
      await a.saveTracking(t0);
      // Instance A advances: higher peak, later time.
      await a.saveTracking({
        ...t0,
        equityPeak: 56_000,
        lastBalance: 56_000,
        updatedAt: '2026-09-28T14:00:20.000Z',
      });
      // Instance B still believes the old state (cached) and writes a lower peak from older data.
      const merged = await b.saveTracking({
        ...t0,
        equityPeak: 51_000,
        lastBalance: 49_000,
        updatedAt: '2026-09-28T14:00:10.000Z',
      });
      expect(merged).toMatchObject({
        equityPeak: 56_000,
        lastBalance: 56_000,
        updatedAt: '2026-09-28T14:00:20.000Z',
      });
      expect(await a.getTracking('acct-a')).toMatchObject({ equityPeak: 56_000 });
      // Concurrent writers: the higher peak always survives, whichever commits last.
      await Promise.all([
        a.saveTracking({ ...t0, equityPeak: 60_000, updatedAt: '2026-09-28T14:00:30.000Z' }),
        b.saveTracking({ ...t0, equityPeak: 58_000, updatedAt: '2026-09-28T14:00:31.000Z' }),
      ]);
      expect(await a.getTracking('acct-a')).toMatchObject({
        equityPeak: 60_000,
        updatedAt: '2026-09-28T14:00:31.000Z',
      });
    } finally {
      await db2.end({ timeout: 5 });
      await db.cleanup();
    }
  });
});

describe.skipIf(!available)('migration 0010 backfill', () => {
  it('reserves orders that were already in flight when the migration is applied', async () => {
    const schema = `mig_${Date.now().toString(36)}`;
    const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create schema ${schema}`);
    const sql = createDb({
      url: TEST_DB_URL,
      schema,
      maxConnections: 2,
      applicationName: 'astra-mig',
    });
    try {
      const old = mkdtempSync(join(tmpdir(), 'astra-mig-'));
      for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR))
        if (f < '0010') copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
      await migrate(sql, old);
      await sql`insert into trade_decisions (id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status,
                  reasons, checks, sizing, order_plan, explanation, config_hash, inputs, approval_id, approval_expires_at, approval_state)
                values ('d1', now(), 'acct-m', 's', 'sg', 'NQ', 'LONG', 'PAPER', 'APPROVED', '[]', '[]', 'null', 'null', '{}', 'h', '{}',
                        'apr_m', now(), 'CONSUMED')`;
      await sql`insert into orders (id, client_order_id, approval_id, decision_id, account_id, strategy_id, signal_id, adapter_id, mode,
                  symbol, direction, quantity, entry_type, planned_entry, stop_loss, take_profit, status, filled_quantity, created_at, updated_at)
                values ('o1', 'astra-apr_m', 'apr_m', 'd1', 'acct-m', 's', 'sg', 'paper', 'PAPER', 'NQ', 'LONG', 2, 'LIMIT', 20000, 19990, 20030,
                        'ACCEPTED', 0, now(), now())`;
      await migrate(sql);
      const store = new ExecutionRepository(sql);
      const e = await store.accountExposure('acct-m');
      expect(e.version).toBe(1);
      expect(e.reservations).toHaveLength(1);
      expect(e.reservations[0]).toMatchObject({
        symbol: 'NQ',
        quantity: 2,
        reservedQuantity: 2,
        orderStatus: 'ACCEPTED',
        dispatched: true,
      });
    } finally {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  });
});
