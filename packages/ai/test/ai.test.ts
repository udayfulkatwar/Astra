import { ManualClock, notObserved, observed, type Signal } from '@astra/core';
import type { JournalEntry } from '@astra/journal';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, SERVER_SIDE_FALLBACK_BETA } from '../src/anthropic';
import {
  AiOrchestrator,
  AiSettingsSchema,
  POST_TRADE_REVIEW,
  SIMULATED_MODEL,
  SimulatedAiProvider,
  TRADE_ANALYSIS,
  TradeAnalysisOutputSchema,
  buildTradeAnalysisBrief,
  callCostUsd,
  simulatedTradeAnalysis,
  toAiAnalysis,
  toTradeReview,
  type AiCallRecord,
  type AiProvider,
  type AiProviderResponse,
  type AiSettings,
  type TradeAnalysisBrief,
} from '../src';

const NOW = '2026-09-28T14:00:00.000Z';
const settings = (o: Partial<AiSettings> = {}): AiSettings =>
  AiSettingsSchema.parse({
    enabled: true,
    providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } },
    routes: {
      TRADE_ANALYSIS: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        effort: 'medium',
        maxOutputTokens: 8_000,
        timeoutMs: 5_000,
      },
      POST_TRADE_REVIEW: {
        provider: 'simulated',
        model: SIMULATED_MODEL,
        maxOutputTokens: 4_000,
        timeoutMs: 5_000,
      },
    },
    budget: { dailyCostUsd: 2, dailyCalls: 5 },
    prices: {
      'claude-opus-5': {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
      [SIMULATED_MODEL]: {
        inputPerMTok: 0,
        outputPerMTok: 0,
        cacheReadPerMTok: 0,
        cacheWritePerMTok: 0,
      },
    },
    ...o,
  });

const SIGNAL: Signal = {
  id: 'sig_1',
  strategyId: 'paper-ai-test',
  symbol: 'MNQ',
  direction: 'LONG',
  setupState: 'QUALIFIED',
  entryType: 'MARKET',
  entry: 18_000,
  stop: 17_990,
  target: 18_030,
  timeframe: 'M5',
  detectedAt: NOW,
  rationale: ['BOS on M5'],
  features: {},
};

const GOOD = JSON.stringify({
  verdict: 'SUPPORTS',
  confidence: 0.72,
  setupQuality: 68,
  eventRisk: 'LOW',
  reasons: ['Trend UP agrees with the LONG signal.'],
  invalidation: ['A close below 17990.'],
});
const USAGE = {
  inputTokens: 2_000,
  outputTokens: 500,
  cacheReadTokens: 1_000,
  cacheWriteTokens: 0,
};

function fake(
  answer: Partial<AiProviderResponse> | ((signal: AbortSignal) => Promise<AiProviderResponse>),
): AiProvider & { calls: number } {
  const p = {
    id: 'anthropic',
    kind: 'LIVE' as const,
    calls: 0,
    complete: (_req: unknown, signal: AbortSignal) => {
      p.calls += 1;
      if (typeof answer === 'function') return answer(signal);
      return Promise.resolve({
        text: GOOD,
        stop: 'COMPLETE' as const,
        servedModel: 'claude-opus-5',
        fallbackUsed: false,
        usage: USAGE,
        ...answer,
      });
    },
  };
  return p;
}

function setup(
  provider: AiProvider,
  o: { settings?: AiSettings; kill?: boolean; clock?: ManualClock } = {},
) {
  const clock = o.clock ?? new ManualClock(NOW);
  const log: AiCallRecord[] = [];
  let n = 0;
  const ai = new AiOrchestrator({
    clock,
    settings: o.settings ?? settings(),
    providers: new Map<string, AiProvider>([
      ['anthropic', provider],
      ['simulated', new SimulatedAiProvider()],
    ]),
    killSwitchActive: () => o.kill ?? false,
    record: (c) => {
      log.push(c);
    },
    newCallId: () => `aic_${++n}`,
  });
  return { ai, log, clock };
}

const brief = (o: Partial<TradeAnalysisBrief> = {}): TradeAnalysisBrief => ({
  ...buildTradeAnalysisBrief({
    now: new Date(NOW),
    mode: 'PAPER',
    signal: SIGNAL,
    bars: [],
    structure: null,
    newsRisk: notObserved('UNAVAILABLE', 'no feed', 'news'),
    sentiment: null,
    headlines: [],
    calendar: notObserved('UNAVAILABLE', 'no calendar', 'calendar'),
    limits: { recentBars: 30, maxHeadlines: 10 },
  }),
  ...o,
});

describe('AiOrchestrator', () => {
  it('returns validated output as OK context, logs the call and prices it', async () => {
    const { ai, log } = setup(fake({}));
    const { result, call } = await ai.run(TRADE_ANALYSIS, brief(), 'sig_1');
    expect(result).toMatchObject({
      status: 'OK',
      sourceKind: 'LIVE',
      source: 'ai:anthropic/claude-opus-5',
      value: { verdict: 'SUPPORTS', confidence: 0.72 },
    });
    // 2000×5 + 500×25 + 1000×0.5 per million = $0.023
    expect(call).toMatchObject({
      status: 'OK',
      subjectId: 'sig_1',
      costUsd: 0.023,
      blockedBy: null,
    });
    expect(callCostUsd(USAGE, settings().prices['claude-opus-5']!)).toBe(0.023);
    expect(log).toEqual([call]);
    expect(ai.usage()).toMatchObject({ calls: 1, costUsd: 0.023, reservedUsd: 0 });
    expect(ai.health().status).toBe('ONLINE');
  });

  it('never repairs output: bad JSON or a schema miss is INVALID', async () => {
    for (const text of ['not json', '{"verdict":"MAYBE"}', GOOD.replace('0.72', '1.5')]) {
      const { ai } = setup(fake({ text }));
      const { result, call } = await ai.run(TRADE_ANALYSIS, brief(), 'sig_1');
      expect(result.status).toBe('INVALID');
      expect(call.status).toBe('INVALID');
    }
  });

  it('reports refusals (after the server-side fallback) and truncation honestly', async () => {
    const refused = setup(
      fake({ text: '', stop: 'REFUSED', refusal: { category: 'cyber', explanation: null } }),
    );
    const r = await refused.ai.run(TRADE_ANALYSIS, brief(), 'sig_1');
    expect(r.result).toMatchObject({ status: 'UNAVAILABLE', reason: 'model declined (cyber)' });
    expect(r.call.status).toBe('REFUSED');

    const cut = setup(fake({ stop: 'TRUNCATED', text: GOOD.slice(0, 20) }));
    const t = await cut.ai.run(TRADE_ANALYSIS, brief(), 'sig_1');
    expect(t.result.status).toBe('INVALID');
    expect(t.call.status).toBe('TRUNCATED');
  });

  it('times out, aborts the request and charges the worst case', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const { ai } = setup(
        fake(
          (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
              });
            }),
        ),
      );
      const run = ai.run(TRADE_ANALYSIS, brief(), 'sig_1');
      await vi.advanceTimersByTimeAsync(5_000);
      const { result, call } = await run;
      expect(result.status).toBe('TIMEOUT');
      expect(aborted).toBe(true);
      expect(call).toMatchObject({ status: 'TIMEOUT', costEstimated: true });
      expect(call.costUsd).toBeGreaterThan(0.2); // 8000 output tokens × $25/M
      expect(ai.usage().costUsd).toBe(call.costUsd);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps provider errors to ERROR', async () => {
    const { ai } = setup(fake(() => Promise.reject(new Error('529 overloaded'))));
    const { result, call } = await ai.run(TRADE_ANALYSIS, brief(), 'sig_1');
    expect(result).toMatchObject({ status: 'ERROR', reason: '529 overloaded' });
    expect(call.costUsd).toBe(0);
  });

  it('blocks without calling the provider: kill switch, disabled, no provider, no price', async () => {
    const p = fake({});
    const kill = await setup(p, { kill: true }).ai.run(TRADE_ANALYSIS, brief(), 's');
    expect(kill.result).toMatchObject({ status: 'UNAVAILABLE', reason: 'AI kill switch active' });
    expect(kill.call).toMatchObject({ status: 'BLOCKED', blockedBy: 'KILL_SWITCH', costUsd: 0 });

    const off = await setup(p, { settings: settings({ enabled: false }) }).ai.run(
      TRADE_ANALYSIS,
      brief(),
      's',
    );
    expect(off.call.blockedBy).toBe('DISABLED');

    const noPrice = await setup(p, { settings: settings({ prices: {} }) }).ai.run(
      TRADE_ANALYSIS,
      brief(),
      's',
    );
    expect(noPrice.call.blockedBy).toBe('NO_PRICE');

    const clock = new ManualClock(NOW);
    const bare = new AiOrchestrator({
      clock,
      settings: settings(),
      providers: new Map(),
      killSwitchActive: () => false,
      newCallId: () => 'aic_x',
    });
    expect((await bare.run(TRADE_ANALYSIS, brief(), 's')).call.blockedBy).toBe('NO_PROVIDER');
    expect(bare.health()).toMatchObject({ status: 'ERROR' });
    expect(p.calls).toBe(0);
  });

  it('enforces the daily call and worst-case cost limits, and resets on a new UTC day', async () => {
    const p = fake({});
    const s = settings({ budget: { dailyCostUsd: 2, dailyCalls: 2, degradeAt: 0.8 } });
    const { ai, clock } = setup(p, { settings: s });
    await ai.run(TRADE_ANALYSIS, brief(), 'a');
    await ai.run(TRADE_ANALYSIS, brief(), 'b');
    const third = await ai.run(TRADE_ANALYSIS, brief(), 'c');
    expect(third.call.blockedBy).toBe('BUDGET');
    expect(ai.health().status).toBe('DEGRADED');

    clock.advance(24 * 3_600_000);
    expect((await ai.run(TRADE_ANALYSIS, brief(), 'd')).call.status).toBe('OK');

    // Worst case of one call (8000 output tokens at $25/M = $0.20 + input) vs a $0.10 limit.
    const tight = setup(p, {
      settings: settings({ budget: { dailyCostUsd: 0.1, dailyCalls: 100, degradeAt: 0.8 } }),
    });
    const r = await tight.ai.run(TRADE_ANALYSIS, brief(), 'e');
    expect(r.call.blockedBy).toBe('BUDGET');
    expect(r.call.error).toContain('would be exceeded');
  });

  it('restores today’s spend after a restart', async () => {
    const { ai } = setup(fake({}));
    ai.seedUsage({ day: '2026-09-28', calls: 5, costUsd: 1 });
    expect((await ai.run(TRADE_ANALYSIS, brief(), 'x')).call.blockedBy).toBe('BUDGET');
    ai.seedUsage({ day: '2026-09-27', calls: 0, costUsd: 0 });
    expect(ai.usage().calls).toBe(5); // another day's figures are ignored
  });

  it('reports a failing call-log sink instead of hiding it', async () => {
    const errors: string[] = [];
    const ai = new AiOrchestrator({
      clock: new ManualClock(NOW),
      settings: settings(),
      providers: new Map([['anthropic', fake({})]]),
      killSwitchActive: () => false,
      record: () => Promise.reject(new Error('db down')),
      onRecordError: (e) => errors.push((e as Error).message),
      newCallId: () => 'aic_1',
    });
    expect((await ai.run(TRADE_ANALYSIS, brief(), 'x')).result.status).toBe('OK');
    expect(errors).toEqual(['db down']);
  });
});

describe('trade analysis brief and stand-in', () => {
  it('labels missing data instead of filling it in', () => {
    const b = brief();
    expect(b.structure).toMatchObject({ status: 'UNAVAILABLE' });
    expect(b.bars).toMatchObject({ status: 'UNAVAILABLE' });
    expect(b.calendar).toMatchObject({ status: 'UNAVAILABLE' });
    expect(b.plan).toEqual({ riskPoints: 10, rewardPoints: 30, rewardToRisk: 3 });
    expect(b.dataKinds).toEqual([]);
    const out = simulatedTradeAnalysis(b);
    expect(out.reasons[0]).toContain('not an AI model');
    expect(out.eventRisk).toBe('MEDIUM'); // unknown calendar and news
    expect(out.confidence).toBeLessThan(0.6);
    expect(TradeAnalysisOutputSchema.parse(out)).toEqual(out);
  });

  it('keeps only events for the instrument and marks data kinds', () => {
    const b = buildTradeAnalysisBrief({
      now: new Date(NOW),
      mode: 'PAPER',
      signal: SIGNAL,
      bars: [],
      structure: null,
      newsRisk: observed(
        { symbol: 'MNQ', level: 'HIGH', assessedAt: NOW, reasons: ['Fed headline'] },
        { source: 'sim', sourceKind: 'SIMULATED', asOf: NOW },
      ),
      sentiment: null,
      headlines: [],
      calendar: observed(
        {
          from: NOW,
          to: '2026-09-28T16:00:00.000Z',
          events: [
            {
              id: '1',
              title: 'FOMC',
              impact: 'HIGH',
              scheduledAt: '2026-09-28T14:30:00.000Z',
              affectedInstruments: ['MNQ'],
            },
            {
              id: '2',
              title: 'ECB',
              impact: 'HIGH',
              scheduledAt: '2026-09-28T14:30:00.000Z',
              affectedInstruments: ['DAX'],
            },
          ],
        },
        { source: 'cal', sourceKind: 'SIMULATED', asOf: NOW },
      ),
      limits: { recentBars: 30, maxHeadlines: 10 },
    });
    expect(b.calendar.status === 'OK' && b.calendar.value.events.map((e) => e.title)).toEqual([
      'FOMC',
    ]);
    expect(b.dataKinds).toEqual(['SIMULATED']);
    expect(simulatedTradeAnalysis(b).eventRisk).toBe('HIGH');
  });

  it('agrees or conflicts with the observed structure', () => {
    const structure = (trend: 'UP' | 'DOWN') =>
      brief({
        structure: observed(
          {
            timeframe: 'M5',
            trend,
            lastClose: 18_000,
            lastBreak: {
              type: 'BOS',
              direction: trend === 'UP' ? 'BULLISH' : 'BEARISH',
              level: 17_995,
              at: NOW,
            },
            nearestLiquidityAbove: null,
            nearestLiquidityBelow: null,
            recentSweeps: [],
            openGaps: [],
          },
          { source: 'astra-structure', sourceKind: 'SIMULATED', asOf: NOW },
        ),
      });
    expect(simulatedTradeAnalysis(structure('UP'))).toMatchObject({ verdict: 'SUPPORTS' });
    expect(simulatedTradeAnalysis(structure('DOWN'))).toMatchObject({ verdict: 'CONFLICTS' });
  });

  it('maps output to the gate’s AiAnalysis', () => {
    const a = toAiAnalysis(TradeAnalysisOutputSchema.parse(JSON.parse(GOOD)), {
      analysisId: 'aia_1',
      signalId: 'sig_1',
      model: 'claude-opus-5',
      producedAt: NOW,
    });
    expect(a).toMatchObject({ analysisId: 'aia_1', signalId: 'sig_1', verdict: 'SUPPORTS' });
  });
});

describe('post-trade review', () => {
  const trade = (o: Partial<JournalEntry> = {}): JournalEntry => ({
    tradeId: 'trd_1',
    accountId: 'paper-demo',
    source: 'ASTRA',
    strategyId: 'paper-ai-test',
    signalId: 'sig_1',
    decisionId: 'dec_1',
    mode: 'PAPER',
    symbol: 'MNQ',
    direction: 'LONG',
    quantity: 1,
    plan: {
      entry: 18_000,
      stop: 17_990,
      target: 18_030,
      quantity: 1,
      rewardToRisk: 3,
      plannedRisk: 20,
      decidedAt: NOW,
      configHash: 'h',
    },
    entry: { price: 18_000.5, at: NOW, slippageTicks: 2 },
    exit: { price: 17_990, at: NOW, reason: 'STOP', slippageTicks: 0 },
    durationSec: 600,
    result: {
      grossPnl: -21,
      costs: 1,
      costsSource: 'INSTRUMENT_SPEC',
      netPnl: -22,
      initialRisk: 21,
      rMultiple: -1,
      outcome: 'LOSS',
    },
    excursion: null,
    exitedAsPlanned: true,
    ...o,
  });

  it('classifies process separately from outcome and keeps proposals as PROPOSED', async () => {
    const { ai } = setup(fake({}));
    const t = trade();
    const { result, call } = await ai.run(
      POST_TRADE_REVIEW,
      { briefVersion: 1, trade: t, gate: null, analysis: null },
      t.tradeId,
    );
    expect(call).toMatchObject({ provider: 'simulated', servedModel: SIMULATED_MODEL });
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    const review = toTradeReview(result.value, t, {
      reviewId: 'air_1',
      model: SIMULATED_MODEL,
      provider: 'simulated',
      sourceKind: 'SIMULATED',
      producedAt: NOW,
    });
    expect(review).toMatchObject({ outcome: 'LOSS', process: 'GOOD', classification: 'GOOD_LOSS' });

    const slipped = trade({ entry: { price: 18_002, at: NOW, slippageTicks: 8 } });
    const r2 = await ai.run(
      POST_TRADE_REVIEW,
      { briefVersion: 1, trade: slipped, gate: null, analysis: null },
      'trd_2',
    );
    if (r2.result.status !== 'OK') throw new Error('expected OK');
    const review2 = toTradeReview(r2.result.value, slipped, {
      reviewId: 'air_2',
      model: SIMULATED_MODEL,
      provider: 'simulated',
      sourceKind: 'SIMULATED',
      producedAt: NOW,
    });
    expect(review2.classification).toBe('POOR_LOSS');
    expect(review2.proposals).toEqual([expect.objectContaining({ status: 'PROPOSED' })]);
  });
});

describe('AnthropicProvider (offline, injected fetch)', () => {
  function server(body: Record<string, unknown>) {
    const seen: { url: string; headers: Headers; body: any }[] = [];
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: input instanceof Request ? input.url : input.toString(),
        headers: new Headers(init?.headers),
        body: JSON.parse(init?.body as string),
      });
      const res = new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: GOOD }],
          stop_reason: 'end_turn',
          stop_details: null,
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 0,
          },
          ...body,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      return Promise.resolve(res);
    }) as typeof globalThis.fetch;
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      maxRetries: 0,
      serverSideFallbacks: true,
      fetch,
    });
    return { provider, seen };
  }
  const request = {
    task: 'TRADE_ANALYSIS' as const,
    model: 'claude-opus-5',
    effort: 'medium' as const,
    maxOutputTokens: 8_000,
    system: TRADE_ANALYSIS.system,
    prompt: 'Analyse',
    input: {},
    outputSchema: TradeAnalysisOutputSchema,
  };

  it('sends structured output, effort, cached instructions and default fallbacks', async () => {
    const { provider, seen } = server({});
    const res = await provider.complete(request, new AbortController().signal);
    expect(res).toMatchObject({
      text: GOOD,
      stop: 'COMPLETE',
      servedModel: 'claude-opus-5',
      fallbackUsed: false,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 },
    });
    const [call] = seen;
    expect(call!.url).toContain('/v1/messages');
    expect(call!.headers.get('anthropic-beta')).toContain(SERVER_SIDE_FALLBACK_BETA);
    expect(call!.headers.get('x-api-key')).toBe('test-key');
    expect(call!.body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 8_000,
      fallbacks: 'default',
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Analyse' }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(call!.body.betas).toBeUndefined(); // sent as a header, not in the body
    expect(call!.body.output_config.format.schema.properties.verdict).toBeDefined();
  });

  it('reports refusal, truncation and a fallback-served answer', async () => {
    const refusal = await server({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
    }).provider.complete(request, new AbortController().signal);
    expect(refusal).toMatchObject({
      stop: 'REFUSED',
      text: '',
      refusal: { category: 'cyber', explanation: 'declined' },
    });

    const cut = await server({ stop_reason: 'max_tokens' }).provider.complete(
      request,
      new AbortController().signal,
    );
    expect(cut.stop).toBe('TRUNCATED');

    const fb = await server({
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        iterations: [
          { type: 'fallback_message', input_tokens: 5, output_tokens: 5 },
          { type: 'message', input_tokens: 5, output_tokens: 5 },
        ],
      },
    }).provider.complete(request, new AbortController().signal);
    expect(fb).toMatchObject({ servedModel: 'claude-opus-4-8', fallbackUsed: true });
  });
});
