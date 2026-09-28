import type { AiProvider, AiProviderRequest } from '@astra/ai';
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
  json(await harness.app.inject({ url, headers: H.viewer }));

const ANALYSIS = {
  verdict: 'SUPPORTS',
  confidence: 0.8,
  setupQuality: 70,
  eventRisk: 'LOW',
  reasons: ['Structure agrees with the signal.'],
  invalidation: ['A close below the stop.'],
};
const REVIEW = {
  process: 'GOOD',
  setupQuality: 70,
  entryQuality: 90,
  exitQuality: 80,
  ruleViolations: [],
  executionIssues: [],
  lessons: ['Plan followed.'],
  proposals: [{ parameter: 'minRewardToRisk', suggestion: 'keep 1.5', rationale: 'one trade' }],
  summary: 'Followed the plan and hit the target.',
};

/** A stand-in for the Anthropic adapter (real model calls are never made in tests). */
function model(analysis: Record<string, unknown> = ANALYSIS) {
  const seen: AiProviderRequest[] = [];
  const provider: AiProvider = {
    id: 'anthropic',
    kind: 'LIVE',
    complete: (req) => {
      seen.push(req);
      return Promise.resolve({
        text: JSON.stringify(req.task === 'TRADE_ANALYSIS' ? analysis : REVIEW),
        stop: 'COMPLETE',
        servedModel: 'claude-opus-5',
        fallbackUsed: false,
        usage: { inputTokens: 3_000, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
    },
  };
  return { providers: new Map([['anthropic', provider]]), seen };
}

const evaluate = (harness: Harness, payload: Json) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/v1/decisions/evaluate',
    headers: H.automation,
    payload,
  });
const aiCandidate = (harness: Harness, o: Json = {}) =>
  candidate(harness, { strategyId: 'paper-ai-test', timeframe: 'M1', ...o });

describe.skipIf(!available)('API — AI analysis layer', () => {
  it('analyses an AI-required signal before the gate, logs the call and approves on support', async () => {
    const m = model();
    h = await createHarness({ aiProviders: m.providers });
    await bringOnline(h);
    const r = json(await evaluate(h, { candidate: aiCandidate(h), autoExecute: false }));
    expect(r.decision.status).toBe('APPROVED');
    const check = r.decision.checks.find((c: Json) => c.checkId === 'ai.analysis');
    expect(check).toMatchObject({ verdict: 'PASS' });
    expect(check.reasons[0]).toContain('AI analysis SUPPORTS');

    // The model saw only data ASTRA holds, labelled; nothing about sizing or limits.
    expect(m.seen).toHaveLength(1);
    const brief = m.seen[0]!.input as Json;
    expect(brief.signal.symbol).toBe('MNQ');
    expect(brief.news.risk.status).toBe('OK');
    expect(brief.calendar.status).toBe('OK');
    expect(brief.plan).toEqual({ riskPoints: 10, rewardPoints: 20, rewardToRisk: 2 });
    expect(JSON.stringify(brief)).not.toMatch(/balance|drawdown|quantity/i);

    const status = await get(h, '/api/v1/ai/status');
    expect(status).toMatchObject({
      configured: true,
      enabled: true,
      standIn: false,
      killSwitchActive: false,
      serverSideFallbacks: true,
      usage: { calls: 1, costUsd: 0.03 }, // 3000×$5 + 600×$25 per million
    });
    expect(status.routes[0]).toMatchObject({
      task: 'TRADE_ANALYSIS',
      model: 'claude-opus-5',
      available: true,
      priced: true,
    });
    const { calls } = await get(h, '/api/v1/ai/calls');
    expect(calls[0]).toMatchObject({ status: 'OK', task: 'TRADE_ANALYSIS', costUsd: 0.03 });
    const { analyses } = await get(h, '/api/v1/ai/analyses');
    expect(analyses[0].analysis).toMatchObject({ verdict: 'SUPPORTS', model: 'claude-opus-5' });
    const detail = await get(h, `/api/v1/ai/analyses/${analyses[0].analysis.analysisId}`);
    expect(detail.brief.signal.id).toBe(brief.signal.id);

    // Spend survives a restart (the budget is not reset by restarting).
    h = await h.restart();
    expect((await get(h, '/api/v1/ai/status')).usage).toMatchObject({ calls: 1, costUsd: 0.03 });
  });

  it('vetoes: a conflicting analysis rejects the trade', async () => {
    h = await createHarness({
      aiProviders: model({ ...ANALYSIS, verdict: 'CONFLICTS', reasons: ['Trend is DOWN.'] })
        .providers,
    });
    await bringOnline(h);
    const r = json(await evaluate(h, { candidate: aiCandidate(h), autoExecute: false }));
    expect(r.decision.status).toBe('REJECTED');
    expect(r.decision.reasons).toContain('[ai.analysis] AI analysis conflicts: Trend is DOWN.');
  });

  it('no provider (no API key) means no trade — and the attempt is logged', async () => {
    h = await createHarness();
    await bringOnline(h);
    const r = json(await evaluate(h, { candidate: aiCandidate(h), autoExecute: false }));
    expect(r.decision.status).toBe('REJECTED');
    expect(r.decision.reasons.join(' ')).toContain('AI provider "anthropic" not available');
    const { calls } = await get(h, '/api/v1/ai/calls');
    expect(calls[0]).toMatchObject({ status: 'BLOCKED', blockedBy: 'NO_PROVIDER', costUsd: 0 });
    expect((await get(h, '/api/v1/ai/status')).health.status).toBe('ERROR');
    // Strategies that do not require AI are unaffected.
    const plain = json(await evaluate(h, { candidate: candidate(h), autoExecute: false }));
    expect(plain.decision.status).toBe('APPROVED');
  });

  it('asks the model only when every deterministic check passes; the AI kill switch stops calls', async () => {
    const m = model();
    h = await createHarness({ aiProviders: m.providers });
    // Nothing online yet: the deterministic checks already reject → no model call.
    const early = json(await evaluate(h, { candidate: aiCandidate(h), autoExecute: false }));
    expect(early.decision.status).toBe('REJECTED');
    expect(early.decision.reasons.join(' ')).toContain(
      'not requested: other checks already reject this candidate',
    );
    expect(m.seen).toHaveLength(0);

    await bringOnline(h);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/kill-switches/activate',
      headers: H.operator,
      payload: { scope: 'AI', reason: 'testing the AI kill switch' },
    });
    const killed = json(await evaluate(h, { candidate: aiCandidate(h), autoExecute: false }));
    expect(killed.decision.status).toBe('REJECTED');
    expect(m.seen).toHaveLength(0);
    const direct = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/ai/analyses',
        headers: H.automation,
        payload: { signal: aiCandidate(h).signal },
      }),
    );
    expect(direct.analysis).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'AI kill switch active',
    });
    expect(m.seen).toHaveLength(0);
  });

  it('reviews a journaled trade; proposals are stored for a human, never applied', async () => {
    h = await createHarness({ aiProviders: model().providers });
    await bringOnline(h);
    const r = json(await evaluate(h, { candidate: aiCandidate(h), autoExecute: true }));
    expect(r.execution.outcome).toBe('CONFIRMED');
    await h.runtime.cycle();
    h.clock.advance(30_000);
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
    const { entries } = await get(h, '/api/v1/journal?accountId=paper-demo');
    const tradeId = entries[0].tradeId as string;

    const denied = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ai/reviews',
      headers: H.automation,
      payload: { tradeId },
    });
    expect(denied.statusCode).toBe(403);
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ai/reviews',
      headers: H.operator,
      payload: { tradeId: 'nope' },
    });
    expect(missing.statusCode).toBe(404);

    const res = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/ai/reviews',
        headers: H.operator,
        payload: { tradeId },
      }),
    );
    expect(res.review).toMatchObject({
      tradeId,
      outcome: 'WIN',
      process: 'GOOD',
      classification: 'GOOD_WIN',
      proposals: [{ parameter: 'minRewardToRisk', status: 'PROPOSED' }],
    });
    expect((await get(h, `/api/v1/ai/reviews?tradeId=${tradeId}`)).reviews).toHaveLength(1);
    // The strategy is unchanged: proposals are never applied.
    expect(h.runtime.config.strategies.get('paper-ai-test')?.minRewardToRisk).toBe(1.5);
  });

  it('uses the SIMULATED stand-in in simulation mode when configured', async () => {
    h = await createHarness({ simulation: true });
    const status = await get(h, '/api/v1/ai/status');
    expect(status.standIn).toBe(true);
    expect(status.routes[0]).toMatchObject({
      provider: 'simulated',
      model: 'simulated-rules-v1',
      available: true,
      providerKind: 'SIMULATED',
    });
    expect(status.health.detail).toContain('not an AI model');
  });
});
