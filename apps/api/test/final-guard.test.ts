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
function holdFinalLedgerRead(x: Harness, during: () => unknown) {
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
      await during();
    }
    return out;
  };
}

const post = (x: Harness, url: string, payload: Record<string, unknown>) =>
  x.app.inject({ method: 'POST', url, headers: H.automation, payload });
const calendarWindow = (x: Harness, events: unknown[]) =>
  post(x, '/api/v1/calendar/window', {
    source: 'test',
    window: {
      from: new Date(x.clock.now().getTime() - 3_600_000).toISOString(),
      to: new Date(x.clock.now().getTime() + 86_400_000).toISOString(),
      events,
    },
  });
const cpiAt = (x: Harness, ms: number) => ({
  id: 'cpi',
  title: 'US CPI',
  currency: 'USD',
  impact: 'HIGH',
  scheduledAt: new Date(x.clock.now().getTime() + ms).toISOString(),
});

async function boot() {
  const x = (h = await createHarness());
  await bringOnline(x);
  return { x, submit: vi.spyOn(x.runtime.execution.paper(), 'submitOrder') };
}
async function expectRefused(
  x: Harness,
  submit: { mock: { calls: unknown[] } },
  during: () => unknown,
  why: RegExp,
) {
  const d = await approve(x);
  holdFinalLedgerRead(x, during);
  const r = await execute(x, d.approval.approvalId);
  expect(r.outcome).toBe('REJECTED');
  expect(r.reasons.join()).toMatch(why);
  expect(submit.mock.calls).toHaveLength(0);
  expect((await x.runtime.repos.execution.accountExposure('paper-demo')).reservations).toHaveLength(
    0,
  );
}

describe.skipIf(!available)('API — final synchronous freshness guard (F003)', () => {
  it('quote and account inputs that age during the final ledger wait (approval TTL still valid)', async () => {
    const { x, submit } = await boot();
    await expectRefused(x, submit, () => x.clock.advance(8_000), /\[final-guard\]/);
  });

  it('the clock crosses into an event blackout during the final ledger wait (other inputs valid)', async () => {
    const { x, submit } = await boot();
    // HIGH event 15m03s ahead: the 15 min blackout begins 3s from now, so validation passes today.
    await calendarWindow(x, [cpiAt(x, 15 * 60_000 + 3_000)]);
    await expectRefused(
      x,
      submit,
      () => x.clock.advance(4_000), // quote 4s old (<5s limit), TTL 30s
      /\[final-guard\].*(US CPI|blackout)/i,
    );
  });

  it('a calendar window REVISED during the final wait (still OK and fresh) adds a HIGH event inside the blackout', async () => {
    const { x, submit } = await boot();
    await expectRefused(
      x,
      submit,
      () => calendarWindow(x, [cpiAt(x, 5 * 60_000)]),
      /\[final-guard\].*(US CPI|blackout)/i,
    );
  });

  it('a calendar revision that reschedules a far HIGH event into the blackout', async () => {
    const { x, submit } = await boot();
    await calendarWindow(x, [cpiAt(x, 3 * 3_600_000)]); // outside the blackout at validation
    await expectRefused(
      x,
      submit,
      () => calendarWindow(x, [cpiAt(x, 2 * 60_000)]),
      /\[final-guard\].*(US CPI|blackout)/i,
    );
  });

  it('news risk that turns HIGH during the final wait (status still OK)', async () => {
    const { x, submit } = await boot();
    await expectRefused(
      x,
      submit,
      () =>
        post(x, '/api/v1/news/items', {
          source: 'n8n',
          items: [
            {
              id: 'n1',
              headline: 'BREAKING: Fed announces surprise rate cut',
              publishedAt: x.clock.now().toISOString(),
            },
          ],
        }),
      /\[final-guard\].*news/i,
    );
  });

  it('positive path: a wait that keeps every input valid and unchanged submits exactly once', async () => {
    const { x, submit } = await boot();
    const d = await approve(x);
    holdFinalLedgerRead(x, () => x.clock.advance(500));
    const r = await execute(x, d.approval.approvalId);
    expect(r.outcome).toBe('CONFIRMED');
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
