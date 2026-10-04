/**
 * R004 — repro seam written ONLY against APIs that exist on the pre-R004 base, so the same file
 * runs unchanged on the old code (where it fails) and on the candidate (where it passes).
 */
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '@astra/db';
import { AstraRuntime } from '../src/runtime/runtime';
import {
  CONFIG,
  H,
  bringOnline,
  candidate,
  createHarness,
  dbAvailable,
  type Harness,
} from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
const extra: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of extra.splice(0)) await f().catch(() => undefined);
  await h?.close().catch(() => undefined);
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
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

describe.skipIf(!available)('R004 repro seam (runs on the old base and on the candidate)', () => {
  it('a failed paper snapshot save is not absorbed: flush rejects and readiness halts', async () => {
    h = await createHarness();
    await bringOnline(h);
    const d = await approve(h);
    expect((await execute(h, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    h.runtime.repos.paperState.save = () => Promise.reject(new Error('snapshot write down'));
    h.runtime.execution
      .paper()
      .onQuote({ symbol: 'MNQ', bid: 1_000, ask: 1_000.25, asOf: h.clock.now().toISOString() });
    await expect(h.runtime.execution.flush()).rejects.toThrow();
    const account = h.runtime.config.accounts.get('paper-demo')!;
    expect(h.runtime.execution.readiness(account).reconciled).toBe(false);
  });

  it('after a crash (no clean stop) the restarted process does not admit paper entries on a possibly stale snapshot', async () => {
    h = await createHarness();
    await bringOnline(h);
    const d = await approve(h);
    expect((await execute(h, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    // crash: the owner's database sessions die, runtime.stop() never runs
    const pid = (
      h.runtime.execution as unknown as { ownerBackendPid?: () => number | null }
    ).ownerBackendPid?.();
    if (typeof pid === 'number') await h.db.sql`select pg_terminate_backend(${pid})`;
    const sql2 = createDb({
      url:
        process.env.TEST_DATABASE_URL ??
        'postgres://astra:astra_dev_only@localhost:5432/astra_test',
      schema: h.db.schema,
      maxConnections: 5,
    });
    const second = new AstraRuntime({
      config: CONFIG,
      sql: sql2,
      clock: h.clock,
      log: pino({ level: 'silent' }),
      runMigrations: false,
      liveTradingAuthorized: false,
      simulation: false,
      startLoops: false,
    });
    extra.push(async () => {
      await second.stop().catch(() => undefined);
      await sql2.end({ timeout: 5 });
    });
    await second.start();
    const account = second.config.accounts.get('paper-demo')!;
    expect(second.execution.readiness(account).reconciled).toBe(false);
    const quarantines = (await second.repos.execution.accountExposure('paper-demo')).quarantines;
    expect(quarantines.length).toBeGreaterThan(0);
  });
});
