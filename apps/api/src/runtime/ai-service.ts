/**
 * AI analysis layer in the server (Phase 6, ADR-0020): builds briefs from the data ASTRA holds,
 * runs tasks through the orchestrator, stores analyses/reviews and serves the gate's
 * `aiAnalysis` port. AI output is CONTEXT: the gate can use it to veto, never to approve.
 */
import {
  AiOrchestrator,
  AiSettingsSchema,
  POST_TRADE_REVIEW,
  SIMULATED_MODEL,
  SimulatedAiProvider,
  TRADE_ANALYSIS,
  aiSignalKey as signalKey,
  aiStatusView,
  buildTradeAnalysisBrief,
  standInHealth,
  standInSettings,
  toAiAnalysis,
  toTradeReview,
  type AiCallRecord,
  type AiProvider,
  type AiSettings,
  type AiTradeReview,
} from '@astra/ai';
import type { CalendarService } from '@astra/calendar';
import {
  AstraError,
  errorMessage,
  newId,
  notObserved,
  observed,
  type AiAnalysis,
  type Clock,
  type HealthStatus,
  type Observed,
  type Signal,
} from '@astra/core';
import type { AstraConfig } from '@astra/config';
import type { AiRepository, DecisionRepository, JournalRepository } from '@astra/db';
import type { JournalEntry } from '@astra/journal';
import { TimeframeSchema, type MarketDataService } from '@astra/market-data';
import { analyzeStructure } from '@astra/market-structure';
import type { NewsService } from '@astra/news';
import type { Logger } from 'pino';
import type { EventBus } from './event-bus';
import type { KillSwitchService } from './kill-switch-service';
import type { ModeService } from './mode-service';

/** Used when astra.yaml has no `ai:` block: every call is refused as DISABLED. */
const NOT_CONFIGURED: AiSettings = AiSettingsSchema.parse({
  enabled: false,
  routes: {
    TRADE_ANALYSIS: {
      provider: 'simulated',
      model: SIMULATED_MODEL,
      maxOutputTokens: 256,
      timeoutMs: 1_000,
    },
    POST_TRADE_REVIEW: {
      provider: 'simulated',
      model: SIMULATED_MODEL,
      maxOutputTokens: 256,
      timeoutMs: 1_000,
    },
  },
  budget: { dailyCostUsd: 1, dailyCalls: 1 },
  prices: {},
});

const MEMORY = 500;

export interface AiReviewResult {
  readonly review: AiTradeReview | null;
  readonly status: AiCallRecord['status'];
  readonly reason: string | null;
  readonly call: AiCallRecord;
}

export class AiService {
  readonly orchestrator: AiOrchestrator;
  readonly configured: boolean;
  readonly standIn: boolean;
  /** Latest attempt per signal key (OK or the reason it failed), newest last. */
  private readonly attempts = new Map<string, Observed<AiAnalysis>>();
  private readonly inflight = new Map<string, Promise<Observed<AiAnalysis>>>();

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      repo: AiRepository;
      journal: JournalRepository;
      decisions: DecisionRepository;
      market: MarketDataService;
      calendar: CalendarService;
      news: NewsService;
      mode: ModeService;
      killSwitches: KillSwitchService;
      events: EventBus;
      log: Logger;
      /** Real providers built at the composition root (keys read from the environment there). */
      providers: ReadonlyMap<string, AiProvider>;
      simulation: boolean;
    },
  ) {
    const configured = deps.config.system.ai;
    this.configured = configured !== undefined;
    this.standIn = Boolean(configured && deps.simulation && configured.standInWhenSimulating);
    const settings = !configured
      ? NOT_CONFIGURED
      : this.standIn
        ? standInSettings(configured)
        : configured;
    const providers = new Map(deps.providers);
    // The stand-in exists only in simulation mode (its output is SIMULATED either way).
    if (deps.simulation) providers.set('simulated', new SimulatedAiProvider());
    else providers.delete('simulated');
    this.orchestrator = new AiOrchestrator({
      clock: deps.clock,
      settings,
      providers,
      killSwitchActive: () => this.killSwitchActive(),
      record: (c) => deps.repo.recordCall(c),
      onRecordError: (err, c) => {
        deps.log.error({ err: errorMessage(err), callId: c.callId }, 'AI call log write failed');
        void deps.events.emit({
          level: 'ERROR',
          component: 'ai',
          type: 'AI_CALL_LOG_FAILED',
          message: `AI call ${c.callId} (${c.task}, ${c.status}) could not be logged: ${errorMessage(err)}`,
        });
      },
      newCallId: () => newId('aiCall'),
    });
  }

  /** Fail-closed: until kill switches are loaded, AI counts as switched off. */
  killSwitchActive(): boolean {
    const e = this.deps.killSwitches.evaluate({ requiresAi: true });
    return !e.loaded || e.blocking.some((s) => s.scope === 'AI');
  }

  /** Restores today's spend and the recent call log after a restart. */
  async load(): Promise<void> {
    const now = this.deps.clock.now();
    const day = now.toISOString().slice(0, 10);
    const usage = await this.deps.repo.usageSince(`${day}T00:00:00.000Z`);
    this.orchestrator.seedUsage({ day, ...usage }, await this.deps.repo.recentCalls(50));
  }

  health(): { status: HealthStatus; detail: string } {
    if (!this.configured) return { status: 'UNKNOWN', detail: 'AI not configured (no ai: block)' };
    const h = this.orchestrator.health();
    return this.standIn ? standInHealth(h) : h;
  }

  status() {
    return aiStatusView(this.orchestrator, {
      configured: this.configured,
      standIn: this.standIn,
      killSwitchActive: this.killSwitchActive(),
      health: this.health(),
      gate: {
        minConfidence: this.deps.config.system.decision.ai.minConfidence,
        maxAgeMs: this.deps.config.system.decision.freshness.aiAnalysisMaxAgeMs,
      },
    });
  }

  /** The gate's port: the latest analysis attempt for exactly this signal. */
  async analysisFor(signal: Signal): Promise<Observed<AiAnalysis>> {
    const key = signalKey(signal);
    const mem = this.attempts.get(key);
    if (mem) return mem;
    const stored = await this.deps.repo.latestAnalysis(key);
    return stored
      ? observed(stored.analysis, {
          source: stored.source,
          sourceKind: stored.sourceKind,
          asOf: stored.analysis.producedAt,
        })
      : notObserved('UNAVAILABLE', 'no AI analysis for this signal', 'ai');
  }

  /**
   * Analyses the signal unless a fresh OK analysis of it exists (one call per signal; concurrent
   * requests share it). Never rejects: failures come back as non-OK observations.
   */
  async ensureAnalysis(signal: Signal): Promise<Observed<AiAnalysis>> {
    const key = signalKey(signal);
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const existing = await this.analysisFor(signal);
        const maxAge = this.deps.config.system.decision.freshness.aiAnalysisMaxAgeMs;
        if (
          existing.status === 'OK' &&
          this.deps.clock.now().getTime() - Date.parse(existing.asOf) < maxAge / 2
        ) {
          return existing;
        }
        return await this.analyze(signal);
      } catch (err) {
        return this.remember(key, notObserved('ERROR', errorMessage(err), 'ai'));
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  /** Always runs a new analysis (operator/n8n request or a stale one). */
  async analyze(signal: Signal): Promise<Observed<AiAnalysis>> {
    const key = signalKey(signal);
    const brief = this.brief(signal);
    const { result, call } = await this.orchestrator.run(TRADE_ANALYSIS, brief, signal.id);
    let out: Observed<AiAnalysis>;
    if (result.status === 'OK') {
      const analysis = toAiAnalysis(result.value, {
        analysisId: newId('aiAnalysis'),
        signalId: signal.id,
        model: call.servedModel ?? call.model,
        producedAt: result.asOf,
      });
      // Stored before use: an analysis that cannot be audited is not used (fail-closed).
      await this.deps.repo.recordAnalysis({
        analysis,
        signalKey: key,
        callId: call.callId,
        source: result.source,
        sourceKind: result.sourceKind,
        brief,
      });
      out = { ...result, value: analysis };
    } else {
      out = result;
    }
    this.remember(key, out);
    await this.deps.events.emit({
      level: out.status === 'OK' ? 'INFO' : 'WARN',
      component: 'ai',
      type: `AI_ANALYSIS_${call.status}`,
      message:
        out.status === 'OK'
          ? `${signal.symbol} ${signal.direction} ${signal.id}: AI ${out.value.verdict} (confidence ${out.value.confidence}, event risk ${out.value.eventRisk}, ${out.value.model})`
          : `${signal.symbol} ${signal.direction} ${signal.id}: no usable AI analysis — ${out.status}: ${out.reason}`,
      data: { signalId: signal.id, callId: call.callId, costUsd: call.costUsd },
    });
    return out;
  }

  private remember(key: string, o: Observed<AiAnalysis>): Observed<AiAnalysis> {
    this.attempts.delete(key);
    this.attempts.set(key, o);
    if (this.attempts.size > MEMORY) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    return o;
  }

  private brief(signal: Signal) {
    const { config, market, news, calendar, mode, clock } = this.deps;
    const tf = TimeframeSchema.safeParse(signal.timeframe);
    const timeframe = tf.success ? tf.data : 'M5';
    const instrument = config.instruments.get(signal.symbol);
    const bars = market.bars(signal.symbol, timeframe);
    const limits = config.system.ai?.tradeAnalysis ?? { recentBars: 30, maxHeadlines: 10 };
    return buildTradeAnalysisBrief({
      now: clock.now(),
      mode: mode.current(),
      signal,
      bars,
      structure: instrument
        ? analyzeStructure({
            symbol: signal.symbol,
            timeframe,
            bars,
            tickSize: instrument.tickSize,
            params: config.system.structure,
          })
        : null,
      newsRisk: news.risk(signal.symbol),
      sentiment: news.sentiment(signal.symbol),
      headlines: news.list({ symbol: signal.symbol, limit: limits.maxHeadlines }),
      calendar: calendar.current(),
      limits,
    });
  }

  /** Post-trade review of one journaled trade. Proposals are stored, never applied. */
  async review(tradeId: string): Promise<AiReviewResult> {
    const trade = await this.deps.journal.get(tradeId);
    if (!trade) throw new AstraError('NOT_FOUND', `trade ${tradeId} is not in the journal`);
    const detail = trade.decisionId ? await this.deps.decisions.get(trade.decisionId) : null;
    const ai = detail?.inputs.aiAnalysis;
    const { result, call } = await this.orchestrator.run(
      POST_TRADE_REVIEW,
      {
        briefVersion: 1,
        trade,
        gate: detail
          ? {
              status: detail.decision.status,
              checks: detail.decision.checks.map((c) => ({
                checkId: c.checkId,
                verdict: c.verdict,
                reasons: c.reasons,
              })),
            }
          : null,
        analysis: ai?.status === 'OK' ? ai.value : null,
      },
      tradeId,
    );
    if (result.status !== 'OK') {
      await this.deps.events.emit({
        level: 'WARN',
        component: 'ai',
        type: `AI_REVIEW_${call.status}`,
        message: `trade ${tradeId}: no AI review — ${result.status}: ${result.reason}`,
        data: { tradeId, callId: call.callId },
      });
      return { review: null, status: call.status, reason: result.reason, call };
    }
    const review = toTradeReview(result.value, trade, {
      reviewId: newId('aiReview'),
      model: call.servedModel ?? call.model,
      provider: call.provider,
      sourceKind: result.sourceKind,
      producedAt: result.asOf,
    });
    await this.deps.repo.recordReview(review, call.callId);
    await this.deps.events.emit({
      level: 'INFO',
      component: 'ai',
      type: 'AI_REVIEW_OK',
      message: `trade ${tradeId} (${trade.symbol}): ${review.classification.replace('_', ' ').toLowerCase()}${review.proposals.length > 0 ? ` — ${review.proposals.length} proposal(s) for human review` : ''}`,
      data: { tradeId, reviewId: review.reviewId, callId: call.callId },
    });
    return { review, status: call.status, reason: null, call };
  }

  /** Journal hook: reviews new trades when `postTradeReview.auto` is on. Never rejects. */
  async onJournaled(entry: JournalEntry): Promise<void> {
    if (!this.orchestrator.settings.postTradeReview.auto) return;
    try {
      await this.review(entry.tradeId);
    } catch (err) {
      this.deps.log.error({ err: errorMessage(err), trade: entry.tradeId }, 'AI review failed');
    }
  }
}
