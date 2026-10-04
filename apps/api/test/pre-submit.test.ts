import { afterEach, describe, expect, it } from 'vitest';
import { H, bringOnline, candidate, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;

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

describe.skipIf(!available)('API — pre-submit revalidation (S001)', () => {
  it('an approved decision whose market data went stale is revalidated and refused; nothing is sent or consumed', async () => {
    h = await createHarness();
    await bringOnline(h);
    const d = await approve(h);
    h.clock.advance(10_000); // inside the 30s approval TTL, but the quote is no longer fresh
    const r = await execute(h, d.approval.approvalId);
    expect(r.outcome).toBe('REJECTED');
    expect(r.reasons.join()).toMatch(/\[revalidation\]/);
    expect((await h.runtime.repos.execution.listOrders({ accountId: 'paper-demo' })).length).toBe(
      0,
    );
    expect((await h.runtime.repos.decisions.get(d.decisionId))?.approvalState).toBe('PENDING');
    const refused = await h.db
      .sql`select count(*)::int as c from audit_log where action = 'EXECUTION_REFUSED'`;
    expect(refused[0]!.c).toBe(1);
  });

  it('an instrument kill switch set after approval stops the order', async () => {
    h = await createHarness();
    await bringOnline(h);
    const d = await approve(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/activate',
      headers: H.operator,
      payload: { scope: 'INSTRUMENT', target: 'MNQ', reason: 'stop MNQ' },
    });
    const r = await execute(h, d.approval.approvalId);
    expect(r.outcome).toBe('REJECTED');
    expect(r.reasons.join()).toMatch(/stop MNQ/);
    expect((await h.runtime.repos.execution.listOrders({ accountId: 'paper-demo' })).length).toBe(
      0,
    );
  });

  it('a clean approval still executes and leaves an account-wide reservation until the order is resolved', async () => {
    h = await createHarness();
    await bringOnline(h);
    const d = await approve(h);
    const r = await execute(h, d.approval.approvalId);
    expect(r.outcome).toBe('CONFIRMED');
    const e = await h.runtime.repos.execution.accountExposure('paper-demo');
    expect(e.reservations).toHaveLength(1);
    expect(e.reservations[0]).toMatchObject({ symbol: 'MNQ', dispatched: true });
  });

  it('fresh broker equity advances tracking itself (not just a new timestamp on cached state)', async () => {
    h = await createHarness();
    await bringOnline(h);
    const account = h.runtime.config.accounts.get('paper-demo')!;
    const paper = h.runtime.execution.paper();
    const snap = await paper.getAccountSnapshot(account.broker.accountRef, account.id);
    const lowered = { ...snap, equity: snap.equity - 700, balance: snap.balance - 700 };
    const t = await h.runtime.accounts.freshTracking(account.id, lowered, 'SIMULATED');
    expect(t.status).toBe('OK');
    if (t.status === 'OK') {
      expect(t.value.lastBalance).toBe(lowered.balance);
      expect(t.asOf).toBe(lowered.asOf);
    }
  });
});
