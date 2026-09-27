/**
 * ASTRA Core runtime: composition root for every service, the startup sequence and the in-core
 * safety loop.
 *
 * Startup (ARCHITECTURE §18): config (already validated) → DB → migrations → config version →
 * trading mode → kill switches → heartbeats → paper state → reconciliation → monitors.
 * Until that completes, the effective mode is HALTED and the kill-switch registry is unloaded,
 * so every decision is rejected. If the database is unavailable, initialization is retried.
 */
import { errorMessage, type Clock } from '@astra/core';
import type { AstraConfig } from '@astra/config';
import {
  AccountRepository,
  AuditRepository,
  ConfigVersionRepository,
  DecisionRepository,
  EventRepository,
  ExecutionRepository,
  HeartbeatRepository,
  KillSwitchRepository,
  PaperBrokerStateRepository,
  SystemStateRepository,
  migrate,
  type Sql,
} from '@astra/db';
import type { Logger } from 'pino';
import { AccountService } from './account-service';
import { CalendarService } from './calendar';
import { DecisionService } from './decision-service';
import { EventBus } from './event-bus';
import { ExecutionService } from './execution-service';
import { HealthService } from './health-service';
import { KillSwitchService } from './kill-switch-service';
import { MarketDataService } from './market-data';
import { ModeService } from './mode-service';
import { SimulationFeed } from './simulation';

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
  /** Start the periodic safety loop (tests drive cycles manually). */
  readonly startLoops: boolean;
  readonly initRetryMs?: number;
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
  };
  readonly events: EventBus;
  readonly mode: ModeService;
  readonly killSwitches: KillSwitchService;
  readonly health: HealthService;
  readonly market: MarketDataService;
  readonly calendar: CalendarService;
  readonly execution: ExecutionService;
  readonly accounts: AccountService;
  readonly decisions: DecisionService;
  readonly simulation: SimulationFeed | null;

  private initialized = false;
  private initError: string | null = null;
  private loopTimer: NodeJS.Timeout | undefined;
  private initTimer: NodeJS.Timeout | undefined;
  private cycleRunning = false;
  private stopped = false;

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
    };
    this.events = new EventBus(this.repos.events, clock, log);
    this.mode = new ModeService(this.repos.system, clock, this.events, opts.liveTradingAuthorized);
    this.killSwitches = new KillSwitchService(this.repos.killSwitches, clock, this.events);
    // `execution` is assigned below; the health probe reads adapters lazily.
    this.health = new HealthService(clock, config.system.health.staleAfterMs, {
      sql,
      heartbeats: this.repos.heartbeats,
      adapters: () => [...this.execution.adapters.values()],
    });
    this.market = new MarketDataService(
      (s) => config.instruments.has(s),
      (source) => this.health.report('MARKET_DATA', 'ONLINE', `quotes flowing (${source})`),
    );
    this.calendar = new CalendarService(() =>
      this.health.report('CALENDAR', 'ONLINE', 'calendar window received'),
    );
    this.execution = new ExecutionService({
      config,
      store: this.repos.execution,
      paperState: this.repos.paperState,
      mode: this.mode,
      killSwitches: this.killSwitches,
      health: this.health,
      events: this.events,
      clock,
      log,
      liveTradingEnvironmentAuthorized: opts.liveTradingAuthorized,
    });
    this.market.onQuote((q) => this.execution.paper().onQuote(q));
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
    });
    this.decisions = new DecisionService({
      config,
      clock,
      mode: this.mode,
      killSwitches: this.killSwitches,
      health: this.health,
      market: this.market,
      calendar: this.calendar,
      accounts: this.accounts,
      decisions: this.repos.decisions,
      executionStore: this.repos.execution,
      execution: this.execution,
      events: this.events,
      liveTradingEnvironmentAuthorized: opts.liveTradingAuthorized,
    });
    this.simulation =
      opts.simulation && config.system.simulation
        ? new SimulationFeed(
            config.system.simulation,
            (s) => config.instruments.get(s)?.tickSize,
            this.market,
            this.calendar,
            clock,
          )
        : null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  initializationError(): string | null {
    return this.initError;
  }

  /** Runs the startup sequence; on failure schedules a retry and stays fail-closed. */
  async start(): Promise<void> {
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
    await this.health.seedFromHeartbeats();
    await this.execution.restorePaperAccounts();
    await this.execution.reconcileAll();
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
    this.simulation?.start();
    if (this.opts.startLoops) {
      await this.cycle();
      this.loopTimer = setInterval(
        () => void this.cycle(),
        config.system.monitors.haltMonitorIntervalMs,
      );
      this.loopTimer.unref();
    }
  }

  /** One pass of the in-core safety loop. Never overlaps with itself. */
  async cycle(): Promise<void> {
    if (this.cycleRunning || !this.initialized) return;
    this.cycleRunning = true;
    try {
      await this.health.probe();
      await this.accounts.syncAll();
      await this.killSwitches.autoClearDue();
      const expired = await this.repos.decisions.expireStaleApprovals(
        this.clock.now().toISOString(),
      );
      if (expired > 0) this.log.info({ expired }, 'expired stale approvals');
      this.health.report('RISK_ENGINE', 'ONLINE', 'safety loop healthy');
    } catch (err) {
      this.health.report('RISK_ENGINE', 'ERROR', `safety loop failed: ${errorMessage(err)}`);
      this.log.error({ err: errorMessage(err) }, 'safety loop cycle failed');
    } finally {
      this.cycleRunning = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.initTimer);
    clearInterval(this.loopTimer);
    this.simulation?.stop();
    await this.execution.flush();
  }
}
