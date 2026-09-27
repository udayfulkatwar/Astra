/**
 * Backtest replay (ADR-0016). Replays M1 bars, in order, through the SAME components that run in
 * real time: the decision gate (all 21 checks, mode BACKTEST inside the simulator), position
 * sizing, prop-firm rules incl. the trailing path, account tracking, the position monitor and
 * automatic protection, and the trade journal.
 *
 * No lookahead, by construction: at each M1 close the engine knows only bars that have closed;
 * the strategy sees only completed higher-timeframe bars; every order fills at the NEXT bar's
 * open (see `BacktestBroker` for the pessimistic fill model). Deterministic: same inputs → same
 * result (ids are sequence numbers, time is the replayed time).
 */
import { SimulatedCalendarAdapter } from '@astra/calendar';
import {
  AstraError,
  ManualClock,
  notObserved,
  observed,
  tradingDayWindow,
  type AccountActivity,
  type AccountSnapshot,
  type CalendarWindow,
  type ComponentHealth,
  type DataSourceKind,
  type Observed,
  type OpenPosition,
  type Quote,
  type StrategyDefinition,
  type TradeCandidate,
} from '@astra/core';
import {
  DecisionEngine,
  assembleDecisionInputs,
  type DecisionConfigView,
  type DecisionDataPorts,
  type DecisionStatePorts,
  type TradeDecision,
} from '@astra/decision';
import {
  buildJournalEntry,
  journalSummary,
  type DecisionInput,
  type ExcursionRecord,
  type JournalEntry,
  type JournalSummary,
  type OrderInput,
} from '@astra/journal';
import type { Bar } from '@astra/market-data';
import { analyzeStructure, type StructureParams } from '@astra/market-structure';
import {
  computeAccountState,
  initAccountTracking,
  updateAccountTracking,
  type AccountTracking,
} from '@astra/prop-firm';
import {
  ProtectionEvaluator,
  monitorAccount,
  type MonitorPolicy,
  type ProtectionPolicy,
  type ProtectiveTrigger,
} from '@astra/risk';
import { KillSwitchRegistry } from '@astra/safety';
import { BacktestBroker, type BacktestClosedTrade } from './broker';
import { BacktestConfigSchema, type BacktestConfig, type BacktestConfigInput } from './config';
import { Resampler } from './resample';
import { structureBreakoutTemplate, type BacktestStrategy } from './strategy';

export const BACKTEST_ENGINE_VERSION = 1;
/** Upper bound on M1 bars per run (≈ 6 months of round-the-clock minutes). */
export const MAX_BACKTEST_BARS = 260_000;
const STRUCTURE_WINDOW = 300;
const EQUITY_POINTS = 400;
const DECISION_LOG = 500;
const YIELD_EVERY = 1_000;
const SYSTEM = { type: 'SYSTEM' as const, id: 'backtest' };

/** Validated configuration and policies the replay uses (the same objects the live core uses). */
export interface BacktestEnvironment {
  readonly config: DecisionConfigView;
  readonly monitorPolicy: MonitorPolicy;
  readonly protectionPolicy: ProtectionPolicy;
  readonly structureParams?: Partial<StructureParams> | undefined;
  readonly lateObservationThresholdMs: number;
}

export interface EquityPoint {
  readonly t: string;
  readonly balance: number;
  readonly equity: number;
  /** Lowest equity marked within the point's interval (the curve is downsampled). */
  readonly low: number;
}

export interface DecisionLogEntry {
  readonly decisionId: string;
  readonly at: string;
  readonly direction: string;
  readonly status: 'APPROVED' | 'REJECTED';
  readonly quantity: number | null;
  readonly reasons: string[];
  /** APPROVED only: FILLED, EXPIRED (not filled before the approval expired) or PENDING at end. */
  readonly fill: 'FILLED' | 'EXPIRED' | 'PENDING' | null;
}

export interface BacktestProtectiveAction {
  readonly at: string;
  readonly trigger: ProtectiveTrigger;
  readonly positionId: string;
  readonly reason: string;
  readonly blockedAccount: 'MANUAL' | 'NEXT_TRADING_DAY' | null;
}

export interface BacktestResult {
  readonly engineVersion: number;
  /** One-line honest label shown with every result. */
  readonly label: string;
  readonly config: BacktestConfig;
  readonly configHash: string;
  readonly strategy: Pick<StrategyDefinition, 'id' | 'name' | 'version' | 'ownership'>;
  readonly account: {
    readonly id: string;
    readonly profileId: string;
    readonly currency: string;
    readonly startingBalance: number;
  };
  readonly data: {
    readonly symbol: string;
    readonly from: string;
    readonly to: string;
    readonly m1Bars: number;
    readonly strategyBars: number;
    readonly sourceKinds: DataSourceKind[];
    readonly sources: string[];
    /** Gaps longer than 5 minutes between consecutive M1 bars (sessions closed or data missing). */
    readonly gaps: number;
  };
  readonly assumptions: string[];
  readonly warnings: string[];
  readonly performance: {
    readonly startingBalance: number;
    readonly endingBalance: number;
    readonly endingEquity: number;
    /** Ending equity − starting balance (includes open positions at their last mark). */
    readonly netChange: number;
    readonly returnPct: number;
    /** Largest peak-to-trough fall of equity marked at each M1 close. */
    readonly maxDrawdown: number;
    readonly maxDrawdownPct: number;
    readonly maxDrawdownAt: string | null;
  };
  readonly summary: JournalSummary;
  readonly trades: JournalEntry[];
  readonly equity: EquityPoint[];
  readonly decisions: {
    readonly signals: number;
    readonly approved: number;
    readonly rejected: number;
    readonly filled: number;
    readonly expired: number;
    /** Setups the strategy saw but did not propose (e.g. stop too tight), by reason. */
    readonly skipped: { reason: string; count: number }[];
    /** Mandatory checks that blocked, by check id (a decision can be blocked by several). */
    readonly blockedBy: { checkId: string; count: number; example: string }[];
    /** Most recent decisions (bounded). */
    readonly log: DecisionLogEntry[];
  };
  readonly protective: BacktestProtectiveAction[];
  /** The account's first hard-limit breach (the evaluation would have failed here). */
  readonly breach: { at: string; detail: string } | null;
  readonly openAtEnd: OpenPosition[];
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new AstraError('VALIDATION', message, details);
}

function validateBars(bars: readonly Bar[], symbol: string): void {
  if (bars.length === 0) fail('no bars to replay');
  if (bars.length > MAX_BACKTEST_BARS)
    fail(`too many bars (${bars.length}; at most ${MAX_BACKTEST_BARS} per run)`);
  let prev = -Infinity;
  for (const b of bars) {
    if (b.symbol !== symbol) fail(`bar for ${b.symbol} in a ${symbol} backtest`);
    if (b.timeframe !== 'M1') fail(`backtests replay M1 bars (got ${b.timeframe})`);
    if (!b.complete) fail(`incomplete bar at ${b.openTime}`);
    const open = Date.parse(b.openTime);
    if (!(open > prev)) fail(`bars not strictly ordered at ${b.openTime}`);
    if (!(Date.parse(b.closeTime) > open)) fail(`bar closes before it opens at ${b.openTime}`);
    if (!(b.low > 0 && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close)))
      fail(`invalid OHLC at ${b.openTime}`);
    prev = open;
  }
}

export async function runBacktest(params: {
  config: BacktestConfigInput;
  bars: readonly Bar[];
  env: BacktestEnvironment;
  /**
   * Called every YIELD_EVERY bars so a host can keep its event loop responsive (the API runs
   * replays next to the real-time safety loop).
   */
  yieldControl?: () => Promise<void>;
}): Promise<BacktestResult> {
  const config = BacktestConfigSchema.parse(params.config);
  const { env, bars } = params;
  const base = env.config;
  const symbol = config.symbol;

  const configured = base.account(config.accountId);
  if (!configured) fail(`account ${config.accountId} not found`);
  const profile = base.profile(configured.propFirmProfileId);
  if (!profile) fail(`prop-firm profile ${configured.propFirmProfileId} not found`);
  const riskPolicy = base.riskPolicy(configured.riskPolicyId);
  if (!riskPolicy) fail(`risk policy ${configured.riskPolicyId} not found`);
  const spec = base.instrument(symbol);
  if (!spec) fail(`no instrument spec for ${symbol}`);
  if (!configured.instruments.includes(symbol))
    fail(`${symbol} is not enabled for account ${configured.id}`);
  if (!spec.tradingHours) fail(`trading hours not configured for ${symbol}`);
  validateBars(bars, symbol);

  const strategy: BacktestStrategy = structureBreakoutTemplate(symbol, config.strategy);
  // The replay enables the strategy on a COPY of the account; configuration is not changed.
  const account = { ...configured, strategies: [...configured.strategies, strategy.definition.id] };
  const view: DecisionConfigView = {
    configHash: base.configHash,
    policy: base.policy,
    account: (id) => (id === account.id ? account : base.account(id)),
    profile: (id) => base.profile(id),
    riskPolicy: (id) => base.riskPolicy(id),
    strategy: (id) => (id === strategy.definition.id ? strategy.definition : base.strategy(id)),
    instrument: (s) => base.instrument(s),
    sessions: () => base.sessions(),
  };

  let seq = 0;
  const first = bars[0]!;
  const clock = new ManualClock(first.openTime);
  const killSwitches = new KillSwitchRegistry(clock);
  killSwitches.load([]);
  const broker = new BacktestBroker({
    accountId: account.id,
    currency: account.currency,
    startingBalance: profile.accountSize,
    spec,
    model: { spreadTicks: config.spreadTicks, slippageTicks: config.slippageTicks },
  });
  const resampler = new Resampler(strategy.timeframe, spec.tradingHours);
  const evaluator = new ProtectionEvaluator(env.protectionPolicy);
  const engine = new DecisionEngine({ newApprovalId: () => `bt-apr-${seq}` });
  const calendarAdapter =
    config.calendar === 'SIMULATED_SCHEDULE' ? new SimulatedCalendarAdapter() : null;
  const lookup = (s: string) => base.instrument(s);
  const half = (config.spreadTicks * spec.tickSize) / 2;
  // Replayed recordings are HISTORICAL; generated bars stay SIMULATED.
  const replayKind = (b: Bar): DataSourceKind =>
    b.sourceKind === 'SIMULATED' ? 'SIMULATED' : 'HISTORICAL';

  let tracking: AccountTracking | null = null;
  const tfBars: Bar[] = [];
  let strategyBars = 0;
  const trades: JournalEntry[] = [];
  const closedPnl: number[] = [];
  const filledByDay = new Map<string, number>();
  const orders = new Map<string, { order: OrderInput; decision: DecisionInput; log: number }>();
  const excursions = new Map<string, { best: number; worst: number; from: string; bars: number }>();
  const log: DecisionLogEntry[] = [];
  let logged = 0;
  const counts = { signals: 0, approved: 0, rejected: 0, filled: 0, expired: 0 };
  const skipped = new Map<string, number>();
  const blockedBy = new Map<string, { count: number; example: string }>();
  const protective: BacktestProtectiveAction[] = [];
  const closing = new Set<string>();
  let breach: BacktestResult['breach'] = null;
  /** First decision made while the losing-streak limit was reached. */
  let streakStop: string | null = null;
  const marks: { t: string; balance: number; equity: number }[] = [];
  const sourceKinds = new Set<DataSourceKind>();
  const sources = new Set<string>();
  let gaps = 0;
  let prevClose: number | null = null;

  const dayKey = (at: string) => tradingDayWindow(new Date(at), profile.tradingDayReset).key;

  const setLog = (i: number, fill: DecisionLogEntry['fill']) => {
    const idx = i - (logged - log.length);
    const e = log[idx];
    if (idx >= 0 && e) log[idx] = { ...e, fill };
  };

  let replayed = 0;
  for (const bar of bars) {
    if (params.yieldControl && ++replayed % YIELD_EVERY === 0) await params.yieldControl();
    sourceKinds.add(bar.sourceKind);
    sources.add(bar.source);
    const openMs = Date.parse(bar.openTime);
    if (prevClose !== null && openMs - prevClose > 5 * 60_000) gaps++;
    prevClose = Date.parse(bar.closeTime);

    // 1. Orders decided at the previous close execute at this open; then intrabar exits.
    clock.set(bar.openTime);
    const out = broker.onBar(bar);
    for (const o of out.expired) {
      counts.expired++;
      const rec = orders.get(o.clientOrderId);
      if (rec) setLog(rec.log, 'EXPIRED');
    }
    for (const p of out.opened) {
      counts.filled++;
      const k = dayKey(p.openedAt);
      filledByDay.set(k, (filledByDay.get(k) ?? 0) + 1);
      excursions.set(p.positionId, {
        best: p.entryPrice,
        worst: p.entryPrice,
        from: p.openedAt,
        bars: 0,
      });
      const rec = orders.get(p.clientOrderId);
      if (rec) setLog(rec.log, 'FILLED');
    }
    for (const x of out.exposed) {
      const e = excursions.get(x.position.positionId);
      if (!e) continue;
      const long = x.position.direction === 'LONG';
      e.best = long ? Math.max(e.best, x.bestExit) : Math.min(e.best, x.bestExit);
      e.worst = long ? Math.min(e.worst, x.worstExit) : Math.max(e.worst, x.worstExit);
      e.bars++;
    }
    for (const t of out.closed) journal(t);

    // 2. State at this bar's close.
    const now = bar.closeTime;
    clock.set(now);
    for (const s of killSwitches.dueForAutoClear())
      killSwitches.apply(
        killSwitches.planDeactivation({
          scope: s.scope,
          target: s.target,
          reason: 'next trading day',
          actor: SYSTEM,
        }),
      );
    const snapshot = broker.snapshot(now, bar.close);
    const today = dayKey(now);
    tracking = tracking
      ? updateAccountTracking(tracking, snapshot, {
          reset: profile.tradingDayReset,
          tradedToday: (filledByDay.get(today) ?? 0) > 0,
          lateObservationThresholdMs: env.lateObservationThresholdMs,
        })
      : initAccountTracking({
          accountId: account.id,
          initialBalance: profile.accountSize,
          snapshot,
          reset: profile.tradingDayReset,
        });
    marks.push({ t: now, balance: snapshot.balance, equity: snapshot.equity });

    const quote: Quote = { symbol, bid: bar.close - half, ask: bar.close + half, asOf: now };
    const quoteObs = observed(quote, {
      source: 'backtest-replay',
      sourceKind: replayKind(bar),
      asOf: now,
    });
    const snapObs = observed(snapshot, {
      source: 'backtest-broker',
      sourceKind: 'SIMULATED',
      asOf: now,
    });

    // 3. Prop-firm state, monitor and automatic protection (only when something is at stake).
    if (snapshot.openPositions.length > 0 || out.closed.length > 0) {
      const state = computeAccountState({ profile, tracking, snapshot, instruments: lookup });
      if (state.breached && !breach) {
        breach = {
          at: now,
          detail: `hard limit crossed (equity ${state.equity}, distance to breach ${state.distanceToBreach})`,
        };
        killSwitches.activate({
          scope: 'ACCOUNT',
          target: account.id,
          reason: 'prop-firm hard limit breached in this backtest (account failed)',
          actor: SYSTEM,
        });
      }
      if (snapshot.openPositions.length > 0) {
        const mon = monitorAccount({
          accountId: account.id,
          now: new Date(now),
          snapshot: snapObs,
          state,
          drawdownRule: profile.maxDrawdown,
          instruments: lookup,
          quote: () => quoteObs,
          policy: env.monitorPolicy,
        });
        const actions = evaluator.evaluate([mon], {
          now: new Date(now),
          holding: () => profile.holding,
        });
        for (const a of actions) {
          if (closing.has(a.positionId)) continue;
          if (a.blockAccount && !killSwitches.get('ACCOUNT', account.id)?.active) {
            killSwitches.activate({
              scope: 'ACCOUNT',
              target: account.id,
              reason: `automatic protection: ${a.reason}`,
              actor: SYSTEM,
              ...(a.blockAccount === 'NEXT_TRADING_DAY'
                ? {
                    clearPolicy: 'NEXT_TRADING_DAY' as const,
                    autoClearAt: tradingDayWindow(
                      new Date(now),
                      profile.tradingDayReset,
                    ).end.toISOString(),
                  }
                : { clearPolicy: 'MANUAL' as const }),
            });
          }
          closing.add(a.positionId);
          broker.queueClose(a.positionId);
          protective.push({
            at: now,
            trigger: a.trigger,
            positionId: a.positionId,
            reason: a.reason,
            blockedAccount: a.blockAccount,
          });
        }
      }
    }

    // 4. Strategy on completed higher-timeframe bars → the real decision gate.
    for (const tf of resampler.push(bar)) {
      strategyBars++;
      tfBars.push(tf);
      if (tfBars.length > STRUCTURE_WINDOW) tfBars.shift();
      const flat = snapshot.openPositions.length === 0 && !broker.hasPendingEntry();
      const structure = analyzeStructure({
        bars: tfBars,
        symbol,
        timeframe: strategy.timeframe,
        tickSize: spec.tickSize,
        params: env.structureParams,
      });
      const res = strategy.onBar({
        now,
        symbol,
        tickSize: spec.tickSize,
        spreadTicks: config.spreadTicks,
        bars: tfBars,
        structure,
        flat,
      });
      if (res.kind === 'SKIP') {
        const key = res.reason.replace(/[\d.]+ ticks away/, 'too close');
        skipped.set(key, (skipped.get(key) ?? 0) + 1);
      }
      if (res.kind !== 'SIGNAL') continue;

      seq++;
      counts.signals++;
      const candidate: TradeCandidate = {
        accountId: account.id,
        submittedAt: now,
        signal: {
          id: `bt-sig-${seq}`,
          strategyId: strategy.definition.id,
          symbol,
          direction: res.signal.direction,
          setupState: 'QUALIFIED',
          entryType: 'MARKET',
          entry: res.signal.entry,
          stop: res.signal.stop,
          target: res.signal.target,
          timeframe: strategy.timeframe,
          detectedAt: now,
          rationale: res.signal.rationale,
          features: res.signal.features,
        },
      };
      const activity: AccountActivity = {
        tradingDayKey: today,
        tradesToday: filledByDay.get(today) ?? 0,
        consecutiveLosses: streak(closedPnl),
      };
      if (activity.consecutiveLosses >= riskPolicy.activity.maxConsecutiveLosses)
        streakStop ??= now;
      const d = await decide(candidate, { at: now, quoteObs, snapObs, tracking, activity });
      const logIndex = logged++;
      log.push({
        decisionId: d.decisionId,
        at: now,
        direction: d.direction,
        status: d.status,
        quantity: d.orderPlan?.quantity ?? null,
        reasons: d.reasons.slice(0, 4),
        fill: d.status === 'APPROVED' ? 'PENDING' : null,
      });
      if (log.length > DECISION_LOG) log.shift();
      if (d.status === 'APPROVED' && d.orderPlan && d.approval) {
        counts.approved++;
        const clientOrderId = `bt-ord-${seq}`;
        orders.set(clientOrderId, {
          order: {
            decisionId: d.decisionId,
            strategyId: d.strategyId,
            signalId: d.signalId,
            mode: d.mode,
            plannedEntry: d.orderPlan.entry,
            stopLoss: d.orderPlan.stop,
            takeProfit: d.orderPlan.target,
            quantity: d.orderPlan.quantity,
          },
          decision: {
            decidedAt: d.decidedAt,
            configHash: d.configHash,
            plannedRisk: d.sizing?.dollarRisk ?? null,
          },
          log: logIndex,
        });
        broker.queueEntry({
          clientOrderId,
          direction: d.orderPlan.direction,
          quantity: d.orderPlan.quantity,
          stop: d.orderPlan.stop,
          target: d.orderPlan.target,
          expiresAt: d.approval.expiresAt,
        });
      } else {
        counts.rejected++;
        for (const c of d.checks)
          if (c.mandatory && c.verdict !== 'PASS') {
            const b = blockedBy.get(c.checkId) ?? { count: 0, example: c.reasons[0] ?? c.verdict };
            b.count++;
            blockedBy.set(c.checkId, b);
          }
      }
    }
  }

  function journal(t: BacktestClosedTrade): void {
    closing.delete(t.positionId);
    closedPnl.push(t.realizedPnl);
    const rec = orders.get(t.clientOrderId) ?? null;
    const e = excursions.get(t.positionId);
    excursions.delete(t.positionId);
    const long = t.direction === 'LONG';
    // The exit bar's path is unknown; only its exit price is added.
    const excursion: ExcursionRecord | null = e
      ? {
          bestPrice: long ? Math.max(e.best, t.exitPrice) : Math.min(e.best, t.exitPrice),
          worstPrice: long ? Math.min(e.worst, t.exitPrice) : Math.max(e.worst, t.exitPrice),
          observedFrom: e.from,
          coverage: 'FULL',
          quotes: e.bars,
        }
      : null;
    trades.push(
      buildJournalEntry({
        trade: { ...t, accountId: account.id },
        order: rec?.order ?? null,
        decision: rec?.decision ?? null,
        spec,
        excursion,
      }),
    );
  }

  async function decide(
    candidate: TradeCandidate,
    ctx: {
      at: string;
      quoteObs: Observed<Quote>;
      snapObs: Observed<AccountSnapshot>;
      tracking: AccountTracking;
      activity: AccountActivity;
    },
  ): Promise<TradeDecision> {
    const at = ctx.at;
    const meta = { source: 'backtest-broker', sourceKind: 'SIMULATED' as const, asOf: at };
    const data: DecisionDataPorts = {
      quote: () => Promise.resolve(ctx.quoteObs),
      accountSnapshot: () => Promise.resolve(ctx.snapObs),
      tracking: () => Promise.resolve(observed(ctx.tracking, meta)),
      activity: () => Promise.resolve(observed(ctx.activity, meta)),
      calendar: (from, to) => Promise.resolve(calendarWindow(from, to, at)),
      newsRisk: () =>
        Promise.resolve(notObserved('UNAVAILABLE', 'no historical news in backtests', 'news')),
      aiAnalysis: () =>
        Promise.resolve(notObserved('UNAVAILABLE', 'no AI analysis in backtests', 'ai')),
      duplicates: () =>
        Promise.resolve(
          observed(
            { priorApprovedDecisionId: null, workingOrderForSymbol: broker.hasPendingEntry() },
            meta,
          ),
        ),
    };
    const health: ComponentHealth[] = base.policy.requiredComponents.map((component) => ({
      component,
      status: 'ONLINE',
      detail: 'backtest simulator',
      checkedAt: at,
    }));
    const state: DecisionStatePorts = {
      mode: () => 'BACKTEST',
      killSwitches: (ctx) => killSwitches.evaluate(ctx),
      componentHealth: () => health,
      execution: () => ({
        adapterId: 'backtest-broker',
        adapterKind: null,
        health: 'ONLINE',
        reconciled: true,
        supportedEntryTypes: ['MARKET'],
      }),
      liveTradingEnvironmentAuthorized: () => false,
    };
    const inputs = await assembleDecisionInputs({
      candidate,
      config: view,
      data,
      state,
      clock,
      timeoutMs: 5_000,
      decisionId: `bt-dec-${seq}`,
      environment: 'BACKTEST_SIMULATOR',
    });
    return engine.evaluate(inputs);
  }

  function calendarWindow(from: Date, to: Date, at: string) {
    const meta = { sourceKind: 'SIMULATED' as const, asOf: at };
    if (calendarAdapter)
      return observed<CalendarWindow>(calendarAdapter.window({ from, to }), {
        source: `calendar:${calendarAdapter.id}`,
        ...meta,
      });
    // NOT_MODELLED: the owner chose to run without calendar data; stated in every result.
    return observed<CalendarWindow>(
      { from: from.toISOString(), to: to.toISOString(), events: [] },
      { source: 'calendar-not-modelled', ...meta },
    );
  }

  // Results.
  const last = bars.at(-1)!;
  const final = broker.snapshot(last.closeTime, last.close);

  const perf = performance(profile.accountSize, final, marks);
  const simulated = sourceKinds.has('SIMULATED');
  const warnings = [
    ...(simulated
      ? ['Engine test on SIMULATED data — not evidence of performance.']
      : ['Past results on historical data do not predict future results.']),
    `Strategy "${strategy.definition.name}" is a TEMPLATE, not your strategy — it only exercises the engine.`,
    ...(config.calendar === 'NOT_MODELLED'
      ? ['Economic-event blackout NOT applied: no calendar data was used for this period.']
      : ['Economic events come from the SIMULATED placeholder schedule, not a real calendar.']),
    ...(profile.verification.status !== 'USER_VERIFIED'
      ? [`Prop-firm profile ${profile.id} is ${profile.verification.status} (not owner-verified).`]
      : []),
    ...(spec.verification.status !== 'USER_VERIFIED'
      ? [`Instrument spec ${spec.symbol} is ${spec.verification.status} (not owner-verified).`]
      : []),
    ...(base.policy.news.required
      ? [
          'News assessment is required by policy but no historical news exists: every trade is blocked.',
        ]
      : []),
    ...(streakStop
      ? [
          `From ${streakStop} new trades were blocked after ${riskPolicy.activity.maxConsecutiveLosses} losses in a row (risk policy ${riskPolicy.id}); only a winning trade resets that count, so the block lasted to the end — the live system behaves the same way today.`,
        ]
      : []),
    ...(final.openPositions.length > 0
      ? [`${final.openPositions.length} position(s) still open at the end (marked, not closed).`]
      : []),
  ];

  return {
    engineVersion: BACKTEST_ENGINE_VERSION,
    label: simulated
      ? 'Engine test on SIMULATED data — not evidence of performance'
      : 'Historical replay — past results do not predict future results',
    config,
    configHash: base.configHash,
    strategy: {
      id: strategy.definition.id,
      name: strategy.definition.name,
      version: strategy.definition.version,
      ownership: strategy.definition.ownership,
    },
    account: {
      id: account.id,
      profileId: profile.id,
      currency: account.currency,
      startingBalance: profile.accountSize,
    },
    data: {
      symbol,
      from: first.openTime,
      to: last.closeTime,
      m1Bars: bars.length,
      strategyBars,
      sourceKinds: [...sourceKinds].sort(),
      sources: [...sources].sort(),
      gaps,
    },
    assumptions: [
      `Signals see only closed ${strategy.timeframe} bars; every order fills at the next M1 bar's open.`,
      `Entries at the ask (long) / bid (short) with a ${config.spreadTicks}-tick spread and ${config.slippageTicks} tick(s) of adverse slippage.`,
      'When one bar reaches both the stop and the target, the stop is assumed to have been hit first.',
      `Stops and protective closes pay ${config.slippageTicks} tick(s) of slippage; a stop gapped through fills at the open; targets fill at the target, never better.`,
      `Commission from the instrument spec (${spec.costs.commissionPerUnitRoundTurn} ${account.currency} per contract round turn).`,
      'Every signal goes through the real decision gate (mode BACKTEST inside the simulator), sizing, prop-firm rules, account tracking, the position monitor and automatic protection.',
      `The TEMPLATE strategy is enabled on a copy of account ${account.id} for this run only.`,
      'Equity is marked at every M1 close; drawdown between closes is not measured.',
    ],
    warnings,
    performance: perf,
    summary: journalSummary(trades),
    trades,
    equity: downsample(marks),
    decisions: {
      ...counts,
      skipped: [...skipped]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      blockedBy: [...blockedBy]
        .map(([checkId, v]) => ({ checkId, ...v }))
        .sort((a, b) => b.count - a.count || a.checkId.localeCompare(b.checkId)),
      log,
    },
    protective,
    breach,
    openAtEnd: final.openPositions,
  };
}

/** Current losing streak from the newest closed trade backwards (gross P&L < 0), as live. */
function streak(pnls: readonly number[]): number {
  let n = 0;
  for (let i = pnls.length - 1; i >= 0 && pnls[i]! < 0; i--) n++;
  return n;
}

function performance(
  start: number,
  final: AccountSnapshot,
  marks: readonly { t: string; equity: number }[],
): BacktestResult['performance'] {
  let peak = start;
  let maxDd = 0;
  let maxDdPct = 0;
  let at: string | null = null;
  for (const m of marks) {
    peak = Math.max(peak, m.equity);
    const dd = peak - m.equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = (dd / peak) * 100;
      at = m.t;
    }
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    startingBalance: start,
    endingBalance: final.balance,
    endingEquity: final.equity,
    netChange: r2(final.equity - start),
    returnPct: r2(((final.equity - start) / start) * 100),
    maxDrawdown: r2(maxDd),
    maxDrawdownPct: r2(maxDdPct),
    maxDrawdownAt: at,
  };
}

/** At most EQUITY_POINTS points: each keeps its interval's last mark and lowest equity. */
function downsample(
  marks: readonly { t: string; balance: number; equity: number }[],
): EquityPoint[] {
  if (marks.length === 0) return [];
  const size = Math.ceil(marks.length / EQUITY_POINTS);
  const points: EquityPoint[] = [];
  for (let i = 0; i < marks.length; i += size) {
    const chunk = marks.slice(i, i + size);
    const lastMark = chunk.at(-1)!;
    points.push({
      t: lastMark.t,
      balance: lastMark.balance,
      equity: lastMark.equity,
      low: Math.min(...chunk.map((m) => m.equity)),
    });
  }
  return points;
}
