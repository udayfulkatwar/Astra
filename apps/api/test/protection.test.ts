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
const get = async (harness: Harness, url: string) =>
  json(await harness.app.inject({ url, headers: H.operator }));
const REF = 'PAPER-DEMO-1';

async function openTrade(harness: Harness) {
  const r = json(
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: { candidate: candidate(harness), autoExecute: true },
    }),
  );
  expect(r.execution.outcome).toBe('CONFIRMED');
  await harness.runtime.cycle();
}

describe.skipIf(!available)('API — automatic protection (ADR-0014)', () => {
  it('near the daily loss limit: blocks the account, closes every position, audits it', async () => {
    h = await createHarness();
    await bringOnline(h);
    await openTrade(h); // LONG 5 MNQ; daily limit 2% of 50k = 1,000 (floor 49,000)

    // A realized loss elsewhere today: balance 49,100 → with the open trade > 90% of the limit.
    const paper = h.runtime.execution.paper();
    paper.importAccount(REF, { ...paper.exportAccount(REF), balance: 49_100 });
    await h.runtime.cycle();

    const m = await get(h, '/api/v1/monitor/positions');
    expect(m.protection).toMatchObject({ enabled: true, policy: { flattenAtLimitUsagePct: 90 } });
    expect(m.protection.recent[0]).toMatchObject({
      trigger: 'LIMIT_PROXIMITY',
      accountId: 'paper-demo',
      symbol: 'MNQ',
      outcome: 'CLOSED',
      attempt: 1,
    });
    expect(m.protection.recent[0].reason).toMatch(
      /daily loss limit 9\d\.\d% used \(flatten at 90%\)/,
    );
    expect(paper.closedTrades(REF).at(-1)).toMatchObject({
      exitReason: 'PROTECTIVE',
      symbol: 'MNQ',
    });

    const ks = (await get(h, '/api/v1/kill-switches')).switches as Json[];
    expect(ks.find((s) => s.scope === 'ACCOUNT' && s.target === 'paper-demo')).toMatchObject({
      active: true,
      clearPolicy: 'NEXT_TRADING_DAY',
      changedBy: { type: 'SYSTEM', id: 'protection' },
    });
    const events = (await get(h, '/api/v1/events?limit=50')).events as Json[];
    expect(events.find((e) => e.type === 'PROTECTIVE_CLOSE_CLOSED')).toMatchObject({
      level: 'CRITICAL',
      component: 'protection',
    });
    const audit = (await get(h, '/api/v1/audit?category=PROTECTION')).entries as Json[];
    expect(audit[0]).toMatchObject({ action: 'PROTECTIVE_CLOSE_CLOSED', actorId: 'protection' });
    expect((await get(h, '/api/v1/audit/verify')).ok).toBe(true);

    // Flat now, and nothing is sent again.
    await h.runtime.cycle();
    expect((await get(h, '/api/v1/monitor/positions')).protection.recent).toHaveLength(1);
    // New trades are refused by the account kill switch.
    const again = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(again.decision.status).toBe('REJECTED');
    expect(again.decision.reasons.join()).toMatch(/ACCOUNT kill switch/);
  });

  it('closes a position without a stop after the grace period', async () => {
    h = await createHarness();
    await bringOnline(h);
    await openTrade(h);
    const paper = h.runtime.execution.paper();
    const state = paper.exportAccount(REF);
    paper.importAccount(REF, {
      ...state,
      positions: state.positions.map((p) => ({ ...p, stopPrice: null })),
    });
    await h.runtime.cycle();
    expect((await get(h, '/api/v1/monitor/positions')).protection.recent).toEqual([]); // grace
    h.clock.advance(10_000);
    await h.runtime.cycle();
    expect((await get(h, '/api/v1/monitor/positions')).protection.recent[0]).toMatchObject({
      trigger: 'UNPROTECTED',
      outcome: 'CLOSED',
    });
    expect(paper.closedTrades(REF).at(-1)).toMatchObject({ exitReason: 'PROTECTIVE' });
  });

  it('never sends while an EXECUTION kill switch is active — asks for a human once', async () => {
    h = await createHarness();
    await bringOnline(h);
    await openTrade(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/activate',
      headers: H.operator,
      payload: { scope: 'EXECUTION', target: 'paper-demo', reason: 'broker acting up' },
    });
    const paper = h.runtime.execution.paper();
    paper.importAccount(REF, { ...paper.exportAccount(REF), balance: 49_100 });
    await h.runtime.cycle();
    await h.runtime.cycle();
    const recent = (await get(h, '/api/v1/monitor/positions')).protection.recent as Json[];
    expect(recent).toHaveLength(1); // reported once, not every cycle
    expect(recent[0]).toMatchObject({ outcome: 'SKIPPED', trigger: 'LIMIT_PROXIMITY' });
    expect(recent[0]!.detail).toMatch(/EXECUTION kill switch .* manual action required/);
    expect(paper.exportAccount(REF).positions).toHaveLength(1); // still open
  });
});
