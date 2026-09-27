/**
 * In-browser ASTRA demo runtime. Wires the REAL domain engines — prop-firm rules, risk,
 * kill switches, the decision gate, the paper broker and the execution gateway — together in
 * memory, exactly as the server does, but with SIMULATED prices, a simulated calendar, a
 * simulated n8n heartbeat and a simulated clock. Nothing here is presented as real market data.
 */
import {
  COMPONENT_IDS,
  ManualClock,
  canonicalJson,
  marketStatus,
  newId,
  notObserved,
  observed,
  tradingDayWindow,
  type AccountActivity,
  type AccountDefinition,
  type AccountSnapshot,
  type CalendarWindow,
  type ComponentId,
  type Observed,
  type ObservedOk,
  type InstrumentSpec,
  type Quote,
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
import { MarketDataService, type MarketSnapshot } from '@astra/market-data';
import { classifyAccountHealth, type AccountHealthAssessment } from '@astra/risk';
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
  readonly events: SystemEvent[] = [];
  readonly audit: AuditEntry[] = [];
  readonly closedTrades = new Map<string, ClosedTrade[]>();
  readonly accounts = new Map<string, AccountEntry>();
  /** The real market-data engine (quality monitor, bars, snapshots) fed by the simulator. */
  readonly market: MarketDataService;
  /** Instruments traded by ACTIVE accounts: MARKET_DATA is ONLINE only when all are fresh. */
  readonly tradedSymbols: readonly string[];

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
    const traded = new Set<string>();
    for (const a of this.config.accounts.values())
      if (a.status === 'ACTIVE') for (const sym of a.instruments) traded.add(sym);
    this.tradedSymbols = [...traded].sort();
    this.historyQuotes = this.simulateHistory(historyStart, start);
    this.clock.set(start);
    this.killSwitches = new KillSwitchRegistry(this.clock);
    this.killSwitches.load([]);
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
    ))
      this.paper.onQuote(quote);
    this.market.advance();
    const h = this.market.feedHealth(this.tradedSymbols);
    this.health.report('MARKET_DATA', h.status, `${h.detail} (SIMULATED demo feed)`);
    this.health.report('CALENDAR', 'ONLINE', 'SIMULATED calendar window (demo, no events)');
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

  latestQuote(symbol: string): Observed<Quote> {
    return this.market.latest(symbol);
  }

  allQuotes(): ObservedOk<Quote>[] {
    return this.market.all();
  }

  snapshots(): MarketSnapshot[] {
    return this.market.snapshots();
  }

  calendar(): Observed<CalendarWindow> {
    const now = this.clock.now();
    return observed(
      {
        from: new Date(now.getTime() - 86_400_000).toISOString(),
        to: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        events: [],
      },
      { source: 'simulation', sourceKind: 'SIMULATED', asOf: now.toISOString() },
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
    let streak = 0;
    for (const t of this.closedTrades.get(accountId) ?? []) {
      if (t.realizedPnl < 0) streak++;
      else break;
    }
    return { tradingDayKey: w.key, tradesToday, consecutiveLosses: streak };
  }

  private syncing = false;
  private historyQuotes = 0;

  private async syncAccounts(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      await this.syncAll();
    } finally {
      this.syncing = false;
    }
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
        instruments: (s) => this.config.instruments.get(s),
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
    const { config } = this;
    const inputs = await assembleDecisionInputs({
      candidate,
      config: {
        configHash: config.hash,
        policy: config.system.decision,
        account: (id) => config.accounts.get(id),
        profile: (id) => config.profiles.get(id),
        riskPolicy: (id) => config.riskPolicies.get(id),
        strategy: (id) => config.strategies.get(id),
        instrument: (s) => config.instruments.get(s),
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
        newsRisk: () =>
          Promise.resolve(
            notObserved('UNAVAILABLE', 'news engine not implemented yet (Phase 4)', 'news'),
          ),
        aiAnalysis: () =>
          Promise.resolve(
            notObserved('UNAVAILABLE', 'AI engine not implemented yet (Phase 6)', 'ai'),
          ),
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
