/**
 * ASTRA Core runtime: composition root for every service, the startup sequence and the in-core
 * safety loop.
 *
 * Startup (ARCHITECTURE §18): config (already validated) → DB → migrations → config version →
 * trading mode → kill switches → heartbeats → paper state → reconciliation → market-data warm-up
 * (bars from the database) → market-data adapters (and the chart feeds' history) → monitors.
 * Until that completes, the effective mode is HALTED and the kill-switch registry is unloaded,
 * so every decision is rejected. If the database is unavailable, initialization is retried.
 */
import type { AiProvider } from '@astra/ai';
import {
  CalendarPoller,
  CalendarService,
  SimulatedCalendarAdapter,
  type CalendarChange,
} from '@astra/calendar';
import {
  AstraError,
  effectiveImpact,
  errorMessage,
  type CalendarWindow,
  type Clock,
  type HealthStatus,
  type ObservedOk,
} from '@astra/core';
import type { AstraConfig } from '@astra/config';
import {
  AccountRepository,
  AiRepository,
  AuditRepository,
  BacktestRepository,
  CalendarRepository,
  ConfigVersionRepository,
  DecisionRepository,
  EventRepository,
  ExecutionRepository,
  HeartbeatRepository,
  KillSwitchRepository,
  JournalRepository,
  MarketBarRepository,
  NewsRepository,
  PaperBrokerStateRepository,
  PaperOwnerRepository,
  ReportRepository,
  SystemStateRepository,
  migrate,
  type Sql,
} from '@astra/db';
import {
  MarketDataService,
  type MarketDataAdapter,
  type SimulationAdapter,
} from '@astra/market-data';
import {
  DEFAULT_NEWS_RISK_RULE,
  NewsPoller,
  NewsService,
  SimulatedNewsAdapter,
  type ClassifiedNews,
} from '@astra/news';
import type { Logger } from 'pino';
import { AccountService } from './account-service';
import { AiService } from './ai-service';
import { BacktestService } from './backtest-service';
import { DecisionService } from './decision-service';
import { EventBus } from './event-bus';
import { YahooFeed, type FeedId, type FeedTransport } from './feeds';
import { marketValuation } from './valuation';
import { StrategyRunner } from './strategy-runner';
import { PreSubmitValidator } from './pre-submit-validator';
import { WorkingOrderService } from './working-orders';
import { ExecutionService } from './execution-service';
import { HealthService } from './health-service';
import { KillSwitchService } from './kill-switch-service';
import { BarPersister } from './market-data';
import { ModeService } from './mode-service';
import { JournalService } from './journal-service';
import { PositionMonitorService } from './position-monitor';
import { ProtectionService } from './protection-service';
import { ReportService } from './report-service';
import { createSimulation } from './simulation';

export interface RuntimeOptions {
  readonly config: AstraConfig;
  readonly sql: Sql;
  readonly clock: Clock;
  readonly log: Logger;
  readonly runMigrations: boolean;
  /** Override for the SQL migrations directory (bundled builds). */
  readonly migrationsDir?: string | undefined;
  readonly liveTradingAuthorized: boolean;
  readonly simulation: boolean;
  /** Free chart feeds to run (ADR-0026; prices only). Cannot be combined with `simulation`. */
  readonly feeds?: readonly FeedId[];
  /** Network seams of the feeds (tests). */
  readonly feedTransport?: FeedTransport;
  /** Start the periodic safety loop (tests drive cycles manually). */
  readonly startLoops: boolean;
  readonly initRetryMs?: number;
  /** Paper ownership re-check interval in ms (0 = timer off; boundary checks always run). */
  readonly ownerKeepaliveMs?: number;
  /** Real AI providers, built by the entry point from environment keys (none: AI unavailable). */
  readonly aiProviders?: ReadonlyMap<string, AiProvider>;
}

export class AstraRuntime {
  readonly config: AstraConfig;
  readonly sql: Sql;
  readonly clock: Clock;
  readonly log: Logger;

  readonly repos: {
    audit: AuditRepository;
    events: EventRepository;
    system: SystemStateRepository;
    heartbeats: HeartbeatRepository;
    configVersions: ConfigVersionRepository;
    killSwitches: KillSwitchRepository;
    decisions: DecisionRepository;
    execution: ExecutionRepository;
    accounts: AccountRepository;
    paperState: PaperBrokerStateRepository;
    paperOwner: PaperOwnerRepository;
    marketBars: MarketBarRepository;
    journal: JournalRepository;
    backtests: BacktestRepository;
    calendar: CalendarRepository;
    news: NewsRepository;
    ai: AiRepository;
    reports: ReportRepository;
  };
  readonly events: EventBus;
  readonly mode: ModeService;
  readonly killSwitches: KillSwitchService;
  readonly health: HealthService;
  readonly market: MarketDataService;
  /** Completed bars → database (batched by the safety loop). */
  readonly barPersister: BarPersister;
  /** Instruments traded by ACTIVE accounts: MARKET_DATA is ONLINE only when all are fresh. */
  readonly tradedSymbols: readonly string[];
  readonly calendar: CalendarService;
  readonly news: NewsService;
  /** AI analysis layer (Phase 6): context for the gate, post-trade reviews. */
  readonly ai: AiService;
  /** Daily / weekly reports (delivered by n8n). */
  readonly reports: ReportService;
  /** News provider poller (null: items arrive by push only). */
  readonly newsPoller: NewsPoller | null;
  readonly monitor: PositionMonitorService;
  readonly journal: JournalService;
  readonly backtests: BacktestService;
  readonly protection: ProtectionService;
  /** Resting LIMIT entries: broker state sync and cancellation when conditions change. */
  readonly workingOrders: WorkingOrderService;
  readonly execution: ExecutionService;
  readonly accounts: AccountService;
  readonly decisions: DecisionService;
  private preSubmit!: PreSubmitValidator;
  /** The owner's rule-based strategies run on closed M5 candles (ADR-0024). */
  readonly strategies: StrategyRunner;
  readonly simulation: SimulationAdapter | null;
  /** Economic-calendar provider poller (null: windows arrive by push only). */
  readonly calendarPoller: CalendarPoller | null;
  /** Free Yahoo chart feed (ADR-0026): prices for charts only, never a tradable quote. */
  readonly yahoo: YahooFeed | null;
  /** Quote / price sources started after initialization (simulation or chart feeds; platforms later). */
  readonly marketAdapters: readonly MarketDataAdapter[];

  private initialized = false;
  private initError: string | null = null;
  private loopTimer: NodeJS.Timeout | undefined;
  private initTimer: NodeJS.Timeout | undefined;
  private cycleRunning = false;
  private calendarEvents: Promise<void> = Promise.resolve();
  private calendarStored: Promise<void> = Promise.resolve();
  private newsRecorded: Promise<void> = Promise.resolve();
  private stopped = false;
  private feedHistory: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RuntimeOptions) {
    const { config, sql, clock, log } = opts;
    this.config = config;
    this.sql = sql;
    this.clock = clock;
    this.log = log;

    this.repos = {
      audit: new AuditRepository(sql),
      events: new EventRepository(sql),
      system: new SystemStateRepository(sql),
      heartbeats: new HeartbeatRepository(sql),
      configVersions: new ConfigVersionRepository(sql),
      killSwitches: new KillSwitchRepository(sql),
      decisions: new DecisionRepository(sql),
      execution: new ExecutionRepository(sql),
      accounts: new AccountRepository(sql),
      paperState: new PaperBrokerStateRepository(sql),
      paperOwner: new PaperOwnerRepository(sql),
      marketBars: new MarketBarRepository(sql),
      journal: new JournalRepository(sql),
      backtests: new BacktestRepository(sql),
      calendar: new CalendarRepository(sql),
      news: new NewsRepository(sql),
      ai: new AiRepository(sql),
      reports: new ReportRepository(sql),
    };
    this.events = new EventBus(this.repos.events, clock, log);
    this.mode = new ModeService(this.repos.system, clock, this.events, opts.liveTradingAuthorized);
    this.killSwitches = new KillSwitchService(this.repos.killSwitches, clock, this.events);
    const traded = new Set<string>();
    for (const a of config.accounts.values()) {
      if (a.status === 'ACTIVE') for (const s of a.instruments) traded.add(s);
    }
    this.tradedSymbols = [...traded].sort();
    // `execution` and `market` are assigned below; the health probe reads them lazily.
    this.health = new HealthService(clock, config.system.health.staleAfterMs, {
      sql,
      heartbeats: this.repos.heartbeats,
      adapters: () => [...this.execution.adapters.values()],
      marketData: () => this.marketDataHealth(),
      calendar: () => this.calendar.health(),
      news: () => this.news.health(),
      ai: () => this.ai.health(),
    });
    this.barPersister = new BarPersister(this.repos.marketBars, log);
    const freshness = config.system.decision.freshness;
    const md = config.system.marketData;
    this.market = new MarketDataService({
      clock,
      instruments: config.instruments,
      sessions: config.system.sessions,
      freshness: { maxAgeMs: freshness.quoteMaxAgeMs, maxFutureSkewMs: freshness.maxFutureSkewMs },
      suspectCooldownMs: md?.suspectCooldownMs,
      maxBarsPerSeries: md?.maxBarsPerSeries,
      barCloseGraceMs: md?.barCloseGraceMs,
      onBars: (bars) => {
        this.barPersister.enqueue(bars);
        // Assigned below; bars only complete after start().
        this.strategies.onBars(bars);
      },
      onRejected: (source, reason) => log.warn({ source, reason }, 'market-data quote rejected'),
      onListenerError: (err) =>
        log.error({ err: errorMessage(err) }, 'market-data quote listener failed'),
    });
    this.calendar = new CalendarService({
      clock,
      freshness: {
        maxAgeMs: freshness.calendarMaxAgeMs,
        maxFutureSkewMs: freshness.maxFutureSkewMs,
      },
      instruments: config.instruments,
      // Every accepted window is persisted in order; restoration never re-enqueues itself.
      onWindow: (window) => {
        this.calendarStored = this.calendarStored.then(() => this.storeCalendarWindow(window));
      },
      // Queued: change events are recorded in order, and pushes can wait for them.
      onChanges: (changes, source) => {
        this.calendarEvents = this.calendarEvents.then(() =>
          this.reportCalendarChanges(changes, source),
        );
      },
    });
    const nc = config.system.news;
    this.news = new NewsService({
      clock,
      freshness: { maxAgeMs: freshness.newsMaxAgeMs, maxFutureSkewMs: freshness.maxFutureSkewMs },
      instruments: new Map(
        [...config.instruments].map(([symbol, spec]) => [
          symbol,
          { eventCurrencies: spec.eventCurrencies, keywords: nc?.instrumentKeywords[symbol] },
        ]),
      ),
      risk: nc?.risk ?? DEFAULT_NEWS_RISK_RULE,
      retentionMs: (nc?.retentionHours ?? 48) * 3_600_000,
      // Queued: items are stored and announced in order, and pushes can wait for them.
      onItems: (items, source) => {
        this.newsRecorded = this.newsRecorded.then(() => this.recordNews(items, source));
      },
    });
    this.execution = new ExecutionService({
      config,
      store: this.repos.execution,
      paperState: this.repos.paperState,
      paperOwner: this.repos.paperOwner,
      ...(opts.ownerKeepaliveMs !== undefined ? { ownerKeepaliveMs: opts.ownerKeepaliveMs } : {}),
      mode: this.mode,
      killSwitches: this.killSwitches,
      health: this.health,
      events: this.events,
      clock,
      log,
      liveTradingEnvironmentAuthorized: opts.liveTradingAuthorized,
      // Bound after the services it needs exist; until then (or if unbound) every entry refuses.
      revalidate: (req) =>
        this.preSubmit
          ? this.preSubmit.revalidate(req)
          : Promise.reject(new Error('pre-submit validator not bound')),
    });
    this.market.onQuote((q) => this.execution.onQuote(q));
    this.journal = new JournalService({
      config,
      clock,
      repo: this.repos.journal,
      orders: this.repos.execution,
      decisions: this.repos.decisions,
      calendar: this.calendar,
      events: this.events,
      log,
      valuation: marketValuation(config, this.market),
      onJournaled: (entry) => this.ai.onJournaled(entry),
    });
    this.market.onQuote((q) => this.journal.onQuote(q));
    this.backtests = new BacktestService({
      config,
      clock,
      bars: this.repos.marketBars,
      runs: this.repos.backtests,
      market: this.market,
      events: this.events,
    });
    this.accounts = new AccountService({
      config,
      repo: this.repos.accounts,
      adapter: (id) => this.execution.adapters.get(id),
      clock,
      events: this.events,
      health: this.health,
      killSwitches: this.killSwitches,
      log,
      providerTimeoutMs: config.system.assembler.providerTimeoutMs,
      valuation: marketValuation(config, this.market),
      onClosedTrade: (accountId, trade) => this.journal.recordClosed(accountId, trade),
    });
    this.monitor = new PositionMonitorService({
      config,
      clock,
      accounts: this.accounts,
      market: this.market,
      events: this.events,
    });
    this.workingOrders = new WorkingOrderService({
      config,
      clock,
      store: this.repos.execution,
      gateway: this.execution.gateway,
      mode: this.mode,
      killSwitches: this.killSwitches,
      calendar: this.calendar,
      news: this.news,
      events: this.events,
      log,
    });
    this.protection = new ProtectionService({
      config,
      clock,
      gateway: this.execution.gateway,
      killSwitches: this.killSwitches,
      events: this.events,
      audit: this.repos.audit,
    });
    this.ai = new AiService({
      config,
      clock,
      repo: this.repos.ai,
      journal: this.repos.journal,
      decisions: this.repos.decisions,
      market: this.market,
      calendar: this.calendar,
      news: this.news,
      mode: this.mode,
      killSwitches: this.killSwitches,
      events: this.events,
      log,
      providers: opts.aiProviders ?? new Map(),
      simulation: opts.simulation,
    });
    this.reports = new ReportService({
      config,
      repo: this.repos.reports,
      accounts: this.accounts,
      killSwitches: this.killSwitches,
      health: this.health,
      mode: () => this.mode.current(),
      simulation: opts.simulation,
      now: () => clock.now(),
    });
    this.decisions = new DecisionService({
      config,
      clock,
      mode: this.mode,
      killSwitches: this.killSwitches,
      health: this.health,
      market: this.market,
      calendar: this.calendar,
      news: this.news,
      ai: this.ai,
      accounts: this.accounts,
      decisions: this.repos.decisions,
      executionStore: this.repos.execution,
      execution: this.execution,
      events: this.events,
      liveTradingEnvironmentAuthorized: opts.liveTradingAuthorized,
    });
    this.preSubmit = new PreSubmitValidator({
      config,
      clock,
      mode: this.mode,
      killSwitches: this.killSwitches,
      health: this.health,
      market: this.market,
      calendar: this.calendar,
      news: this.news,
      ai: this.ai,
      accounts: this.accounts,
      decisions: this.repos.decisions,
      executionStore: this.repos.execution,
      readiness: (account) => this.execution.readiness(account),
      liveTradingEnvironmentAuthorized: opts.liveTradingAuthorized,
    });
    this.strategies = new StrategyRunner({
      config,
      clock,
      market: this.market,
      decisions: this.decisions,
      execution: this.execution,
      store: this.repos.execution,
      events: this.events,
      log,
    });
    this.simulation = opts.simulation ? createSimulation(config, clock) : null;
    // Calendar provider: the SIMULATED schedule in simulation mode; real providers once chosen.
    const cal = config.system.calendar;
    this.calendarPoller = opts.simulation
      ? new CalendarPoller({
          adapter: new SimulatedCalendarAdapter(),
          service: this.calendar,
          clock,
          intervalMs: cal?.pollIntervalMs ?? 300_000,
          timeoutMs: cal?.timeoutMs ?? 10_000,
          lookbackMs: (cal?.lookbackHours ?? 24) * 3_600_000,
          lookaheadMs: (cal?.lookaheadHours ?? 168) * 3_600_000,
          onResult: (r) => {
            if (!r.ok) log.warn({ err: r.error, failures: r.failures }, 'calendar poll failed');
          },
        })
      : null;
    // News provider: the SIMULATED feed in simulation mode; real providers once chosen.
    this.newsPoller = opts.simulation
      ? new NewsPoller({
          adapter: new SimulatedNewsAdapter(),
          service: this.news,
          clock,
          intervalMs: nc?.pollIntervalMs ?? 60_000,
          timeoutMs: nc?.timeoutMs ?? 10_000,
          lookbackMs: (nc?.lookbackHours ?? 6) * 3_600_000,
          onResult: (r) => {
            if (!r.ok) log.warn({ err: r.error, failures: r.failures }, 'news poll failed');
            else if (r.rejected.length > 0)
              log.warn({ rejected: r.rejected }, 'news items rejected');
          },
        })
      : null;
    const feeds = opts.feeds ?? [];
    if (this.simulation && feeds.length > 0) {
      throw new AstraError(
        'CONFIG_INVALID',
        'simulation and real chart feeds cannot run together (simulated and real prices would mix)',
      );
    }
    this.yahoo = feeds.includes('yahoo')
      ? new YahooFeed({
          config,
          clock,
          log,
          market: this.market,
          store: this.repos.marketBars,
          transport: opts.feedTransport,
        })
      : null;
    // Real provider adapters (owner's platform, Phase 2 remainder) are registered here.
    this.marketAdapters = this.simulation
      ? [this.simulation]
      : this.yahoo
        ? [this.yahoo.adapter]
        : [];
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  initializationError(): string | null {
    return this.initError;
  }

  /** Runs the startup sequence; on failure schedules a retry and stays fail-closed. */
  async start(): Promise<void> {
    // Startup work (ownership, restore, reconciliation) is awaited by `stop()` before it drains.
    const run = this.runStartup();
    this.starting = run;
    await run;
  }

  private starting: Promise<void> | null = null;

  private async runStartup(): Promise<void> {
    try {
      await this.initialize();
    } catch (err) {
      this.initError = errorMessage(err);
      this.log.error(
        { err: this.initError },
        'initialization failed; staying fail-closed and retrying',
      );
      if (!this.stopped) {
        this.initTimer = setTimeout(() => void this.start(), this.opts.initRetryMs ?? 5_000);
        this.initTimer.unref();
      }
    }
  }

  private async initialize(): Promise<void> {
    const { config, clock } = this;
    if (this.opts.runMigrations) {
      const { applied } = await migrate(this.sql, this.opts.migrationsDir);
      if (applied.length > 0) this.log.info({ applied }, 'database migrations applied');
    }
    await this.repos.configVersions.record(
      config.hash,
      config.canonical,
      clock.now().toISOString(),
    );
    await this.mode.load();
    await this.killSwitches.load();
    await this.ai.load();
    await this.restoreCalendarSafely();
    await this.health.seedFromHeartbeats();
    // DIRTY ownership is ACKed before any paper state is restored, mutated or read.
    await this.execution.acquireOwnership();
    await this.execution.restorePaperAccounts();
    await this.execution.reconcileAll();
    const warmed = await this.market.warmUp(this.repos.marketBars);
    this.log.info({ bars: warmed }, 'market-data bars loaded from the database');
    this.strategies.start();
    this.initialized = true;
    this.initError = null;
    await this.events.emit({
      level: 'INFO',
      component: 'system',
      type: 'STARTED',
      message: `ASTRA core started in ${this.mode.current()} mode (config ${config.hash.slice(0, 19)}…)`,
      data: { configHash: config.hash, warnings: config.warnings },
    });
    for (const w of config.warnings) this.log.warn({ config: true }, w);
    await this.startMarketAdapters();
    if (this.calendarPoller) {
      await this.calendarPoller.poll();
      await this.calendarStored;
      if (this.opts.startLoops) this.calendarPoller.start();
    }
    // Stored news restores the recent picture; the feed is fresh only after a new delivery.
    const retentionMs = (config.system.news?.retentionHours ?? 48) * 3_600_000;
    this.news.load(
      await this.repos.news.since(new Date(clock.now().getTime() - retentionMs).toISOString()),
    );
    if (this.newsPoller) {
      await this.newsPoller.poll();
      await this.newsRecorded;
      if (this.opts.startLoops) this.newsPoller.start();
    }
    if (this.opts.startLoops) {
      await this.cycle();
      this.loopTimer = setInterval(
        () => void this.cycle(),
        config.system.monitors.haltMonitorIntervalMs,
      );
      this.loopTimer.unref();
    }
  }

  /** Resolves once calendar persistence and every change event reported so far are complete. */
  async calendarEventsRecorded(): Promise<void> {
    await Promise.all([this.calendarEvents, this.calendarStored]);
  }

  /** Resolves once every news item accepted so far is stored and announced. */
  newsItemsRecorded(): Promise<void> {
    return this.newsRecorded;
  }

  /** Restore failures leave the calendar UNAVAILABLE (fail-closed); they never abort startup. */
  private async restoreCalendarSafely(): Promise<void> {
    try {
      await this.restoreCalendar();
    } catch (err) {
      const message = errorMessage(err);
      this.log.error({ err: message }, 'calendar restore failed; calendar stays unavailable');
      try {
        await this.events.emit({
          level: 'ERROR',
          component: 'calendar',
          type: 'CALENDAR_RESTORE_FAILED',
          message: `stored calendar state could not be restored: ${message}`,
        });
      } catch (eventErr) {
        this.log.error(
          { err: errorMessage(eventErr) },
          'calendar restore failure could not be recorded as a system event',
        );
      }
    }
  }

  /** Restore only the configured calendar horizon, preserving the original observation time. */
  private async restoreCalendar(): Promise<void> {
    const cal = this.config.system.calendar;
    const now = this.clock.now().getTime();
    const desiredFromMs = now - (cal?.lookbackHours ?? 24) * 3_600_000;
    const desiredToMs = now + (cal?.lookaheadHours ?? 168) * 3_600_000;
    const saved = await this.repos.calendar.latestOverlapping(
      new Date(desiredFromMs).toISOString(),
      new Date(desiredToMs).toISOString(),
      (reason) => this.log.error({ reason }, 'skipping malformed stored calendar window'),
    );
    if (!saved) return;

    const fromMs = Math.max(Date.parse(saved.value.from), desiredFromMs);
    const toMs = Math.min(Date.parse(saved.value.to), desiredToMs);
    if (toMs <= fromMs) return;
    const restored: ObservedOk<CalendarWindow> = {
      ...saved,
      value: {
        ...saved.value,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        events: saved.value.events.filter((event) => {
          const at = Date.parse(event.scheduledAt);
          return at >= fromMs && at <= toMs;
        }),
      },
    };
    this.calendar.restore(restored);
    this.log.info(
      {
        source: restored.source,
        sourceKind: restored.sourceKind,
        asOf: restored.asOf,
        events: restored.value.events.length,
      },
      'economic calendar restored from the database',
    );
  }

  /** Store an accepted calendar observation. Failures are visible but never fabricate freshness. */
  private async storeCalendarWindow(window: ObservedOk<CalendarWindow>): Promise<void> {
    try {
      await this.repos.calendar.record(window);
    } catch (err) {
      const message = errorMessage(err);
      this.log.error(
        { err: message, source: window.source },
        'calendar window could not be stored',
      );
      try {
        await this.events.emit({
          level: 'ERROR',
          component: 'calendar',
          type: 'CALENDAR_STORE_FAILED',
          message: `calendar window from ${window.source} could not be stored: ${message}`,
          data: { source: window.source, sourceKind: window.sourceKind, asOf: window.asOf },
        });
      } catch (eventErr) {
        this.log.error(
          { err: errorMessage(eventErr) },
          'calendar storage failure could not be recorded as a system event',
        );
      }
    }
  }

  /**
   * Stores accepted news items and raises a warning for each HIGH-impact item that concerns an
   * instrument of an active account. Never rejects (a storage failure is logged and raised).
   */
  private async recordNews(items: readonly ClassifiedNews[], source: string): Promise<void> {
    try {
      await this.repos.news.record(items);
    } catch (err) {
      this.log.error({ err: errorMessage(err), source }, 'news items could not be stored');
      await this.events.emit({
        level: 'ERROR',
        component: 'news',
        type: 'NEWS_STORE_FAILED',
        message: `${items.length} news item(s) from ${source} could not be stored: ${errorMessage(err)}`,
      });
    }
    for (const n of items) {
      const traded = n.affected.map((a) => a.symbol).filter((s) => this.tradedSymbols.includes(s));
      if (n.impact !== 'HIGH' || traded.length === 0) continue;
      await this.events.emit({
        level: 'WARN',
        component: 'news',
        type: 'NEWS_HIGH_IMPACT',
        message: `HIGH-impact ${n.category.toLowerCase().replace('_', ' ')} news for ${traded.join(', ')}: "${n.item.headline}" (${source})`,
        data: { key: n.key, category: n.category, symbols: traded, sourceKind: n.sourceKind },
      });
    }
  }

  /** Calendar changes become system events (restricted-impact ones as warnings). Never rejects. */
  private async reportCalendarChanges(
    changes: readonly CalendarChange[],
    source: string,
  ): Promise<void> {
    for (const c of changes) {
      const e = c.event;
      const what: Record<CalendarChange['type'], string> = {
        ADDED: `new ${e.impact}-impact event "${e.title}" at ${e.scheduledAt}`,
        REMOVED: `event "${e.title}" at ${e.scheduledAt} was removed`,
        RESCHEDULED: `event "${e.title}" moved from ${c.previous?.scheduledAt ?? '?'} to ${e.scheduledAt}`,
        IMPACT_CHANGED: `event "${e.title}" impact ${c.previous?.impact ?? '?'} → ${e.impact}`,
        ACTUAL_RELEASED: `"${e.title}" released: actual ${e.actual ?? '?'} (expected ${e.expected ?? '—'})`,
      };
      const restricted = this.config.system.decision.eventBlackout.impactLevels.includes(
        effectiveImpact(e.impact),
      );
      await this.events.emit({
        level: restricted && c.type !== 'ACTUAL_RELEASED' ? 'WARN' : 'INFO',
        component: 'calendar',
        type: `CALENDAR_${c.type}`,
        message: what[c.type],
        data: { source, eventId: e.id, previous: c.previous },
      });
    }
  }

  /** A failing adapter leaves its instruments without quotes → MARKET_DATA not ONLINE → no trades. */
  private async startMarketAdapters(): Promise<void> {
    for (const adapter of this.marketAdapters) {
      try {
        await adapter.start(this.market.sink(adapter), this.market.priceSink(adapter));
        this.log.info({ adapter: adapter.id, kind: adapter.kind }, 'market-data adapter started');
      } catch (err) {
        this.log.error(
          { adapter: adapter.id, err: errorMessage(err) },
          'market-data adapter failed to start',
        );
      }
    }
    // The chart feed's recent history loads in the background: the stream is already running
    // and bars from both land in the same series (duplicates are not added twice).
    if (this.yahoo) this.feedHistory = this.yahoo.backfill();
  }

  /** Resolves when the chart feeds' history load has finished (tests, diagnostics). */
  feedHistoryLoaded(): Promise<void> {
    return this.feedHistory;
  }

  /**
   * MARKET_DATA: fresh tradable quotes decide the status (the gate's view). A chart feed is
   * reported in the detail only — its prices never make market data ONLINE for trading.
   */
  private marketDataHealth(): { status: HealthStatus; detail: string } {
    const quotes = this.market.feedHealth(this.tradedSymbols);
    if (!this.yahoo) return quotes;
    const feed = this.yahoo.adapter.health();
    return {
      status: quotes.status,
      detail: `${quotes.detail}; chart feed ${this.yahoo.adapter.id} ${feed.status}: ${feed.detail} (prices only, never tradable quotes)`,
    };
  }

  /** One pass of the in-core safety loop. Never overlaps with itself. */
  async cycle(): Promise<void> {
    if (this.cycleRunning || !this.initialized || this.execution.closed) return;
    this.cycleRunning = true;
    try {
      // The whole pass (health probes, working orders, account sync, monitor, protection) is ONE
      // paper activity: a clean stop waits for it, and it is refused once the stop began.
      await this.execution.activity('safety-cycle', () => this.cyclePass());
    } catch (err) {
      this.health.report('RISK_ENGINE', 'ERROR', `safety loop failed: ${errorMessage(err)}`);
      this.log.error({ err: errorMessage(err) }, 'safety loop cycle failed');
    } finally {
      this.cycleRunning = false;
    }
  }

  private async cyclePass(): Promise<void> {
    this.market.advance();
    // Bar persistence never delays the safety checks below (flush logs, never rejects).
    void this.barPersister.flush();
    await this.health.probe();
    // Fills of resting LIMIT orders first, so the account sync sees the new positions.
    await this.workingOrders.run();
    await this.accounts.syncAll();
    await this.monitor.evaluate();
    this.journal.syncOpen(this.monitor.snapshot().accounts);
    await this.protection.run(this.monitor.snapshot().accounts);
    await this.killSwitches.autoClearDue();
    const expired = await this.repos.decisions.expireStaleApprovals(this.clock.now().toISOString());
    if (expired > 0) this.log.info({ expired }, 'expired stale approvals');
    this.health.report('RISK_ENGINE', 'ONLINE', 'safety loop healthy');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.initTimer);
    clearInterval(this.loopTimer);
    this.calendarPoller?.stop();
    this.newsPoller?.stop();
    this.yahoo?.cancel();
    await this.feedHistory;
    // Startup work (ownership, restore, reconciliation) must finish before anything is drained.
    await this.starting?.catch(() => undefined);
    for (const adapter of this.marketAdapters) {
      try {
        await adapter.stop();
      } catch (err) {
        this.log.error({ adapter: adapter.id, err: errorMessage(err) }, 'adapter stop failed');
      }
    }
    await this.calendarStored;
    await this.barPersister.flush();
    await this.execution.shutdown(); // rejects if the clean checkpoint could not be ACKed
  }
}
