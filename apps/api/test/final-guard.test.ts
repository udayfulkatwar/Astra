/**
 * F003 — composed API: the real PreSubmitValidator, DecisionEngine and PostgreSQL ledger. The
 * FINAL shared-ledger read of the final gate (the last durable wait before submit) is held while
 * the clock moves; nothing may reach the broker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/** Runs `during()` while the second ledger read of the final gate (after markDispatching) waits. */
function holdFinalLedgerRead(x: Harness, during: () => void) {
  const repo = x.runtime.repos.execution as unknown as Record<string, (...a: unknown[]) => unknown>;
  const dispatch = repo.markDispatching!.bind(repo);
  const exposure = repo.accountExposure!.bind(repo);
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
      await new Promise((r) => setTimeout(r, 1));
      during();
    }
    return out;
  };
}

describe.skipIf(!available)('API — final synchronous freshness guard (F003)', () => {
  it('quote and account inputs that age during the final ledger wait (approval TTL still valid): nothing is sent, the reservation is released', async () => {
    h = await createHarness();
    await bringOnline(h);
    const submit = vi.spyOn(h.runtime.execution.paper(), 'submitOrder');
    const d = await approve(h);
    holdFinalLedgerRead(h, () => h.clock.advance(8_000)); // approval TTL is 30s
    const r = await execute(h, d.approval.approvalId);
    expect(r.outcome).toBe('REJECTED');
    expect(r.reasons.join()).toMatch(/\[final-guard\]/);
    expect(submit).not.toHaveBeenCalled();
    const e = await h.runtime.repos.execution.accountExposure('paper-demo');
    expect(e.reservations).toHaveLength(0);
  });

  it('positive path: a wait that keeps every input valid submits exactly once', async () => {
    h = await createHarness();
    await bringOnline(h);
    const submit = vi.spyOn(h.runtime.execution.paper(), 'submitOrder');
    const d = await approve(h);
    holdFinalLedgerRead(h, () => h.clock.advance(500));
    const r = await execute(h, d.approval.approvalId);
    expect(r.outcome).toBe('CONFIRMED');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
