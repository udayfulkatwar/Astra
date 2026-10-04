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
import { runEvidenceScenarios } from '../../execution/test/evidence-scenarios';
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

    it('partial closure retains exposure: qty 3, fill 1, close 1 (linked), then 2 more fill → nothing released until all 3 are closed', async () => {
      const w = fresh();
      const a = await approve(w, { symbol: 'NQ' });
      const e = await store.accountExposure('acct-a');
      const id = `astra-${a.approval.approvalId}`;
      const order: OrderRecord = {
        orderId: `o_${id}`,
        clientOrderId: id,
        approvalId: a.approval.approvalId,
        decisionId: a.decision.decisionId,
        accountId: 'acct-a',
        strategyId: 'test-strategy',
        signalId: a.approval.signalId,
        adapterId: 'paper',
        mode: 'PAPER',
        symbol: 'NQ',
        direction: 'LONG',
        quantity: 3,
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
      await store.markDispatching(id, AT);
      const accounts = new AccountRepository(db.sql);
      const close = (cid: string, qty: number) =>
        accounts.recordClosedTrade({
          id: cid,
          accountId: 'acct-a',
          clientOrderId: id,
          symbol: 'NQ',
          direction: 'LONG',
          quantity: qty,
          entryPrice: 20_000,
          exitPrice: 19_990,
          exitReason: 'STOP',
          realizedPnl: -1,
          openedAt: AT,
          closedAt: AT,
        });
      await store.updateOrder(id, state(id, 'PARTIALLY_FILLED', 1));
      await close('ct_p1', 1);
      await store.updateOrder(id, state(id, 'FILLED', 3));
      expect(await store.reconcileReservations('acct-a', AT)).toBe(0);
      expect((await reservations()).find((r) => r.clientOrderId === id)).toMatchObject({
        reservedQuantity: 3,
        orderStatus: 'FILLED',
      });
      await close('ct_p2', 1);
      expect(await store.reconcileReservations('acct-a', AT)).toBe(0); // 2 of 3
      await close('ct_p3', 1);
      expect(await store.reconcileReservations('acct-a', AT)).toBe(1);
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

  describe('contradictory broker evidence', () => {
    it('zero/decreasing/malformed fills and out-of-order states, through two repository instances, never free risk', async () => {
      const w = fresh();
      await runEvidenceScenarios({
        a: store,
        b: store2,
        async newOrder(symbol, quantity) {
          const ap = await approve(w, { symbol: 'NQ' });
          const e = await store.accountExposure('acct-a');
          const id = `astra-${ap.approval.approvalId}`;
          const order: OrderRecord = {
            orderId: `o_${id}`,
            clientOrderId: id,
            approvalId: ap.approval.approvalId,
            decisionId: ap.decision.decisionId,
            accountId: 'acct-a',
            strategyId: 'test-strategy',
            signalId: ap.approval.signalId,
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
          expect(
            await store.reserveAndConsume({
              order,
              expectedVersion: e.version,
              at: AT,
              intent: {},
            }),
          ).toEqual({ ok: true });
          await store.markDispatching(id, AT);
          return id;
        },
        async recordClosure(id, q) {
          await new AccountRepository(db.sql).recordClosedTrade({
            id: `ct_ev_${id}_${q}`,
            accountId: 'acct-a',
            clientOrderId: id,
            symbol: 'NQ',
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
        order: (id) => store2.orderByClientId(id),
        events: async (id) => (await store.orderEvents(id)).map((e) => e.type),
      });
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

describe.skipIf(!available)('migration 0011 backfill of unclosed ended orders', () => {
  async function upgradeFrom0010(seed: (sql: ReturnType<typeof createDb>) => Promise<void>) {
    const schema = `mig11_${Math.random().toString(36).slice(2, 8)}`;
    const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create schema ${schema}`);
    const sql = createDb({
      url: TEST_DB_URL,
      schema,
      maxConnections: 2,
      applicationName: 'astra-mig11',
    });
    const old = mkdtempSync(join(tmpdir(), 'astra-mig11-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR))
      if (f < '0011') copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    await migrate(sql, old); // 0010 already applied, as on an upgraded installation
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
  async function legacyOrder(
    sql: ReturnType<typeof createDb>,
    o: { symbol: string; status: string; qty: number; filled: number; closed?: number[] },
  ) {
    const id = `m${++seq}`;
    await sql`insert into trade_decisions (id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status,
                reasons, checks, sizing, order_plan, explanation, config_hash, inputs, approval_id, approval_expires_at, approval_state)
              values (${`d_${id}`}, now(), 'acct-m', 's', ${`sg_${id}`}, ${o.symbol}, 'LONG', 'PAPER', 'APPROVED', '[]', '[]', 'null',
                      'null', '{}', 'h', '{}', ${`apr_${id}`}, now(), 'CONSUMED')`;
    await sql`insert into orders (id, client_order_id, approval_id, decision_id, account_id, strategy_id, signal_id, adapter_id, mode,
                symbol, direction, quantity, entry_type, planned_entry, stop_loss, take_profit, status, filled_quantity, created_at, updated_at)
              values (${`o_${id}`}, ${`astra-apr_${id}`}, ${`apr_${id}`}, ${`d_${id}`}, 'acct-m', 's', ${`sg_${id}`}, 'paper', 'PAPER',
                      ${o.symbol}, 'LONG', ${o.qty}, 'MARKET', 20000, 19990, 20030, ${o.status}, ${o.filled}, now(), now())`;
    for (const [i, q] of (o.closed ?? []).entries())
      await sql`insert into closed_trades (id, account_id, client_order_id, symbol, direction, quantity, entry_price, exit_price,
                  exit_reason, realized_pnl, opened_at, closed_at)
                values (${`ct_${id}_${i}`}, 'acct-m', ${`astra-apr_${id}`}, ${o.symbol}, 'LONG', ${q}, 1, 1, 'STOP', 0, now(), now())`;
    return `astra-apr_${id}`;
  }

  it('reserves unclosed fills conservatively and never invents flatness', async () => {
    let ids: Record<string, string> = {};
    const h = await upgradeFrom0010(async (sql) => {
      ids = {
        filled: await legacyOrder(sql, { symbol: 'NQ', status: 'FILLED', qty: 2, filled: 2 }),
        cancelledPartial: await legacyOrder(sql, {
          symbol: 'ES',
          status: 'CANCELLED',
          qty: 3,
          filled: 1,
        }),
        expiredPartiallyClosed: await legacyOrder(sql, {
          symbol: 'MNQ',
          status: 'EXPIRED',
          qty: 3,
          filled: 2,
          closed: [1],
        }),
        fullyClosed: await legacyOrder(sql, {
          symbol: 'YM',
          status: 'FILLED',
          qty: 2,
          filled: 2,
          closed: [1, 1],
        }),
        unknownFill: await legacyOrder(sql, { symbol: 'GC', status: 'FILLED', qty: 2, filled: 0 }),
        rejectedNothing: await legacyOrder(sql, {
          symbol: 'CL',
          status: 'REJECTED',
          qty: 1,
          filled: 0,
        }),
      };
    });
    try {
      await migrate(h.sql);
      const e = await h.store.accountExposure('acct-m');
      const by = new Map(e.reservations.map((r) => [r.clientOrderId, r]));
      expect(by.get(ids.filled!)).toMatchObject({
        reservedQuantity: 2,
        filledQuantity: 2,
        orderStatus: 'FILLED',
        dispatched: true,
      });
      expect(by.get(ids.cancelledPartial!)).toMatchObject({
        reservedQuantity: 1,
        filledQuantity: 1,
        orderStatus: 'CANCELLED',
      });
      // Partially closed (1 of 2 filled): the whole fill stays reserved until closures cover it.
      expect(by.get(ids.expiredPartiallyClosed!)).toMatchObject({
        reservedQuantity: 2,
        orderStatus: 'EXPIRED',
      });
      // Fully linked closure and a rejection with nothing filled: nothing to hold.
      expect(by.has(ids.fullyClosed!)).toBe(false);
      expect(by.has(ids.rejectedNothing!)).toBe(false);
      // Unknown legacy fill: the full approved quantity is held.
      expect(by.get(ids.unknownFill!)).toMatchObject({
        reservedQuantity: 2,
        filledQuantity: 0,
        orderStatus: 'FILLED',
      });
      expect(e.reservations).toHaveLength(4);
      expect(e.version).toBeGreaterThanOrEqual(1);
      // The partially closed one is released only when cumulative closures cover the fill.
      await h.sql`insert into closed_trades (id, account_id, client_order_id, symbol, direction, quantity, entry_price, exit_price,
                    exit_reason, realized_pnl, opened_at, closed_at)
                  values ('ct_more', 'acct-m', ${ids.expiredPartiallyClosed!}, 'MNQ', 'LONG', 1, 1, 1, 'STOP', 0, now(), now())`;
      expect(await h.store.reconcileReservations('acct-m', AT)).toBe(1);
    } finally {
      await h.done();
    }
  });

  it('ambiguous legacy exposure on one account/symbol blocks the migration (nothing applied)', async () => {
    const h = await upgradeFrom0010(async (sql) => {
      await legacyOrder(sql, { symbol: 'NQ', status: 'FILLED', qty: 1, filled: 1 });
      await legacyOrder(sql, { symbol: 'NQ', status: 'FILLED', qty: 1, filled: 1 });
    });
    try {
      await expect(migrate(h.sql)).rejects.toThrow(/unresolved legacy exposure/);
      const applied = await h.sql`select name from schema_migrations where name like '0011%'`;
      expect(applied).toHaveLength(0);
    } finally {
      await h.done();
    }
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

      // Same trading day, NEWER timestamp from a stale instance with a lower day-start reference and
      // no knowledge of a completed day: the reference does not loosen and history is kept.
      await a.saveTracking({
        ...t0,
        dayStartBalance: 50_400,
        dayStartEquity: 50_400,
        completedDays: [{ day: '2026-09-25', pnl: 250 }],
        equityPeak: 60_000,
        updatedAt: '2026-09-28T14:01:00.000Z',
      });
      const afterStale = await b.saveTracking({
        ...t0,
        dayStartBalance: 49_000,
        dayStartEquity: 49_000,
        completedDays: [],
        equityPeak: 50_000,
        updatedAt: '2026-09-28T14:02:00.000Z',
      });
      expect(afterStale).toMatchObject({
        dayStartBalance: 50_400,
        dayStartEquity: 50_400,
        equityPeak: 60_000,
      });
      expect(afterStale.completedDays).toEqual([{ day: '2026-09-25', pnl: 250 }]);
      // Equal timestamps with differing same-day references: the higher reference survives.
      const eq = '2026-09-28T14:03:00.000Z';
      await Promise.all([
        a.saveTracking({
          ...t0,
          dayStartBalance: 50_500,
          dayStartEquity: 50_500,
          equityPeak: 60_000,
          updatedAt: eq,
        }),
        b.saveTracking({
          ...t0,
          dayStartBalance: 50_450,
          dayStartEquity: 50_600,
          equityPeak: 60_000,
          updatedAt: eq,
        }),
      ]);
      expect(await a.getTracking('acct-a')).toMatchObject({
        dayStartBalance: 50_500,
        dayStartEquity: 50_600,
      });
      // A genuine day reset takes the new day's (lower) references; a stale yesterday writer cannot revert it.
      await a.saveTracking({
        ...t0,
        tradingDayKey: '2026-09-29',
        dayStartBalance: 49_700,
        dayStartEquity: 49_700,
        equityPeak: 60_000,
        completedDays: [
          { day: '2026-09-25', pnl: 250 },
          { day: '2026-09-28', pnl: -80 },
        ],
        updatedAt: '2026-09-29T21:05:00.000Z',
      });
      const reverted = await b.saveTracking({
        ...t0,
        dayStartBalance: 50_900,
        dayStartEquity: 50_900,
        equityPeak: 60_000,
        updatedAt: '2026-09-29T21:06:00.000Z',
      });
      expect(reverted).toMatchObject({ tradingDayKey: '2026-09-29' });
      expect(reverted.dayStartBalance).toBe(49_700);
      expect(reverted.completedDays.map((x) => x.day)).toEqual(['2026-09-25', '2026-09-28']);
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
