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

describe.skipIf(!available)('API — access control and liveness', () => {
  it('serves liveness and readiness', async () => {
    h = await createHarness();
    expect((await h.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    const ready = await h.app.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(json(ready)).toMatchObject({ ready: true, initialized: true });
  });

  it('requires a valid token and the right role', async () => {
    h = await createHarness();
    expect((await h.app.inject({ url: '/api/v1/system/status' })).statusCode).toBe(401);
    expect(
      (
        await h.app.inject({
          url: '/api/v1/system/status',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await h.app.inject({ url: '/api/v1/system/status', headers: H.viewer })).statusCode,
    ).toBe(200);
    const denied = await h.app.inject({
      method: 'POST',
      url: '/api/v1/system/mode',
      headers: H.automation,
      payload: { mode: 'HALTED', reason: 'test' },
    });
    expect(denied.statusCode).toBe(403);
    const viewerKs = await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/activate',
      headers: H.viewer,
      payload: { scope: 'GLOBAL', reason: 'x y z' },
    });
    expect(viewerKs.statusCode).toBe(403);
  });

  it('validates request bodies', async () => {
    h = await createHarness();
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: { candidate: { accountId: 'paper-demo' } },
    });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.code).toBe('VALIDATION');
  });
});

describe.skipIf(!available)('API — fail-closed status', () => {
  it('reports trading disabled until every required input is online', async () => {
    h = await createHarness();
    await h.runtime.cycle();
    const s = json(await h.app.inject({ url: '/api/v1/system/status', headers: H.viewer }));
    expect(s.mode).toBe('PAPER');
    expect(s.trading.enabled).toBe(false);
    expect(s.trading.reasons.join()).toMatch(/MARKET_DATA UNKNOWN/);
    expect(s.trading.reasons.join()).toMatch(/AUTOMATION UNKNOWN/);
    await bringOnline(h);
    const s2 = json(await h.app.inject({ url: '/api/v1/system/status', headers: H.viewer }));
    expect(s2.trading).toEqual({ enabled: true, reasons: [] });
    expect(s2.system).toBe('ONLINE');
  });

  it('rejects candidates while inputs are missing, listing every reason', async () => {
    h = await createHarness();
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r.decision.status).toBe('REJECTED');
    expect(r.persisted).toBe(true);
    const failed = r.decision.checks
      .filter((c: Json) => c.verdict !== 'PASS')
      .map((c: Json) => c.checkId);
    expect(failed).toEqual(
      expect.arrayContaining(['system.component-health', 'data.quote', 'calendar.event-blackout']),
    );
  });
});

describe.skipIf(!available)('API — paper trading end to end', () => {
  it('approves, auto-executes in PAPER, tracks the position, records the close, and keeps the audit chain valid', async () => {
    h = await createHarness();
    await bringOnline(h);

    const c = candidate(h);
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: c, autoExecute: true },
      }),
    );
    expect(r.decision.reasons).toEqual([]);
    expect(r.decision.status).toBe('APPROVED');
    // 0.25% × 50k = 125; MNQ: 40 ticks + 2 slippage = 42 × $0.50 + $1.50 = $22.50/contract → 5
    expect(r.decision.orderPlan).toMatchObject({ symbol: 'MNQ', quantity: 5, entry: 20_000.25 });
    expect(r.execution.outcome).toBe('CONFIRMED');

    // The same signal cannot be approved twice.
    const dup = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: c },
      }),
    );
    expect(dup.decision.status).toBe('REJECTED');
    expect(dup.decision.reasons.join()).toMatch(/already approved/);

    await h.runtime.cycle();
    const acct = json(
      await h.app.inject({ url: '/api/v1/accounts/paper-demo', headers: H.viewer }),
    );
    expect(acct.snapshot.value.openPositions).toHaveLength(1);
    expect(acct.state.openRisk.complete).toBe(true);
    expect(acct.orders[0]).toMatchObject({ status: 'FILLED', quantity: 5 });
    expect(acct.account.broker.credentialsEnv).toBeUndefined();

    // Price reaches the target → paper broker closes → closed trade recorded on the next cycle.
    h.clock.advance(1_000);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/market/quotes',
      headers: H.automation,
      payload: {
        source: 'test',
        quotes: [{ symbol: 'MNQ', bid: 20_021, ask: 20_021.25, asOf: h.clock.now().toISOString() }],
      },
    });
    await h.runtime.cycle();
    const after = json(
      await h.app.inject({ url: '/api/v1/accounts/paper-demo', headers: H.viewer }),
    );
    expect(after.closedTrades[0]).toMatchObject({ exitReason: 'TARGET', symbol: 'MNQ' });
    expect(after.closedTrades[0].realizedPnl).toBe(200); // 20 pts × $2/pt × 5

    const events = json(
      await h.app.inject({ url: '/api/v1/events?limit=50', headers: H.viewer }),
    ).events.map((e: Json) => e.type);
    expect(events).toEqual(
      expect.arrayContaining([
        'DECISION_APPROVED',
        'EXECUTION_CONFIRMED',
        'POSITION_CLOSED',
        'STARTED',
      ]),
    );

    const decisions = json(
      await h.app.inject({ url: '/api/v1/decisions?status=APPROVED', headers: H.viewer }),
    ).decisions;
    const detail = json(
      await h.app.inject({
        url: `/api/v1/decisions/${decisions[0].decisionId}`,
        headers: H.viewer,
      }),
    );
    expect(detail.inputs.candidate.signal.id).toBe(c.signal.id);
    expect(detail.approvalState).toBe('CONSUMED');

    const verify = json(await h.app.inject({ url: '/api/v1/audit/verify', headers: H.operator }));
    expect(verify.ok).toBe(true);
    expect(verify.checked).toBeGreaterThan(3);
  });

  it('never auto-executes when the operator did not ask and requires an operator for manual execution', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r.decision.status).toBe('APPROVED');
    expect(r.execution).toBeNull();
    const byAutomation = await h.app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: H.automation,
      payload: { approvalId: r.decision.approval.approvalId },
    });
    expect(byAutomation.statusCode).toBe(403);
    const byOperator = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/executions',
        headers: H.operator,
        payload: { approvalId: r.decision.approval.approvalId },
      }),
    );
    expect(byOperator.outcome).toBe('CONFIRMED');
  });

  it('rejects an approval that has expired before execution', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    h.clock.advance(31_000);
    const exec = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/executions',
        headers: H.operator,
        payload: { approvalId: r.decision.approval.approvalId },
      }),
    );
    expect(exec.outcome).toBe('REJECTED');
    expect(exec.reasons.join()).toMatch(/expired/);
  });
});

describe.skipIf(!available)('API — human overrides and safety gates', () => {
  it('a GLOBAL kill switch blocks decisions until an operator clears it', async () => {
    h = await createHarness();
    await bringOnline(h);
    const act = await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/activate',
      headers: H.operator,
      payload: { scope: 'GLOBAL', reason: 'operator emergency stop' },
    });
    expect(json(act)).toMatchObject({ persisted: true, state: { active: true } });
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r.decision.status).toBe('REJECTED');
    expect(r.decision.reasons.join()).toMatch(/operator emergency stop/);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/deactivate',
      headers: H.operator,
      payload: { scope: 'GLOBAL', reason: 'resolved' },
    });
    const r2 = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r2.decision.status).toBe('APPROVED');
  });

  it('refuses LIVE mode without environment authorization; HALTED blocks decisions', async () => {
    h = await createHarness();
    await bringOnline(h);
    const live = await h.app.inject({
      method: 'POST',
      url: '/api/v1/system/mode',
      headers: H.operator,
      payload: { mode: 'LIVE', reason: 'try live' },
    });
    expect(live.statusCode).toBe(403);
    const halt = await h.app.inject({
      method: 'POST',
      url: '/api/v1/system/mode',
      headers: H.operator,
      payload: { mode: 'HALTED', reason: 'end of day' },
    });
    expect(json(halt).mode).toBe('HALTED');
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r.decision.reasons.join()).toMatch(/mode HALTED/);
  });

  it('SHADOW: decisions use only LIVE-sourced data, so ingested (MANUAL) quotes are refused', async () => {
    h = await createHarness();
    await bringOnline(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/system/mode',
      headers: H.operator,
      payload: { mode: 'SHADOW', reason: 'shadow test' },
    });
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r.decision.status).toBe('REJECTED');
    expect(r.decision.checks.find((c: Json) => c.checkId === 'data.source-kinds').verdict).toBe(
      'FAIL',
    );
  });

  it('stale market data → NO TRADE', async () => {
    h = await createHarness();
    await bringOnline(h);
    h.clock.advance(10_000); // quote freshness limit is 5 s
    await h.runtime.cycle();
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r.decision.status).toBe('REJECTED');
    expect(r.decision.checks.find((c: Json) => c.checkId === 'data.quote').verdict).not.toBe(
      'PASS',
    );
  });

  it('n8n heartbeat going silent → automation UNKNOWN → NO TRADE', async () => {
    h = await createHarness();
    await bringOnline(h);
    h.clock.advance(181_000); // AUTOMATION stale after 180 s
    const at = h.clock.now().toISOString();
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/market/quotes',
      headers: H.automation,
      payload: {
        source: 'test',
        quotes: [{ symbol: 'MNQ', bid: 20_000, ask: 20_000.25, asOf: at }],
      },
    });
    await h.runtime.cycle();
    const status = json(await h.app.inject({ url: '/api/v1/system/status', headers: H.viewer }));
    expect(status.automation.status).toBe('UNKNOWN');
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(r.decision.reasons.join()).toMatch(/AUTOMATION is UNKNOWN/);
  });
});

describe.skipIf(!available)('API — recovery', () => {
  it('restores mode, kill switches and paper positions after a restart', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h), autoExecute: true },
      }),
    );
    expect(r.execution.outcome).toBe('CONFIRMED');
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/activate',
      headers: H.operator,
      payload: { scope: 'STRATEGY', target: 'paper-pipeline-test', reason: 'pause strategy' },
    });
    await h.runtime.execution.flush();

    h = await h.restart();
    expect(h.runtime.isInitialized()).toBe(true);
    const ks = json(await h.app.inject({ url: '/api/v1/kill-switches', headers: H.viewer }));
    expect(ks.switches.find((s: Json) => s.scope === 'STRATEGY')).toMatchObject({
      active: true,
      reason: 'pause strategy',
    });
    const snap = await h.runtime.execution.paper().getAccountSnapshot('PAPER-DEMO-1', 'paper-demo');
    expect(snap.openPositions).toHaveLength(1);
    expect(snap.openPositions[0]).toMatchObject({
      symbol: 'MNQ',
      quantity: 5,
      stopPrice: 19_990.25,
    });
  });
});
