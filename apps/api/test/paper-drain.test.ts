/**
 * R004 — a clean stop cannot precede the drain of ALL paper readers/actions/mutations (safety
 * cycle, protection/working-order work, entries, reconciliation, startup), accounts for work that
 * is admitted after the in-flight snapshot, refuses new top-level work while closing, and the
 * recovery after an unclean session visits EVERY ended order. Real PostgreSQL, composed runtime.
 */
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@astra/core';
import { createTestDb } from '../../../packages/db/test/helpers';
import { AstraRuntime } from '../src/runtime/runtime';
import {
  CONFIG,
  H,
  START,
  bringOnline,
  candidate,
  createHarness,
  dbAvailable,
  type Harness,
} from './harness';

const available = await dbAvailable();
const open: Harness[] = [];
afterEach(async () => {
  const last = open.splice(0).at(-1);
  await last?.close().catch(() => undefined);
});
type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateOf = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
async function online() {
  const h = await createHarness();
  open.push(h);
  await bringOnline(h);
  return h;
}
const approve = async (x: Harness) =>
  json(
    await x.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: { candidate: candidate(x) },
    }),
  ).decision as Json;
const execute = async (x: Harness, approvalId: string) =>
  json(
    await x.app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: H.operator,
      payload: { approvalId },
    }),
  );
const ref = (x: Harness) => x.runtime.config.accounts.get('paper-demo')!.broker.accountRef;
const owner = async (x: Harness) =>
  (
    await x.db.sql<{ state: string; checkpoints: Record<string, number> }[]>`
      select state, checkpoints from paper_owner where adapter_id = 'paper'`
  )[0];

describe.skipIf(!available)('R004 — drain before CLEAN', () => {
  it('a held safety cycle is awaited by stop(); work it starts after the in-flight snapshot is drained too; CLEAN checkpoints the result', async () => {
    const h = await online();
    const d = await approve(h);
    expect((await execute(h, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    const paper = h.runtime.execution.paper();
    const position = paper.exportAccount(ref(h)).positions[0]!;
    const order = (await h.runtime.repos.execution.listOrders({ accountId: 'paper-demo' }))[0]!;
    const entered = gateOf();
    const gate = gateOf();
    let nested: unknown = null;
    (h.runtime as any).workingOrders.run = async () => {
      entered.open();
      await gate.p; // the cycle is held (protection/monitor/sync style work)
      // started AFTER stop() took its in-flight snapshot: must still be admitted and drained
      nested = await h.runtime.execution.gateway.refresh(order);
      paper.closeAtMarket(ref(h), position.positionId); // a paper MUTATION late in the cycle
    };
    const cycle = h.runtime.cycle();
    await entered.p;
    let stopped = false;
    const stopP = h.runtime.stop().then(() => (stopped = true));
    await sleep(400);
    expect(stopped).toBe(false); // CLEAN cannot precede the drain
    expect((await owner(h))?.state).toBe('DIRTY');
    gate.open();
    await cycle;
    await stopP;
    expect(nested).not.toBeNull(); // the queued activity was admitted and finished
    const row = await owner(h);
    expect(row?.state).toBe('CLEAN');
    const stored = await h.runtime.repos.paperState.loadWithRevision('paper', ref(h));
    expect(stored?.revision).toBe(row?.checkpoints[ref(h)]);
    expect(stored?.state.positions).toHaveLength(0); // the late mutation is in the checkpoint
  });

  it('a held entry finishes before CLEAN; an entry that arrives while closing is refused with zero submissions', async () => {
    const h = await online();
    const d1 = await approve(h);
    const d2 = await approve(h);
    const submit = (await import('vitest')).vi.spyOn(h.runtime.execution.paper(), 'submitOrder');
    const repo = h.runtime.repos.execution as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const dispatch = repo.markDispatching!.bind(repo);
    const exposure = repo.accountExposure!.bind(repo);
    const gate = gateOf();
    const reached = gateOf();
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
        reached.open();
        await gate.p;
      }
      return out;
    };
    const first = execute(h, d1.approval.approvalId);
    await reached.p;
    let stopped = false;
    const stopP = h.runtime.stop().then(() => (stopped = true));
    await sleep(300);
    expect(stopped).toBe(false);
    const late = await execute(h, d2.approval.approvalId); // arrives while closing
    expect(late.outcome).toBe('REJECTED');
    expect(late.reasons.join()).toMatch(/shutting down|sealed/);
    gate.open();
    expect((await first).outcome).toBe('CONFIRMED');
    await stopP;
    expect(submit).toHaveBeenCalledTimes(1); // only the admitted entry ever reached the broker
    const row = await owner(h);
    expect(row?.state).toBe('CLEAN');
    const stored = await h.runtime.repos.paperState.loadWithRevision('paper', ref(h));
    expect(stored?.revision).toBe(row?.checkpoints[ref(h)]);
    expect(stored?.state.positions).toHaveLength(1);
  });

  it('stop() during startup waits for ownership/restore/reconciliation, then ends CLEAN', async () => {
    const db = await createTestDb();
    try {
      const rt = new AstraRuntime({
        config: CONFIG,
        sql: db.sql,
        clock: new ManualClock(START),
        log: pino({ level: 'silent' }),
        runMigrations: false,
        liveTradingAuthorized: false,
        simulation: false,
        startLoops: false,
        ownerKeepaliveMs: 0,
      });
      const entered = gateOf();
      const gate = gateOf();
      const real = rt.repos.paperOwner.acquire.bind(rt.repos.paperOwner);
      rt.repos.paperOwner.acquire = async (p) => {
        entered.open();
        await gate.p;
        return real(p);
      };
      const startP = rt.start();
      await entered.p;
      let stopped = false;
      const stopP = rt.stop().then(() => (stopped = true));
      await sleep(300);
      expect(stopped).toBe(false); // startup work is not abandoned mid-way
      gate.open();
      await startP;
      await stopP;
      const row = (
        await db.sql<{ state: string }[]>`select state from paper_owner where adapter_id = 'paper'`
      )[0];
      expect(row?.state).toBe('CLEAN');
    } finally {
      await db.cleanup();
    }
  });
});

describe.skipIf(!available)('R004 — recovery visits EVERY ended order', () => {
  it('more than 1000 ended orders are all examined (none silently skipped)', async () => {
    const h = await online();
    const d = await approve(h);
    expect((await execute(h, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    // 1,100 further ended orders for the account (test schema only: FKs relaxed for bulk seeding)
    await h.db.sql`alter table orders drop constraint orders_approval_id_fkey`;
    await h.db.sql`alter table orders drop constraint orders_decision_id_fkey`;
    await h.db.sql`
      insert into orders (id, client_order_id, approval_id, decision_id, account_id, strategy_id, signal_id,
        adapter_id, mode, symbol, direction, quantity, entry_type, planned_entry, stop_loss, take_profit,
        status, filled_quantity, created_at, updated_at)
      select 'ord_bulk_' || g, 'astra-bulk-' || g, 'apr_bulk_' || g, 'dec_bulk_' || g, 'paper-demo',
        'test-strategy', 'sig-bulk-' || g, 'paper', 'PAPER', 'MNQ', 'LONG', 1, 'MARKET', 20000, 19990, 20030,
        'REJECTED', 0, now() - (g || ' seconds')::interval, now()
      from generate_series(1, 1100) g`;
    const b = await h.crash();
    open.push(b);
    expect(b.runtime.execution.recoveryState()).toBe('UNCLEAN');
    const counted = await b.db.sql<{ c: number }[]>`
      select count(*)::int as c from order_events
       where type = 'RECOVERY_EVIDENCE_MISSING' and client_order_id like 'astra-bulk-%'`;
    expect(counted[0]!.c).toBe(1100);
  }, 60_000);
});
