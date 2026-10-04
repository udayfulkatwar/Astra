/**
 * S001-R3 in the composed runtime: a durable account quarantine survives a restart (startup
 * reconciliation never marks the account reconciled and halts it), and unresolved completed-day
 * history makes tracking a non-OK input (fail closed) on both the periodic and the fresh path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { bringOnline, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe.skipIf(!available)('API — durable quarantine and fail-closed history (S001-R3)', () => {
  it('a quarantine recorded in the database keeps the account unreconciled and halted after a restart', async () => {
    h = await createHarness();
    await bringOnline(h);
    const account = h.runtime.config.accounts.get('paper-demo')!;
    expect(h.runtime.execution.readiness(account).reconciled).toBe(true);
    await h.db
      .sql`insert into exposure_quarantines (id, account_id, client_order_id, reason, evidence, created_at)
                   values ('qtn_api', 'paper-demo', null, 'test: late fill after release', '{}', now())`;
    h = await h.restart();
    expect(h.runtime.execution.readiness(account).reconciled).toBe(false);
    const ks = h.runtime.killSwitches.registry.get('EXECUTION', 'paper-demo');
    expect(ks?.active).toBe(true);
    expect(ks?.reason).toMatch(/quarantined: test: late fill after release/);
    const e = await h.runtime.repos.execution.accountExposure('paper-demo');
    expect(e.quarantines).toHaveLength(1);
  });

  it('unresolved completed-day history: tracking() and freshTracking() are non-OK; the evidence stays persisted', async () => {
    h = await createHarness();
    await bringOnline(h);
    const account = h.runtime.config.accounts.get('paper-demo')!;
    const repo = h.runtime.repos.accounts;
    const t = (await repo.getTracking(account.id))!;
    // Two writers recorded different P&L for the same past day with no basis to order them.
    await repo.saveTracking({ ...t, completedDays: [{ day: '2026-09-25', pnl: 900 }] });
    await repo.saveTracking({ ...t, completedDays: [{ day: '2026-09-25', pnl: 40 }] });
    h.clock.advance(1_000);
    const snap = await h.runtime.execution
      .paper()
      .getAccountSnapshot(account.broker.accountRef, account.id);
    const fresh = await h.runtime.accounts.freshTracking(account.id, snap, 'SIMULATED');
    expect(fresh.status).toBe('ERROR');
    expect(fresh.status !== 'OK' && fresh.reason).toMatch(
      /history conflict.*2026-09-25: 900 vs 40/,
    );
    await h.runtime.cycle();
    expect(h.runtime.accounts.tracking(account.id).status).toBe('ERROR');
    const stored = (await repo.getTracking(account.id))!;
    expect(stored.completedDays).toEqual([{ day: '2026-09-25', pnl: 900 }]);
    expect(stored.completedDayConflicts).toEqual([
      expect.objectContaining({ day: '2026-09-25', resolution: 'UNRESOLVED' }),
    ]);
  });
});
