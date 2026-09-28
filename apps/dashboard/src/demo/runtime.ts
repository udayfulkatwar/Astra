/**
 * In-browser ASTRA demo runtime. Wires the REAL domain engines — prop-firm rules, risk,
 * kill switches, the decision gate, the paper broker and the execution gateway — together in
 * memory, exactly as the server does, but with SIMULATED prices, a simulated calendar, a
 * simulated n8n heartbeat and a simulated clock. Nothing here is presented as real market data.
 */
import {
  AiOrchestrator,
  POST_TRADE_REVIEW,
  SimulatedAiProvider,
  TRADE_ANALYSIS,
  aiSignalKey,
  aiStatusView,
  buildTradeAnalysisBrief,
  standInHealth,
  standInSettings,
  toAiAnalysis,
  toTradeReview,
  type AiStatusView,
  type AiTradeReview,
} from '@astra/ai';
import {
  COMPONENT_IDS,
  ManualClock,
  canonicalJson,
  marketStatus,
  newId,
  notObserved,
  observed,
  tradingDayWindow,
  valuationLookup,
  type AccountActivity,
  type AccountDefinition,
  type AccountSnapshot,
  type AiAnalysis,
  type CalendarWindow,
  type ComponentId,
  type Observed,
  type ObservedOk,
  type InstrumentSpec,
  type Quote,
  type Signal,
  type TradeCandidate,
  type TradingMode,
} from '@astra/core';
import {
  DecisionEngine,
  assembleDecisionInputs,
  decideAndRecord,
  type DecisionInputs,
  type DecisionRecorder,
  type TradeDecision,
} from '@astra/decision';
import {
  ExecutionGateway,
  InMemoryExecutionStore,
  PaperBrokerAdapter,
  isTerminal,
  type ExecutionResult,
} from '@astra/execution';
import {
  computeAccountState,
  initAccountTracking,
  updateAccountTracking,
  type AccountState,
  type AccountTracking,
} from '@astra/prop-firm';
import { CalendarService, SimulatedCalendarAdapter } from '@astra/calendar';
import {
  ExcursionTracker,
  buildJournalEntry,
  tradeContext,
  type JournalEntry,
} from '@astra/journal';
import { MarketDataService, TimeframeSchema, type MarketSnapshot } from '@astra/market-data';
import { analyzeStructure } from '@astra/market-structure';
import { DEFAULT_NEWS_RISK_RULE, NewsService, SimulatedNewsAdapter } from '@astra/news';
import {
  DEFAULT_MONITOR_POLICY,
  DEFAULT_PROTECTION_POLICY,
  MonitorAlertTracker,
  ProtectionEvaluator,
  classifyAccountHealth,
  monitorAccount,
  type AccountHealthAssessment,
  type AccountMonitorView,
  type ProtectionStatus,
  type ProtectiveAction,
  type ProtectiveActionRecord,
} from '@astra/risk';
import {
  ComponentHealthRegistry,
  KillSwitchRegistry,
  evaluateAccountHaltConditions,
  type Actor,
  type KillSwitchScope,
} from '@astra/safety';
import type { AuditEntry, ClosedTrade, ModeInfo, SystemEvent } from '../api/types';
import { loadDemoConfig, type DemoConfig } from './config';

type Level = SystemEvent['level'];

interface AccountEntry {
  snapshot: Observed<AccountSnapshot>;
  tracking: AccountTracking | null;
  state: AccountState | null;
  health: AccountHealthAssessment | null;
  activity: AccountActivity | null;
  error: string | null;
  syncedAt: string | null;
  closedSynced: number;
}

export interface DemoAiAnalysis {
  readonly analysis: AiAnalysis;
  readonly signalKey: string;
  readonly callId: string;
  readonly source: string;
  readonly sourceKind: 'SIMULATED';
  readonly brief: unknown;
}

export interface DemoDecisionRecord {
  readonly decision: TradeDecision;
  readonly inputs: DecisionInputs;
}

const GENESIS = 'sha256:genesis';
const TICK_MS = 250;
/** Simulated past the demo pre-runs so the scanner has bars (15+ trading days for ATR(14) on D1). */
const HISTORY_DAYS = 22;
/** The most recent part of that history is simulated minute by minute, the rest every 5 minutes. */
const HISTORY_DETAIL_MS = 2 * 86_400_000;
const SIM_SOURCE = { id: 'simulation', kind: 'SIMULATED' } as const;

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Start the simulated clock at real time when a market is open, else at the next weekday 10:00 New York. */
function demoStart(config: DemoConfig): Date {
  const now = new Date();
  const hours = [...config.instruments.values()]
    .map((i) => i.tradingHours)
    .filter((h) => h !== undefined);
  const open =
    hours.length > 0 &&
    hours.every((h) => {
      const s = marketStatus(now, h);
      return s.open && (s.minutesToClose ?? 0) > 120;
    });
  if (open) return now;
  const d = new Date(now);
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, 14, 0, 0),
    );
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    }).format(candidate);
    if (!['Sat', 'Sun'].includes(day) && candidate > now) return candidate;
  }
  return now;
}

export class DemoRuntime {
  readonly config: DemoConfig;
  readonly clock: ManualClock;
  readonly killSwitches: KillSwitchRegistry;
  readonly health: ComponentHealthRegistry;
  readonly paper: PaperBrokerAdapter;
  readonly store = new InMemoryExecutionStore();
  readonly gateway: ExecutionGateway;
  readonly decisions: DemoDecisionRecord[] = [];
  /** Trade journal (newest first) and the excursion tracker feeding it. */
  readonly journal: JournalEntry[] = [];
  private readonly excursions = new ExcursionTracker();
  readonly events: SystemEvent[] = [];
  readonly audit: AuditEntry[] = [];
  readonly closedTrades = new Map<string, ClosedTrade[]>();
  readonly accounts = new Map<string, AccountEntry>();
  /** The real market-data engine (quality monitor, bars, snapshots) fed by the simulator. */
  readonly market: MarketDataService;
  /** The real calendar engine, fed by the SIMULATED weekly schedule. */
  readonly calendarService: CalendarService;
  private readonly calendarAdapter = new SimulatedCalendarAdapter();
  /** The real news engine, fed by the SIMULATED placeholder feed. */
  readonly news: NewsService;
  private readonly newsAdapter = new SimulatedNewsAdapter();
  private newsPolledAt: number | null = null;
  /** Instruments traded by ACTIVE accounts: MARKET_DATA is ONLINE only when all are fresh. */
  readonly tradedSymbols: readonly string[];
  /**
   * AI layer: the real orchestrator routed to the SIMULATED stand-in (fixed rules, not an AI
   * model — the demo has no API key and never calls a model). Analyses/reviews newest first.
   */
  readonly ai: AiOrchestrator;
  readonly aiAnalyses: DemoAiAnalysis[] = [];
  readonly aiReviews: AiTradeReview[] = [];
  private readonly aiAttempts = new Map<string, Observed<AiAnalysis>>();

  private readonly engine = new DecisionEngine();
  private readonly prices = new Map<string, number>();
  /** Cached scheduled market state per symbol: valid while `fromMs <= t < untilMs`. */
  private readonly sessionCache = new Map<
    string,
    { open: boolean; fromMs: number; untilMs: number }
  >();
  private readonly listeners = new Set<(e: SystemEvent) => void>();
  private auditQueue: Promise<void> = Promise.resolve();
  private eventSeq = 0;
  private timers: number[] = [];
  mode: NonNullable<ModeInfo['state']>;

  constructor() {
    this.config = loadDemoConfig();
    const start = demoStart(this.config);
    const historyStart = new Date(start.getTime() - HISTORY_DAYS * 86_400_000);
    this.clock = new ManualClock(historyStart);
    const freshness = this.config.system.decision.freshness;
    this.market = new MarketDataService({
      clock: this.clock,
      instruments: this.config.instruments,
      sessions: this.config.system.sessions,
      freshness: { maxAgeMs: freshness.quoteMaxAgeMs, maxFutureSkewMs: freshness.maxFutureSkewMs },
      suspectCooldownMs: this.config.system.marketData?.suspectCooldownMs,
      maxBarsPerSeries: this.config.system.marketData?.maxBarsPerSeries,
      barCloseGraceMs: this.config.system.marketData?.barCloseGraceMs,
      observingSince: historyStart,
      onRejected: (source, reason) =>
        this.emit('WARN', 'market-data', 'QUOTE_REJECTED', `${source}: ${reason}`),
    });
    this.calendarService = new CalendarService({
      clock: this.clock,
      freshness: {
        maxAgeMs: freshness.calendarMaxAgeMs,
        maxFutureSkewMs: freshness.maxFutureSkewMs,
      },
      instruments: this.config.instruments,
      onChanges: (changes) => {
        for (const c of changes)
          this.emit(
            'INFO',
            'calendar',
            `CALENDAR_${c.type}`,
            `${c.type}: "${c.event.title}" at ${c.event.scheduledAt}`,
          );
      },
    });
    const traded = new Set<string>();
    for (const a of this.config.accounts.values())
      if (a.status === 'ACTIVE') for (const sym of a.instruments) traded.add(sym);
    this.tradedSymbols = [...traded].sort();
    const nc = this.config.system.news;
    this.news = new NewsService({
      clock: this.clock,
      freshness: { maxAgeMs: freshness.newsMaxAgeMs, maxFutureSkewMs: freshness.maxFutureSkewMs },
      instruments: new Map(
        [...this.config.instruments].map(([symbol, spec]) => [
          symbol,
          { eventCurrencies: spec.eventCurrencies, keywords: nc?.instrumentKeywords[symbol] },
        ]),
      ),
      risk: nc?.risk ?? DEFAULT_NEWS_RISK_RULE,
      retentionMs: (nc?.retentionHours ?? 48) * 3_600_000,
      onItems: (items) => {
        for (const n of items) {
          const hit = n.affected.map((a) => a.symbol).filter((s) => traded.has(s));
          if (n.impact === 'HIGH' && hit.length > 0)
            this.emit(
              'WARN',
              'news',
              'NEWS_HIGH_IMPACT',
              `HIGH-impact ${n.category.toLowerCase().replace('_', ' ')} news for ${hit.join(', ')}: "${n.item.headline}"`,
            );
        }
      },
    });
    this.historyQuotes = this.simulateHistory(historyStart, start);
    this.clock.set(start);
    this.killSwitches = new KillSwitchRegistry(this.clock);
    this.killSwitches.load([]);
    const aiConfig = this.config.system.ai;
    if (!aiConfig) throw new Error('config/astra.yaml has no ai: block');
    this.ai = new AiOrchestrator({
      clock: this.clock,
      settings: standInSettings(aiConfig),
      providers: new Map([['simulated', new SimulatedAiProvider()]]),
      killSwitchActive: () => this.aiKillSwitchActive(),
      newCallId: () => newId('aiCall'),
    });
    const staleness = this.config.system.health.staleAfterMs;
    this.health = new ComponentHealthRegistry(
      this.clock,
      Object.fromEntries(COMPONENT_IDS.map((c) => [c, { staleAfterMs: staleness[c] }])) as Record<
        ComponentId,
        { staleAfterMs: number }
      >,
    );
    this.paper = new PaperBrokerAdapter({
      id: 'paper',
      clock: this.clock,
      instruments: (s) => this.config.instruments.get(s),
    });
    for (const a of this.config.accounts.values()) {
      const profile = this.config.profiles.get(a.propFirmProfileId)!;
      this.paper.openAccount(a.broker.accountRef, profile.accountSize, a.currency);
      this.accounts.set(a.id, {
        snapshot: notObserved('UNKNOWN', 'account not synced yet', 'account-monitor'),
        tracking: null,
        state: null,
        health: null,
        activity: null,
        error: null,
        syncedAt: null,
        closedSynced: 0,
      });
      this.closedTrades.set(a.id, []);
    }
    this.mode = {
      mode: 'PAPER',
      version: 1,
      changedAt: start.toISOString(),
      changedBy: 'SYSTEM:demo',
      reason: 'demo starts in PAPER',
    };
    this.gateway = new ExecutionGateway({
      store: this.store,
      adapter: (id) => (id === this.paper.id ? this.paper : undefined),
      account: (id) => this.config.accounts.get(id),
      mode: () => this.mode.mode,
      killSwitches: (ctx) => this.killSwitches.evaluate(ctx),
      liveTradingEnvironmentAuthorized: () => false,
      onExecutionUnknown: (accountId, clientOrderId, reason) => {
        this.activateKillSwitch(
          'EXECUTION',
          accountId,
          `order ${clientOrderId} state unknown: ${reason}`,
          { type: 'SYSTEM', id: 'execution-gateway' },
        );
        return Promise.resolve();
      },
      clock: this.clock,
      confirmation: {
        timeoutMs: this.config.system.execution.confirmationTimeoutMs,
        pollIntervalMs: this.config.system.execution.confirmationPollIntervalMs,
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    });
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    this.health.report('DATABASE', 'ONLINE', 'in-browser demo store (not persisted)');
    this.heartbeat();
    this.refreshCalendar();
    this.refreshNews();
    this.feed();
    void this.syncAccounts();
    this.emit(
      'INFO',
      'system',
      'STARTED',
      `ASTRA demo started in PAPER mode — simulated clock ${this.clock.now().toISOString().slice(0, 16)}Z, SIMULATED prices`,
    );
    for (const w of this.config.warnings) this.emit('WARN', 'config', 'CONFIG_WARNING', w);
    this.emit(
      'INFO',
      'market-data',
      'SIMULATED_HISTORY',
      `demo pre-ran the price simulator over the past ${HISTORY_DAYS} simulated days (${this.historyQuotes} SIMULATED quotes) so the scanner has bars`,
    );
    this.timers.push(
      window.setInterval(() => this.clock.advance(TICK_MS), TICK_MS),
      window.setInterval(
        () => this.feed(),
        this.config.system.simulation?.quoteIntervalMs ?? 1_000,
      ),
      window.setInterval(() => void this.syncAccounts(), 1_000),
      window.setInterval(() => this.heartbeat(), 30_000),
      window.setInterval(() => this.refreshCalendar(), 60_000),
      window.setInterval(() => this.refreshNews(), 60_000),
    );
  }

  stop(): void {
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
  }

  /** Moves the simulated clock (e.g. to show a closed market). */
  jumpClock(to: Date): void {
    this.clock.set(to);
    this.emit(
      'WARN',
      'demo',
      'CLOCK_JUMP',
      `simulated clock moved to ${to.toISOString().slice(0, 16)}Z`,
    );
    // Simulated inputs keep reporting across simulated time (n8n would have kept beating).
    this.heartbeat();
    this.refreshCalendar();
    this.refreshNews();
    this.feed();
    void this.syncAccounts();
  }

  // ------------------------------------------------------------------ events and audit

  subscribe(fn: (e: SystemEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(
    level: Level,
    component: string,
    type: string,
    message: string,
    accountId: string | null = null,
    data: Record<string, unknown> = {},
  ): void {
    const e: SystemEvent = {
      seq: ++this.eventSeq,
      id: newId('event'),
      at: this.clock.now().toISOString(),
      level,
      component,
      type,
      message,
      accountId,
      data,
    };
    this.events.unshift(e);
    if (this.events.length > 500) this.events.pop();
    this.listeners.forEach((l) => l(e));
  }

  /** Hash-chained audit append (SHA-256 via Web Crypto), serialised like the database version. */
  appendAudit(entry: {
    actorType: string;
    actorId: string;
    category: string;
    action: string;
    entityType: string | null;
    entityId: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const at = this.clock.now().toISOString();
    this.auditQueue = this.auditQueue.then(async () => {
      const prevHash = this.audit[0]?.hash ?? GENESIS;
      const id = newId('event');
      const payload = JSON.parse(JSON.stringify(entry.payload)) as Record<string, unknown>;
      const hash = await sha256(`${prevHash}\n${canonicalJson({ id, at, ...entry, payload })}`);
      this.audit.unshift({ seq: this.audit.length + 1, id, at, ...entry, payload, prevHash, hash });
    });
    return this.auditQueue;
  }

  async verifyAudit(): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null }> {
    await this.auditQueue;
    let prev = GENESIS;
    const ordered = [...this.audit].reverse();
    for (const [i, a] of ordered.entries()) {
      const { seq: _s, prevHash, hash, ...rest } = a;
      const expected = await sha256(
        `${prev}\n${canonicalJson({ id: rest.id, at: rest.at, actorType: rest.actorType, actorId: rest.actorId, category: rest.category, action: rest.action, entityType: rest.entityType, entityId: rest.entityId, payload: rest.payload })}`,
      );
      if (prevHash !== prev || expected !== hash)
        return { ok: false, checked: i, brokenAtSeq: a.seq };
      prev = hash;
    }
    return { ok: true, checked: ordered.length, brokenAtSeq: null };
  }

  // ------------------------------------------------------------------ simulated inputs

  private heartbeat(): void {
    this.health.report('AUTOMATION', 'ONLINE', 'simulated n8n heartbeat (demo)');
  }

  /** SIMULATED random-walk quotes — a simulator, not market data — into the market-data engine. */
  private feed(): void {
    for (const quote of this.simulateQuotes(
      this.config.system.simulation?.quoteIntervalMs ?? 1_000,
    )) {
      this.paper.onQuote(quote);
      this.excursions.onQuote(quote);
    }
    this.market.advance();
    const h = this.market.feedHealth(this.tradedSymbols);
    this.health.report('MARKET_DATA', h.status, `${h.detail} (SIMULATED demo feed)`);
    const cal = this.calendarService.health();
    this.health.report('CALENDAR', cal.status, `${cal.detail} (SIMULATED demo schedule)`);
    const news = this.news.health();
    this.health.report('NEWS', news.status, `${news.detail} (SIMULATED demo feed)`);
    const ai = this.aiHealth();
    this.health.report('AI', ai.status, ai.detail);
  }

  // ------------------------------------------------------------------ AI layer (ADR-0020)

  aiKillSwitchActive(): boolean {
    return this.killSwitches.evaluate({ requiresAi: true }).blocking.some((s) => s.scope === 'AI');
  }

  aiHealth() {
    return standInHealth(this.ai.health());
  }

  aiStatus(): AiStatusView {
    return aiStatusView(this.ai, {
      configured: true,
      standIn: true,
      killSwitchActive: this.aiKillSwitchActive(),
      health: this.aiHealth(),
      gate: {
        minConfidence: this.config.system.decision.ai.minConfidence,
        maxAgeMs: this.config.system.decision.freshness.aiAnalysisMaxAgeMs,
      },
    });
  }

  /** The gate's port: the latest attempt for exactly this signal. */
  aiAnalysisFor(signal: Signal): Observed<AiAnalysis> {
    return (
      this.aiAttempts.get(aiSignalKey(signal)) ??
      notObserved('UNAVAILABLE', 'no AI analysis for this signal', 'ai')
    );
  }

  async analyzeSignal(signal: Signal): Promise<Observed<AiAnalysis>> {
    const key = aiSignalKey(signal);
    const tf = TimeframeSchema.safeParse(signal.timeframe);
    const timeframe = tf.success ? tf.data : 'M5';
    const instrument = this.config.instruments.get(signal.symbol);
    const bars = this.market.bars(signal.symbol, timeframe);
    const limits = this.config.system.ai?.tradeAnalysis ?? { recentBars: 30, maxHeadlines: 10 };
    const brief = buildTradeAnalysisBrief({
      now: this.clock.now(),
      mode: this.mode.mode,
      signal,
      bars,
      structure: instrument
        ? analyzeStructure({
            symbol: signal.symbol,
            timeframe,
            bars,
            tickSize: instrument.tickSize,
            params: this.config.system.structure,
          })
        : null,
      newsRisk: this.news.risk(signal.symbol),
      sentiment: this.news.sentiment(signal.symbol),
      headlines: this.news.list({ symbol: signal.symbol, limit: limits.maxHeadlines }),
      calendar: this.calendar(),
      limits,
    });
    const { result, call } = await this.ai.run(TRADE_ANALYSIS, brief, signal.id);
    let out: Observed<AiAnalysis>;
    if (result.status === 'OK') {
      const analysis = toAiAnalysis(result.value, {
        analysisId: newId('aiAnalysis'),
        signalId: signal.id,
        model: call.servedModel ?? call.model,
        producedAt: result.asOf,
      });
      this.aiAnalyses.unshift({
        analysis,
        signalKey: key,
        callId: call.callId,
        source: result.source,
        sourceKind: 'SIMULATED',
        brief,
      });
      if (this.aiAnalyses.length > 200) this.aiAnalyses.pop();
      out = { ...result, value: analysis };
    } else {
      out = result;
    }
    this.aiAttempts.set(key, out);
    this.emit(
      out.status === 'OK' ? 'INFO' : 'WARN',
      'ai',
      `AI_ANALYSIS_${call.status}`,
      out.status === 'OK'
        ? `${signal.symbol} ${signal.direction} ${signal.id}: AI ${out.value.verdict} (confidence ${out.value.confidence}, event risk ${out.value.eventRisk}, ${out.value.model} — SIMULATED stand-in)`
        : `${signal.symbol} ${signal.direction} ${signal.id}: no usable AI analysis — ${out.status}: ${out.reason}`,
    );
    return out;
  }

  async reviewTrade(tradeId: string) {
    const trade = this.journal.find((e) => e.tradeId === tradeId);
    if (!trade) return null;
    const record = this.decisions.find((d) => d.decision.decisionId === trade.decisionId);
    const ai = record?.inputs.aiAnalysis;
    const { result, call } = await this.ai.run(
      POST_TRADE_REVIEW,
      {
        briefVersion: 1,
        trade,
        gate: record
          ? {
              status: record.decision.status,
              checks: record.decision.checks.map((c) => ({
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
      return { review: null, status: call.status, reason: result.reason, call };
    }
    const review = toTradeReview(result.value, trade, {
      reviewId: newId('aiReview'),
      model: call.servedModel ?? call.model,
      provider: call.provider,
      sourceKind: result.sourceKind,
      producedAt: result.asOf,
    });
    this.aiReviews.unshift(review);
    this.emit(
      'INFO',
      'ai',
      'AI_REVIEW_OK',
      `trade ${tradeId} (${trade.symbol}): ${review.classification.replace('_', ' ').toLowerCase()} — SIMULATED stand-in`,
    );
    return { review, status: call.status, reason: null, call };
  }

  /**
   * One random-walk step for every simulated instrument whose market is open, ingested by the
   * market-data engine. The step size scales with the square root of the interval, so the walk
   * has the same volatility whether simulated per second or per minute.
   */
  private simulateQuotes(intervalMs: number): Quote[] {
    const sim = this.config.system.simulation;
    if (!sim) return [];
    const now = this.clock.now();
    const scale = Math.sqrt(intervalMs / sim.quoteIntervalMs);
    const sink = this.market.sink(SIM_SOURCE);
    const out: Quote[] = [];
    for (const [symbol, s] of Object.entries(sim.instruments)) {
      const spec = this.config.instruments.get(symbol);
      if (!spec || !this.scheduledOpen(symbol, spec, now)) continue; // closed markets do not quote
      const tick = spec.tickSize;
      const prev = this.prices.get(symbol) ?? s.startPrice;
      const steps = Math.round((Math.random() * 2 - 1) * s.volatilityTicks * scale);
      const mid = Math.max(tick, Math.round((prev + steps * tick) / tick) * tick);
      this.prices.set(symbol, mid);
      const quote: Quote = {
        symbol,
        bid: Number(mid.toFixed(10)),
        ask: Number((mid + s.spreadTicks * tick).toFixed(10)),
        asOf: now.toISOString(),
      };
      sink(quote);
      out.push(quote);
    }
    return out;
  }

  /** Scheduled market state, cached until the next open/close (a time-zone calculation). */
  private scheduledOpen(symbol: string, spec: InstrumentSpec, at: Date): boolean {
    if (!spec.tradingHours) return true;
    const t = at.getTime();
    const cached = this.sessionCache.get(symbol);
    if (cached && cached.fromMs <= t && t < cached.untilMs) return cached.open;
    const status = marketStatus(at, spec.tradingHours);
    const next = status.open ? status.nextClose : status.nextOpen;
    this.sessionCache.set(symbol, {
      open: status.open,
      fromMs: t,
      untilMs: next ? Date.parse(next) : Number.POSITIVE_INFINITY,
    });
    return status.open;
  }

  /**
   * Pre-runs the simulator over simulated past time, so bars, previous-day levels, session ranges
   * and ATR exist when the demo opens. Everything it produces is SIMULATED, like the live feed.
   */
  private simulateHistory(from: Date, to: Date): number {
    const sim = this.config.system.simulation;
    if (!sim) return 0;
    let quotes = 0;
    for (let t = from.getTime(); t < to.getTime();) {
      const step = to.getTime() - t > HISTORY_DETAIL_MS ? 5 * 60_000 : 60_000;
      this.clock.set(new Date(t));
      quotes += this.simulateQuotes(step).length;
      this.market.advance();
      t += step;
    }
    return quotes;
  }

  /** Injects one bad price tick (a feed glitch) to show the quote-quality guard. */
  injectBadTick(symbol: string): void {
    const spec = this.config.instruments.get(symbol);
    const last = this.market.latest(symbol);
    if (!spec || last.status !== 'OK') {
      this.emit('WARN', 'demo', 'BAD_TICK_SKIPPED', `no live ${symbol} quote to corrupt`);
      return;
    }
    const jump = (spec.maxQuoteJumpTicks ?? 100) * 3 * spec.tickSize;
    const bid = Number((last.value.bid + jump).toFixed(10));
    const ask = Number((last.value.ask + jump).toFixed(10));
    this.market.sink(SIM_SOURCE)({ symbol, bid, ask, asOf: this.clock.now().toISOString() });
    const q = this.market.quoteQuality(symbol);
    this.emit(
      'WARN',
      'market-data',
      'ABNORMAL_JUMP',
      `demo injected a bad ${symbol} tick: ${q.reason ?? 'quote rejected'}`,
    );
  }

  /** Account-currency specs from live quotes (the core's `marketValuation`). */
  private valued(currency: string) {
    return valuationLookup(this.config.instruments, currency, (symbol) => {
      const q = this.market.fresh(symbol);
      return q.status === 'OK' ? q.value : null;
    });
  }

  latestQuote(symbol: string): Observed<Quote> {
    return this.market.latest(symbol);
  }

  allQuotes(): ObservedOk<Quote>[] {
    return this.market.all();
  }

  snapshots(): MarketSnapshot[] {
    return this.market.snapshots();
  }

  /** Polls the SIMULATED schedule like the core's calendar poller (24 h back, 7 days ahead). */
  private refreshCalendar(): void {
    const now = this.clock.now().getTime();
    const window = this.calendarAdapter.window({
      from: new Date(now - 24 * 3_600_000),
      to: new Date(now + 7 * 24 * 3_600_000),
    });
    this.calendarService.ingest(window, this.calendarAdapter.id, this.calendarAdapter.kind);
  }

  calendar(): Observed<CalendarWindow> {
    return this.calendarService.current();
  }

  /** Polls the SIMULATED news feed like the core's news poller (6 h back on the first poll). */
  private refreshNews(): void {
    const now = this.clock.now().getTime();
    const since = this.newsPolledAt === null ? now - 6 * 3_600_000 : this.newsPolledAt - 5 * 60_000;
    this.news.ingest(
      { items: this.newsAdapter.itemsBetween(new Date(since), new Date(now)) },
      this.newsAdapter.id,
      this.newsAdapter.kind,
    );
    this.newsPolledAt = now;
  }

  /** Demo: a SIMULATED high-impact headline now — news risk turns HIGH and blocks new trades. */
  injectBreakingNews(): void {
    const item = this.newsAdapter.breaking(this.clock.now());
    this.news.ingest({ items: [item] }, this.newsAdapter.id, this.newsAdapter.kind);
    this.emit(
      'WARN',
      'demo',
      'BREAKING_NEWS',
      `injected SIMULATED breaking news: "${item.headline}"`,
    );
    this.feed();
  }

  /** The next restricted (blackout) event from now, for the demo's clock jump. */
  nextRestrictedEvent(): { title: string; scheduledAt: string } | null {
    const w = this.calendarService.current();
    if (w.status !== 'OK') return null;
    const levels = this.config.system.decision.eventBlackout.impactLevels;
    const now = this.clock.now().getTime();
    return (
      w.value.events.find(
        (e) =>
          Date.parse(e.scheduledAt) > now + 60_000 &&
          levels.includes(e.impact === 'UNKNOWN' ? 'HIGH' : e.impact),
      ) ?? null
    );
  }

  // ------------------------------------------------------------------ accounts

  activity(accountId: string): AccountActivity | null {
    const account = this.config.accounts.get(accountId);
    const profile = account && this.config.profiles.get(account.propFirmProfileId);
    if (!account || !profile) return null;
    const w = tradingDayWindow(this.clock.now(), profile.tradingDayReset);
    const counted = new Set([
      'PENDING_SUBMIT',
      'SUBMITTED',
      'ACCEPTED',
      'PARTIALLY_FILLED',
      'FILLED',
      'SHADOW',
      'UNKNOWN',
    ]);
    const tradesToday = [...this.store.orders.values()].filter(
      (o) =>
        o.accountId === accountId &&
        counted.has(o.status) &&
        Date.parse(o.createdAt) >= w.start.getTime() &&
        Date.parse(o.createdAt) < w.end.getTime(),
    ).length;
    // Losing streak within the current trading day (it starts fresh at each reset).
    let streak = 0;
    for (const t of this.closedTrades.get(accountId) ?? []) {
      const closed = Date.parse(t.closedAt);
      if (closed < w.start.getTime() || closed >= w.end.getTime()) break;
      if (t.realizedPnl < 0) streak++;
      else break;
    }
    return { tradingDayKey: w.key, tradesToday, consecutiveLosses: streak };
  }

  private syncing = false;
  readonly monitorPolicy = DEFAULT_MONITOR_POLICY;
  readonly monitorAlerts = new MonitorAlertTracker(DEFAULT_MONITOR_POLICY);
  monitorViews: AccountMonitorView[] = [];
  monitorAsOf: string | null = null;
  private protectionEval: ProtectionEvaluator | null = null;
  private readonly protectionDone = new Set<string>();
  private readonly protectionAttempts = new Map<string, number>();
  private readonly protectionReported = new Set<string>();
  private readonly protectionRecent: ProtectiveActionRecord[] = [];
  private historyQuotes = 0;

  private async syncAccounts(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      await this.syncAll();
      this.runMonitor();
      this.syncExcursions();
      await this.runProtection();
    } finally {
      this.syncing = false;
    }
  }

  /** Position monitor after each sync — the same evaluation and alert tracking as the core. */
  private runMonitor(): void {
    const now = this.clock.now();
    this.monitorViews = [...this.config.accounts.values()]
      .filter((a) => a.status === 'ACTIVE')
      .map((a) => {
        const e = this.accounts.get(a.id)!;
        return monitorAccount({
          accountId: a.id,
          now,
          snapshot: e.snapshot,
          state: e.state,
          drawdownRule: this.config.profiles.get(a.propFirmProfileId)!.maxDrawdown,
          instruments: this.valued(a.currency),
          quote: (s) => this.market.fresh(s),
          policy: this.monitorPolicy,
        });
      });
    this.monitorAsOf = now.toISOString();
    for (const c of this.monitorAlerts.update(this.monitorViews, now)) {
      const a = c.alert;
      this.emit(
        c.change === 'CLEARED' ? 'INFO' : a.level,
        'position-monitor',
        `POSITION_${a.kind}_${c.change}`,
        c.change === 'CLEARED' ? `cleared: ${a.message}` : a.message,
        a.accountId,
      );
    }
  }

  // ------------------------------------------------------------------ trade journal

  private syncExcursions(): void {
    const open = this.monitorViews.flatMap((v) =>
      v.positions.map((p) => ({
        accountId: v.accountId,
        positionId: p.positionId,
        symbol: p.symbol,
        direction: p.direction,
        entryPrice: p.entryPrice,
        openedAt: p.openedAt,
      })),
    );
    const known = new Set(
      this.monitorViews.filter((v) => v.status === 'OK').map((v) => v.accountId),
    );
    this.excursions.sync(open, this.clock.now());
    this.excursions.prune(open, (accountId) => !known.has(accountId));
  }

  /** The core's JournalService logic: decision + order + close + excursions → one entry. */
  private journalClosed(
    accountId: string,
    t: ReturnType<PaperBrokerAdapter['closedTrades']>[number],
  ): void {
    const order =
      [...this.store.orders.values()].find((o) => o.clientOrderId === t.clientOrderId) ?? null;
    const d = order
      ? this.decisions.find((x) => x.decision.decisionId === order.decisionId)
      : undefined;
    const account = this.config.accounts.get(accountId);
    const profile = account && this.config.profiles.get(account.propFirmProfileId);
    const entry = buildJournalEntry({
      trade: { ...t, accountId },
      order: order
        ? {
            decisionId: order.decisionId,
            strategyId: order.strategyId,
            signalId: order.signalId,
            mode: order.mode,
            plannedEntry: order.plannedEntry,
            stopLoss: order.stopLoss,
            takeProfit: order.takeProfit,
            quantity: order.quantity,
          }
        : null,
      decision: d
        ? {
            decidedAt: d.decision.decidedAt,
            configHash: d.decision.configHash,
            plannedRisk: d.decision.sizing?.dollarRisk ?? null,
          }
        : null,
      spec: account ? this.valued(account.currency)(t.symbol) : undefined,
      excursion: this.excursions.take(t.positionId),
      context: profile
        ? tradeContext({
            signal: d?.inputs.candidate.signal ?? null,
            symbol: t.symbol,
            eventCurrencies: this.config.instruments.get(t.symbol)?.eventCurrencies,
            entryAt: t.openedAt,
            exitAt: t.closedAt,
            day: tradingDayWindow(new Date(t.openedAt), profile.tradingDayReset),
            calendars: [d?.inputs.calendar ?? null, this.calendarService.current()],
          })
        : undefined,
    });
    this.journal.unshift(entry);
    const r = entry.result;
    this.emit(
      'INFO',
      'journal',
      'TRADE_JOURNALED',
      `${entry.symbol} ${entry.direction} ${entry.quantity}: ${r.outcome} ${r.netPnl ?? r.grossPnl}${r.rMultiple === null ? '' : ` (${r.rMultiple} R)`} — exit ${entry.exit.reason}`,
      accountId,
    );
  }

  // ------------------------------------------------------------------ automatic protection

  protectionStatus(): ProtectionStatus {
    const policy = this.config.system.protection ?? DEFAULT_PROTECTION_POLICY;
    return { enabled: policy.enabled, policy, recent: [...this.protectionRecent] };
  }

  /** The core's ProtectionService logic (ADR-0014), on the in-browser gateway. */
  private async runProtection(): Promise<void> {
    const policy = this.config.system.protection ?? DEFAULT_PROTECTION_POLICY;
    this.protectionEval ??= new ProtectionEvaluator(policy);
    const actions = this.protectionEval.evaluate(this.monitorViews, {
      now: this.clock.now(),
      holding: (id) => {
        const a = this.config.accounts.get(id);
        return (a && this.config.profiles.get(a.propFirmProfileId)?.holding) ?? null;
      },
    });
    for (const a of actions) {
      const key = `${a.accountId}:${a.positionId}`;
      if (this.protectionDone.has(key)) continue;
      if (
        a.blockAccount &&
        !this.killSwitches.active().some((k) => k.scope === 'ACCOUNT' && k.target === a.accountId)
      ) {
        const profile = this.config.profiles.get(
          this.config.accounts.get(a.accountId)!.propFirmProfileId,
        )!;
        const nextDay = tradingDayWindow(
          this.clock.now(),
          profile.tradingDayReset,
        ).end.toISOString();
        this.activateKillSwitch(
          'ACCOUNT',
          a.accountId,
          `automatic protection: ${a.reason}`,
          { type: 'SYSTEM', id: 'protection' },
          a.blockAccount,
          a.blockAccount === 'NEXT_TRADING_DAY' ? nextDay : null,
        );
      }
      const failed = this.protectionAttempts.get(key) ?? 0;
      if (failed >= policy.maxCloseAttempts) {
        this.recordProtection(
          a,
          'GAVE_UP',
          failed,
          `${failed} close attempts failed — MANUAL ACTION REQUIRED`,
          `${key}:GAVE_UP`,
        );
        continue;
      }
      const r = await this.gateway.protectiveClose({
        accountId: a.accountId,
        positionId: a.positionId,
        clientCloseId: `protect-${a.trigger}-${a.positionId}-${failed + 1}`,
        reason: `automatic protection (${a.trigger}): ${a.reason}`,
      });
      if (r.outcome === 'SKIPPED') {
        this.recordProtection(a, 'SKIPPED', failed + 1, r.reason, `${key}:SKIPPED:${r.reason}`);
        continue;
      }
      if (r.outcome === 'REJECTED') this.protectionAttempts.set(key, failed + 1);
      else this.protectionDone.add(key);
      this.recordProtection(a, r.outcome, failed + 1, r.reason, null, r.exitPrice, r.realizedPnl);
    }
  }

  private recordProtection(
    a: ProtectiveAction,
    outcome: ProtectiveActionRecord['outcome'],
    attempt: number,
    detail: string,
    onceKey: string | null,
    exitPrice: number | null = null,
    realizedPnl: number | null = null,
  ): void {
    if (onceKey !== null) {
      if (this.protectionReported.has(onceKey)) return;
      this.protectionReported.add(onceKey);
    }
    const rec: ProtectiveActionRecord = {
      at: this.clock.now().toISOString(),
      trigger: a.trigger,
      accountId: a.accountId,
      positionId: a.positionId,
      symbol: a.symbol,
      reason: a.reason,
      outcome,
      detail,
      exitPrice,
      realizedPnl,
      attempt,
    };
    this.protectionRecent.unshift(rec);
    if (this.protectionRecent.length > 50) this.protectionRecent.pop();
    this.emit(
      outcome === 'ALREADY_FLAT' ? 'INFO' : 'CRITICAL',
      'protection',
      `PROTECTIVE_CLOSE_${outcome}`,
      outcome === 'CLOSED'
        ? `ASTRA closed ${a.reason} — automatic protection (${a.trigger}) at ${exitPrice}, P&L ${realizedPnl}`
        : `automatic protection (${a.trigger}) could not close ${a.reason}: ${outcome} — ${detail}`,
      a.accountId,
    );
    void this.appendAudit({
      actorType: 'SYSTEM',
      actorId: 'protection',
      category: 'PROTECTION',
      action: `PROTECTIVE_CLOSE_${outcome}`,
      entityType: 'position',
      entityId: a.positionId,
      payload: { ...rec },
    });
  }

  /**
   * Demo only: books a large realized loss on the paper account (as if other trades today had
   * lost) so the open positions push the daily loss limit past the protection level.
   */
  simulateLargeLoss(accountId = 'paper-demo'): void {
    const account = this.config.accounts.get(accountId);
    const e = this.accounts.get(accountId);
    const daily = e?.state?.dailyLoss;
    if (!account || !e?.state || !daily || e.state.openRisk.positions.length === 0) {
      this.emit(
        'WARN',
        'demo',
        'SIMULATED_LOSS_SKIPPED',
        'open a trade first (Trade Approval Center), then simulate the loss',
      );
      return;
    }
    const ref = account.broker.accountRef;
    // Leave only 6% of the daily limit: 94% used → above the 90% protection level.
    const balance = daily.floor + daily.limit * 0.06 - e.state.floatingPnl;
    this.paper.importAccount(ref, { ...this.paper.exportAccount(ref), balance });
    this.emit(
      'WARN',
      'demo',
      'SIMULATED_LOSS',
      `demo booked a SIMULATED realized loss: paper balance set to ${balance.toFixed(2)} (daily loss limit ~94% used)`,
      accountId,
    );
    void this.syncAccounts();
  }

  private async syncAll(): Promise<void> {
    let ok = 0;
    for (const account of this.config.accounts.values()) {
      if (await this.syncAccount(account)) ok++;
    }
    this.health.report(
      'PROP_FIRM_ADAPTER',
      ok === this.config.accounts.size ? 'ONLINE' : 'DEGRADED',
      `${ok}/${this.config.accounts.size} accounts synced (paper)`,
    );
    void this.paper
      .health()
      .then((h) => this.health.report('EXECUTION', h.status, `paper: ${h.detail}`));
    for (const s of this.killSwitches.dueForAutoClear()) {
      this.killSwitches.apply(
        this.killSwitches.planDeactivation({
          scope: s.scope,
          target: s.target,
          reason: 'new trading day',
          actor: { type: 'SYSTEM', id: 'halt-monitor' },
        }),
      );
    }
    const now = this.clock.now().getTime();
    for (const a of this.store.approvals.values()) {
      if (a.state === 'PENDING' && Date.parse(a.expiresAt) <= now)
        void this.store.transitionApproval(a.approvalId, 'EXPIRED');
    }
    // The in-memory store answers as long as the page runs (the server probes its database here).
    this.health.report('DATABASE', 'ONLINE', 'in-browser demo store (not persisted)');
    this.health.report('RISK_ENGINE', 'ONLINE', 'safety loop healthy (demo)');
  }

  private async syncAccount(account: AccountDefinition): Promise<boolean> {
    const entry = this.accounts.get(account.id)!;
    const profile = this.config.profiles.get(account.propFirmProfileId)!;
    const policy = this.config.riskPolicies.get(account.riskPolicyId)!;
    try {
      const snap = await this.paper.getAccountSnapshot(account.broker.accountRef, account.id);
      entry.snapshot = observed(snap, {
        source: 'broker:paper',
        sourceKind: 'SIMULATED',
        asOf: snap.asOf,
      });

      const closed = this.paper.closedTrades(account.broker.accountRef);
      const list = this.closedTrades.get(account.id)!;
      for (const t of closed.slice(entry.closedSynced)) {
        list.unshift({
          id: t.positionId,
          symbol: t.symbol,
          direction: t.direction,
          quantity: t.quantity,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          exitReason: t.exitReason,
          realizedPnl: t.realizedPnl,
          openedAt: t.openedAt,
          closedAt: t.closedAt,
        });
        this.emit(
          t.realizedPnl < 0 ? 'WARN' : 'INFO',
          'position-monitor',
          'POSITION_CLOSED',
          `${t.symbol} ${t.direction} ${t.quantity} closed at ${t.exitPrice} (${t.exitReason}), P&L ${t.realizedPnl}`,
          account.id,
        );
        this.journalClosed(account.id, t);
      }
      entry.closedSynced = closed.length;

      const activity = this.activity(account.id)!;
      entry.activity = activity;
      const opts = {
        reset: profile.tradingDayReset,
        tradedToday: activity.tradesToday > 0,
        lateObservationThresholdMs: this.config.system.tracking.lateObservationThresholdMs,
      };
      entry.tracking = entry.tracking
        ? updateAccountTracking(entry.tracking, snap, opts)
        : initAccountTracking({
            accountId: account.id,
            initialBalance: profile.accountSize,
            snapshot: snap,
            reset: profile.tradingDayReset,
          });
      const state = computeAccountState({
        profile,
        tracking: entry.tracking,
        snapshot: snap,
        instruments: this.valued(account.currency),
      });
      const health = classifyAccountHealth({
        state,
        policy,
        activity,
        accountStatus: account.status,
      });
      const previous = entry.health?.health ?? null;
      entry.state = state;
      entry.health = health;
      entry.error = null;
      entry.syncedAt = this.clock.now().toISOString();
      if (previous !== null && previous !== health.health) {
        this.emit(
          ['HALTED', 'BREACH_RISK'].includes(health.health)
            ? 'CRITICAL'
            : health.health === 'SAFE'
              ? 'INFO'
              : 'WARN',
          'risk-engine',
          'ACCOUNT_HEALTH_CHANGED',
          `${account.id} health ${previous} → ${health.health}${health.reasons.length ? `: ${health.reasons.join('; ')}` : ''}`,
          account.id,
        );
      }
      const window = tradingDayWindow(this.clock.now(), profile.tradingDayReset);
      for (const a of evaluateAccountHaltConditions({
        accountId: account.id,
        breached: state.breached,
        dayLocked: state.dayLocked,
        nextTradingDayStart: window.end.toISOString(),
        unprotectedPositions: state.openRisk.positions
          .filter((p) => p.riskToStop === null)
          .map((p) => p.positionId),
      })) {
        if (!this.killSwitches.get(a.scope, a.target)?.active) {
          this.activateKillSwitch(
            a.scope,
            a.target,
            a.reason,
            { type: 'SYSTEM', id: 'halt-monitor' },
            a.clearPolicy,
            a.autoClearAt,
          );
        }
      }
      return true;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // ------------------------------------------------------------------ controls

  setMode(mode: TradingMode, reason: string): NonNullable<ModeInfo['state']> {
    const from = this.mode.mode;
    this.mode = {
      mode,
      version: this.mode.version + 1,
      changedAt: this.clock.now().toISOString(),
      changedBy: 'HUMAN:operator',
      reason,
    };
    void this.appendAudit({
      actorType: 'HUMAN',
      actorId: 'operator',
      category: 'SYSTEM',
      action: 'MODE_CHANGED',
      entityType: 'system_state',
      entityId: '1',
      payload: { mode, reason },
    });
    this.emit(
      mode === 'HALTED' ? 'WARN' : 'INFO',
      'system',
      'MODE_CHANGED',
      `mode ${from} → ${mode} by HUMAN:operator: ${reason}`,
    );
    return this.mode;
  }

  activateKillSwitch(
    scope: KillSwitchScope,
    target: string | null,
    reason: string,
    actor: Actor,
    clearPolicy: 'MANUAL' | 'NEXT_TRADING_DAY' = 'MANUAL',
    autoClearAt: string | null = null,
  ) {
    const change = this.killSwitches.activate({
      scope,
      target,
      reason,
      actor,
      clearPolicy,
      autoClearAt,
    });
    void this.appendAudit({
      actorType: actor.type,
      actorId: actor.id,
      category: 'KILL_SWITCH',
      action: 'ACTIVATED',
      entityType: 'kill_switch',
      entityId: `${scope}:${target ?? '*'}`,
      payload: { ...change.next },
    });
    this.emit(
      'CRITICAL',
      'kill-switch',
      'KILL_SWITCH_ACTIVATED',
      `${scope}${target ? ` (${target})` : ''} kill switch activated by ${actor.type}:${actor.id}: ${reason}`,
      scope === 'ACCOUNT' || scope === 'EXECUTION' ? target : null,
    );
    return change.next;
  }

  deactivateKillSwitch(scope: KillSwitchScope, target: string | null, reason: string) {
    const change = this.killSwitches.planDeactivation({
      scope,
      target,
      reason,
      actor: { type: 'HUMAN', id: 'operator' },
    });
    this.killSwitches.apply(change);
    void this.appendAudit({
      actorType: 'HUMAN',
      actorId: 'operator',
      category: 'KILL_SWITCH',
      action: 'DEACTIVATED',
      entityType: 'kill_switch',
      entityId: `${scope}:${target ?? '*'}`,
      payload: { ...change.next },
    });
    this.emit(
      'WARN',
      'kill-switch',
      'KILL_SWITCH_DEACTIVATED',
      `${scope}${target ? ` (${target})` : ''} kill switch cleared by HUMAN:operator: ${reason}`,
    );
    return change.next;
  }

  // ------------------------------------------------------------------ decisions and execution

  async evaluate(
    candidate: TradeCandidate,
    autoExecute: boolean,
  ): Promise<{ decision: TradeDecision; persisted: boolean; execution: ExecutionResult | null }> {
    const inputs = this.config.strategies.get(candidate.signal.strategyId)?.requiresAiAnalysis
      ? await this.withAiAnalysis(candidate)
      : await this.assemble(candidate);
    return this.decideAndPublish(inputs, autoExecute);
  }

  /** As the server: deterministic checks first; the AI only when they would all pass. */
  private async withAiAnalysis(candidate: TradeCandidate): Promise<DecisionInputs> {
    const pre = await this.assemble(
      candidate,
      notObserved('UNAVAILABLE', 'AI analysis pending', 'ai'),
    );
    const blocking = this.engine
      .evaluate(pre)
      .checks.filter((c) => c.mandatory && c.verdict !== 'PASS' && c.checkId !== 'ai.analysis');
    if (blocking.length > 0) {
      return {
        ...pre,
        aiAnalysis: notObserved(
          'UNAVAILABLE',
          'not requested: other checks already reject this candidate',
          'ai',
        ),
      };
    }
    await this.analyzeSignal(candidate.signal);
    return this.assemble(candidate);
  }

  private assemble(candidate: TradeCandidate, ai?: Observed<AiAnalysis>): Promise<DecisionInputs> {
    const { config } = this;
    return assembleDecisionInputs({
      candidate,
      config: {
        configHash: config.hash,
        policy: config.system.decision,
        account: (id) => config.accounts.get(id),
        profile: (id) => config.profiles.get(id),
        riskPolicy: (id) => config.riskPolicies.get(id),
        strategy: (id) => config.strategies.get(id),
        instrument: (s) => config.instruments.get(s),
        instrumentSymbols: () => [...config.instruments.keys()],
        sessions: () => config.system.sessions,
      },
      data: {
        quote: (s) => Promise.resolve(this.latestQuote(s)),
        accountSnapshot: (id) =>
          Promise.resolve(
            this.accounts.get(id)?.snapshot ??
              notObserved('UNAVAILABLE', 'unknown account', 'demo'),
          ),
        tracking: (id) => {
          const e = this.accounts.get(id);
          return Promise.resolve(
            e?.tracking && e.snapshot.status === 'OK'
              ? observed(e.tracking, {
                  source: 'astra-account-tracking',
                  sourceKind: 'SIMULATED',
                  asOf: e.tracking.updatedAt,
                })
              : notObserved('UNAVAILABLE', 'account tracking not available', 'demo'),
          );
        },
        activity: (id) => {
          const a = this.activity(id);
          return Promise.resolve(
            a
              ? observed(a, {
                  source: 'demo-store',
                  sourceKind: 'LIVE',
                  asOf: this.clock.now().toISOString(),
                })
              : notObserved('UNAVAILABLE', 'unknown account', 'demo'),
          );
        },
        calendar: () => Promise.resolve(this.calendar()),
        newsRisk: (symbol) => Promise.resolve(this.news.risk(symbol)),
        aiAnalysis: (c) => Promise.resolve(ai ?? this.aiAnalysisFor(c.signal)),
        duplicates: (accountId, signalId, symbol) => {
          const prior = this.decisions.find(
            (d) =>
              d.decision.accountId === accountId &&
              d.decision.signalId === signalId &&
              d.decision.status === 'APPROVED',
          );
          const working = [...this.store.orders.values()].some(
            (o) => o.accountId === accountId && o.symbol === symbol && !isTerminal(o.status),
          );
          return Promise.resolve(
            observed(
              {
                priorApprovedDecisionId: prior?.decision.decisionId ?? null,
                workingOrderForSymbol: working,
              },
              { source: 'demo-store', sourceKind: 'LIVE', asOf: this.clock.now().toISOString() },
            ),
          );
        },
      },
      state: {
        mode: () => this.mode.mode,
        killSwitches: (ctx) => this.killSwitches.evaluate(ctx),
        componentHealth: () => this.health.snapshot(),
        execution: (account) => ({
          adapterId: account ? this.paper.id : null,
          adapterKind: account ? 'PAPER' : null,
          health: this.health.get('EXECUTION').status,
          reconciled: true,
          supportedEntryTypes: this.paper.supportedEntryTypes,
        }),
        liveTradingEnvironmentAuthorized: () => false,
      },
      clock: this.clock,
      timeoutMs: config.system.assembler.providerTimeoutMs,
    });
  }

  private async decideAndPublish(
    inputs: DecisionInputs,
    autoExecute: boolean,
  ): Promise<{ decision: TradeDecision; persisted: boolean; execution: ExecutionResult | null }> {
    const recorder: DecisionRecorder = {
      record: async (d, i) => {
        // Mirrors the database's unique index: one approval per (account, signal).
        if (
          d.status === 'APPROVED' &&
          this.decisions.some(
            (x) =>
              x.decision.accountId === d.accountId &&
              x.decision.signalId === d.signalId &&
              x.decision.status === 'APPROVED',
          )
        ) {
          throw new Error('duplicate approval for this signal');
        }
        this.decisions.unshift({ decision: d, inputs: i });
        if (d.approval && d.orderPlan) {
          this.store.addApproval({
            approvalId: d.approval.approvalId,
            decisionId: d.decisionId,
            accountId: d.accountId,
            strategyId: d.strategyId,
            signalId: d.signalId,
            mode: d.mode,
            orderPlan: d.orderPlan,
            expiresAt: d.approval.expiresAt,
            state: 'PENDING',
          });
        }
        await this.appendAudit({
          actorType: 'SYSTEM',
          actorId: 'decision-engine',
          category: 'DECISION',
          action: d.status,
          entityType: 'trade_decision',
          entityId: d.decisionId,
          payload: {
            symbol: d.symbol,
            direction: d.direction,
            reasons: d.reasons,
            quantity: d.orderPlan?.quantity ?? null,
            configHash: d.configHash,
          },
        });
      },
    };
    const recorded = await decideAndRecord(this.engine, inputs, recorder);
    const d = recorded.decision;
    this.emit(
      d.status === 'APPROVED' ? 'INFO' : 'WARN',
      'decision-engine',
      `DECISION_${d.status}`,
      d.status === 'APPROVED'
        ? `${d.symbol} ${d.direction} approved: ${d.orderPlan?.quantity} @ ~${d.orderPlan?.entry} (${d.mode})`
        : `${d.symbol} ${d.direction} rejected: ${d.reasons.slice(0, 3).join(' | ')}${d.reasons.length > 3 ? ` (+${d.reasons.length - 3} more)` : ''}`,
      d.accountId,
    );
    let execution: ExecutionResult | null = null;
    if (
      autoExecute &&
      d.status === 'APPROVED' &&
      d.approval &&
      (this.config.system.execution.autoExecuteModes as string[]).includes(d.mode)
    ) {
      execution = await this.execute(d.approval.approvalId);
    }
    return { decision: d, persisted: recorded.persisted, execution };
  }

  async execute(approvalId: string): Promise<ExecutionResult> {
    const result = await this.gateway.execute(approvalId);
    const o = result.order;
    if (o) {
      void this.appendAudit({
        actorType: 'SYSTEM',
        actorId: 'execution-gateway',
        category: 'EXECUTION',
        action: `ORDER_${result.outcome}`,
        entityType: 'order',
        entityId: o.clientOrderId,
        payload: { symbol: o.symbol, quantity: o.quantity, outcome: result.outcome },
      });
    }
    this.emit(
      result.outcome === 'UNKNOWN' ? 'CRITICAL' : result.outcome === 'REJECTED' ? 'WARN' : 'INFO',
      'execution',
      `EXECUTION_${result.outcome}`,
      `${o ? `${o.direction} ${o.quantity} ${o.symbol}` : `approval ${approvalId}`}: ${result.outcome} — ${result.reasons.join('; ')}`,
      o?.accountId ?? null,
    );
    await this.syncAccounts();
    return result;
  }
}

let instance: DemoRuntime | null = null;

export function demoRuntime(): DemoRuntime {
  if (!instance) {
    instance = new DemoRuntime();
    instance.start();
  }
  return instance;
}
