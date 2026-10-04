/**
 * S002 — composed runtime on real PostgreSQL: a protective close that queued behind an entry for the
 * account lock re-reads mode, EXECUTION switches and the CURRENT broker binding inside the lock;
 * zero paper-broker calls after the change. Failed halt writes are reported exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { H, bringOnline, candidate, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
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
const ACCOUNT = 'paper-demo';

/** An open position, plus a second entry that holds the account lock until released. */
async function queuedSetup() {
  const x = (h = await createHarness());
  await bringOnline(x);
  const d1 = await approve(x);
  const d2 = await approve(x); // approved before the position exists
  expect((await execute(x, d1.approval.approvalId)).outcome).toBe('CONFIRMED');
  const account = x.runtime.config.accounts.get(ACCOUNT)!;
  const paper = x.runtime.execution.paper();
  const positionId = paper.exportAccount(account.broker.accountRef).positions[0]!.positionId;
  const close = vi.spyOn(paper, 'closePosition');
  const repo = x.runtime.repos.execution as unknown as Record<string, (...a: unknown[]) => unknown>;
  const real = repo.workingOrders!.bind(repo);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  repo.workingOrders = async (...a) => {
    repo.workingOrders = real;
    entered();
    await gate;
    return real(...a);
  };
  const holder = execute(x, d2.approval.approvalId); // holds the account lock in its first await
  await inside;
  const request = {
    accountId: ACCOUNT,
    positionId,
    clientCloseId: 'protect:S002:test',
    reason: 'S002',
  };
  return { x, account, close, release, holder, request };
}

describe.skipIf(!available)('S002 — queued protective close on the composed runtime', () => {
  it('mode SHADOW set while queued → no paper-broker call', async () => {
    const s = await queuedSetup();
    const queued = s.x.runtime.execution.gateway.protectiveClose(s.request);
    await new Promise((r) => setTimeout(r, 50));
    await s.x.runtime.mode.set('SHADOW', { type: 'HUMAN', id: 'u' } as never, 'test');
    s.release();
    const r = await queued;
    await s.holder;
    expect(r.outcome).toBe('SKIPPED');
    expect(r.reason).toMatch(/never transmits/);
    expect(s.close).not.toHaveBeenCalled();
  });

  it('EXECUTION kill switch activated while queued → no paper-broker call', async () => {
    const s = await queuedSetup();
    const queued = s.x.runtime.execution.gateway.protectiveClose(s.request);
    await new Promise((r) => setTimeout(r, 50));
    await s.x.runtime.killSwitches.activate({
      scope: 'EXECUTION',
      target: ACCOUNT,
      reason: 'exec unsafe',
      actor: { type: 'HUMAN', id: 'u' },
    });
    s.release();
    const r = await queued;
    await s.holder;
    expect(r.outcome).toBe('SKIPPED');
    expect(r.reason).toMatch(/EXECUTION kill switch active/);
    expect(s.close).not.toHaveBeenCalled();
  });

  it('the account broker binding changed while queued → refused, never applied to the new binding', async () => {
    const s = await queuedSetup();
    const queued = s.x.runtime.execution.gateway.protectiveClose(s.request);
    await new Promise((r) => setTimeout(r, 50));
    (s.x.runtime.config.accounts as Map<string, typeof s.account>).set(ACCOUNT, {
      ...s.account,
      broker: { ...s.account.broker, accountRef: 'PAPER-OTHER' },
    });
    s.release();
    const r = await queued;
    await s.holder;
    expect(r.outcome).toBe('REJECTED');
    expect(r.reason).toMatch(/binding changed/);
    expect(s.close).not.toHaveBeenCalled();
  });

  it('entry-only switches set while queued still allow the permitted reduction', async () => {
    const s = await queuedSetup();
    const queued = s.x.runtime.execution.gateway.protectiveClose(s.request);
    await new Promise((r) => setTimeout(r, 50));
    await s.x.runtime.killSwitches.activate({
      scope: 'ACCOUNT',
      target: ACCOUNT,
      reason: 'entries stop',
      actor: { type: 'HUMAN', id: 'u' },
    });
    s.release();
    const r = await queued;
    await s.holder;
    expect(r.outcome).toBe('CLOSED');
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it('an unknown outcome whose halt write also fails is reported exactly (real kill-switch persistence)', async () => {
    const x = (h = await createHarness());
    await bringOnline(x);
    const d = await approve(x);
    expect((await execute(x, d.approval.approvalId)).outcome).toBe('CONFIRMED');
    const paper = x.runtime.execution.paper();
    const account = x.runtime.config.accounts.get(ACCOUNT)!;
    const positionId = paper.exportAccount(account.broker.accountRef).positions[0]!.positionId;
    vi.spyOn(paper, 'closePosition').mockRejectedValueOnce(new Error('transport reset'));
    x.runtime.repos.killSwitches.persist = () => Promise.reject(new Error('db outage'));
    const r = await x.runtime.execution.gateway.protectiveClose({
      accountId: ACCOUNT,
      positionId,
      clientCloseId: 'protect:S002:unknown',
      reason: 'S002',
    });
    expect(r.outcome).toBe('UNKNOWN');
    expect(r.reason).toMatch(/outcome unknown: transport reset/);
    expect(r.reason).toMatch(/execution halt NOT persisted/);
  });
});
