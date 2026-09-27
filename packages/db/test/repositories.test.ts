import { ManualClock } from '@astra/core';
import { DecisionEngine } from '@astra/decision';
import { ExecutionGateway, PaperBrokerAdapter } from '@astra/execution';
import { KillSwitchRegistry } from '@astra/safety';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountRepository } from '../src/repositories/accounts';
import { AuditRepository } from '../src/repositories/audit';
import { DecisionRepository } from '../src/repositories/decisions';
import { ExecutionRepository } from '../src/repositories/execution';
import { KillSwitchRepository } from '../src/repositories/kill-switches';
import { NQ, account, makeInputs, tracking } from '../../decision/test/fixtures';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();
let seq = 0;
const approvalIds = () => `apr_test_${++seq}_${Date.now()}`;

describe.skipIf(!available)('repositories', () => {
  let db: TestDb;
  let decisions: DecisionRepository;
  beforeAll(async () => {
    db = await createTestDb();
    decisions = new DecisionRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  describe('kill switches', () => {
    it('persists, reloads (restart recovery) and audits changes', async () => {
      const repo = new KillSwitchRepository(db.sql);
      const clock = new ManualClock('2026-09-28T14:00:00Z');
      const reg = new KillSwitchRegistry(clock);
      reg.load(await repo.loadAll());
      await repo.persist(
        reg.activate({
          scope: 'GLOBAL',
          target: null,
          reason: 'test halt',
          actor: { type: 'HUMAN', id: 'owner' },
        }),
      );
      await repo.persist(
        reg.activate({
          scope: 'ACCOUNT',
          target: 'acct-a',
          reason: 'daily loss',
          actor: { type: 'SYSTEM', id: 'halt-monitor' },
          clearPolicy: 'NEXT_TRADING_DAY',
          autoClearAt: '2026-09-28T21:00:00.000Z',
        }),
      );

      const restarted = new KillSwitchRegistry(clock);
      restarted.load(await repo.loadAll());
      expect(restarted.evaluate({ accountId: 'x' }).blocked).toBe(true);
      expect(restarted.get('ACCOUNT', 'acct-a')).toMatchObject({
        clearPolicy: 'NEXT_TRADING_DAY',
        autoClearAt: '2026-09-28T21:00:00.000Z',
      });

      const change = restarted.planDeactivation({
        scope: 'GLOBAL',
        target: null,
        reason: 'resolved',
        actor: { type: 'HUMAN', id: 'owner' },
      });
      await repo.persist(change);
      restarted.apply(change);
      const again = new KillSwitchRegistry(clock);
      again.load(await repo.loadAll());
      expect(again.get('GLOBAL', null)?.active).toBe(false);
      const audit = await new AuditRepository(db.sql).list({ category: 'KILL_SWITCH' });
      expect(audit.map((a) => a.action)).toEqual(['DEACTIVATED', 'ACTIVATED', 'ACTIVATED']);
    });
  });

  describe('decisions', () => {
    it('records a decision with its inputs and audit entry atomically', async () => {
      const engine = new DecisionEngine({ newApprovalId: approvalIds });
      const inputs = makeInputs({ decisionId: 'dec_repo_1' });
      const d = engine.evaluate(inputs);
      expect(d.status).toBe('APPROVED');
      await decisions.record(d, inputs);
      const got = await decisions.get('dec_repo_1');
      expect(got?.decision.orderPlan).toEqual(d.orderPlan);
      expect(got?.inputs.candidate.signal.id).toBe('sig-1');
      expect(got?.approvalState).toBe('PENDING');
      expect(await decisions.priorApprovedForSignal('acct-a', 'sig-1')).toBe('dec_repo_1');
      expect((await decisions.list({ status: 'APPROVED' })).map((x) => x.decisionId)).toContain(
        'dec_repo_1',
      );
    });

    it('refuses a second approval for the same signal (DB-level duplicate protection)', async () => {
      const engine = new DecisionEngine({ newApprovalId: approvalIds });
      const inputs = makeInputs({ decisionId: 'dec_repo_dup' });
      await expect(decisions.record(engine.evaluate(inputs), inputs)).rejects.toThrow();
      expect(await decisions.get('dec_repo_dup')).toBeNull(); // nothing partially written
    });

    it('records rejections', async () => {
      const inputs = makeInputs({ decisionId: 'dec_repo_rej', mode: 'HALTED' });
      await decisions.record(new DecisionEngine().evaluate(inputs), inputs);
      expect((await decisions.get('dec_repo_rej'))?.status).toBe('REJECTED');
    });

    it('decisions are immutable except for the approval lifecycle', async () => {
      await expect(
        db.sql`update trade_decisions set status = 'REJECTED' where id = 'dec_repo_1'`,
      ).rejects.toThrow(/immutable/);
      await expect(db.sql`delete from trade_decisions where id = 'dec_repo_1'`).rejects.toThrow(
        /cannot be deleted/,
      );
    });
  });

  describe('execution on the real database', () => {
    it('runs the gateway end to end: consume approval, create order, confirm fill', async () => {
      const engine = new DecisionEngine({ newApprovalId: approvalIds });
      const base = makeInputs({ decisionId: 'dec_exec_1' });
      const inputs = {
        ...base,
        candidate: { ...base.candidate, signal: { ...base.candidate.signal, id: 'sig-exec-1' } },
      };
      const d = engine.evaluate(inputs);
      await decisions.record(d, inputs);

      const clock = new ManualClock('2026-09-28T14:00:05.000Z');
      const broker = new PaperBrokerAdapter({ clock, instruments: () => NQ });
      broker.openAccount('PAPER-A', 50_000);
      broker.onQuote({
        symbol: 'NQ',
        bid: 19_999.75,
        ask: 20_000,
        asOf: clock.now().toISOString(),
      });
      const ks = new KillSwitchRegistry(clock);
      ks.load([]);
      const store = new ExecutionRepository(db.sql);
      const gateway = new ExecutionGateway({
        store,
        adapter: () => broker,
        account: () => account,
        mode: () => 'PAPER',
        killSwitches: (c) => ks.evaluate(c),
        liveTradingEnvironmentAuthorized: () => false,
        onExecutionUnknown: vi.fn(() => Promise.resolve()),
        clock,
        confirmation: { timeoutMs: 1_000, pollIntervalMs: 100 },
        sleep: (ms) => {
          clock.advance(ms);
          return Promise.resolve();
        },
      });

      const [r1, r2] = await Promise.all([
        gateway.execute(d.approval!.approvalId),
        gateway.execute(d.approval!.approvalId),
      ]);
      expect([r1.outcome, r2.outcome].sort()).toEqual(['CONFIRMED', 'REJECTED']);
      const orders = await store.listOrders({ accountId: 'acct-a' });
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        status: 'FILLED',
        filledQuantity: 1,
        averageFillPrice: 20_000,
      });
      expect((await store.orderEvents(orders[0]!.clientOrderId)).map((e) => e.type)).toEqual([
        'SUBMIT_REQUESTED',
        'SUBMIT_RESPONSE',
        'CONFIRMED',
      ]);
      expect((await decisions.get('dec_exec_1'))?.approvalState).toBe('CONSUMED');
      await expect(
        db.sql`update trade_decisions set approval_state = 'PENDING' where id = 'dec_exec_1'`,
      ).rejects.toThrow(/final/);
      expect((await new AuditRepository(db.sql).verifyChain()).ok).toBe(true);
    });
  });

  describe('accounts', () => {
    it('round-trips tracking state, records closed trades idempotently and computes activity', async () => {
      const repo = new AccountRepository(db.sql);
      await repo.saveTracking(tracking);
      expect(await repo.getTracking('acct-a')).toEqual(tracking);
      const trade = {
        id: 't1',
        accountId: 'acct-a',
        clientOrderId: null,
        symbol: 'NQ',
        direction: 'LONG' as const,
        quantity: 1,
        entryPrice: 20_000,
        exitPrice: 19_990,
        exitReason: 'STOP',
        realizedPnl: -200,
        openedAt: '2026-09-28T14:00:00.000Z',
        closedAt: '2026-09-28T14:05:00.000Z',
      };
      expect(await repo.recordClosedTrade(trade)).toBe(true);
      expect(await repo.recordClosedTrade(trade)).toBe(false);
      await repo.recordClosedTrade({
        ...trade,
        id: 't2',
        realizedPnl: -150,
        closedAt: '2026-09-28T14:10:00.000Z',
      });
      const a = await repo.activity('acct-a', {
        key: '2026-09-28',
        start: '2026-09-27T21:00:00.000Z',
        end: '2026-09-28T21:00:00.000Z',
      });
      expect(a).toEqual({ tradingDayKey: '2026-09-28', tradesToday: 1, consecutiveLosses: 2 });
    });
  });
});
