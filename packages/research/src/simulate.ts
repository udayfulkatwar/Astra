/**
 * The research replay (SPEC §20–§22): every pair's M5 candles merged in time order, the owner's
 * LSFVG engine on each, every complete setup through ASTRA's real decision gate (sizing, owner
 * limits, prop-firm rules, calendar), resting LIMIT orders in the pessimistic research broker,
 * prop-firm tracking and automatic protection — the same code paper trading runs.
 *
 * No lookahead: at each candle close the engines, the gate and protection see only candles that
 * have closed; an order decided at a close can fill from the next candle on. Candles before
 * `from` only warm the engines up (nothing is traded on them).
 */
import {
  ManualClock,
  eventAffectsInstrument,
  notObserved,
  observed,
  tradingDayWindow,
  type AccountActivity,
  type ComponentHealth,
  type EconomicEvent,
  type InstrumentSpec,
  type Observed,
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
  computeAccountState,
  initAccountTracking,
  updateAccountTracking,
  type AccountTracking,
  type PropFirmRuleProfile,
} from '@astra/prop-firm';
import {
  ProtectionEvaluator,
  monitorAccount,
  type MonitorPolicy,
  type ProtectionPolicy,
} from '@astra/risk';
import { KillSwitchRegistry } from '@astra/safety';
import {
  LsfvgEngine,
  LsfvgParamsSchema,
  decisionRecord,
  gateOutcome,
  toSignal,
  type Candle,
  type DecisionRecord,
  type LsfvgCounters,
  type LsfvgEvent,
  type LsfvgParams,
  type LsfvgParamsInput,
  type LsfvgSetup,
} from '@astra/strategy-lsfvg';
import { ResearchBroker, type CostModel, type ExitReason, type ResearchClose } from './broker';
import { coverage, mid, type Coverage, type ResearchBar } from './data';

const M5 = 300_000;
const SYSTEM = { type: 'SYSTEM' as const, id: 'research' };
const MAX_RECORDS = 2_000;

export interface ResearchEnvironment {
  readonly config: DecisionConfigView;
  readonly instruments: ReadonlyMap<string, InstrumentSpec>;
  readonly monitorPolicy: MonitorPolicy;
  readonly protectionPolicy: ProtectionPolicy;
  readonly lateObservationThresholdMs: number;
}

export type CalendarSource =
  | { readonly kind: 'NOT_MODELLED' }
  | {
      readonly kind: 'HISTORICAL';
      readonly source: string;
      /** The file asserts completeness of HIGH/MEDIUM events in [from, to]. */
      readonly from: string;
      readonly to: string;
      readonly events: readonly EconomicEvent[];
    };

/**
 * STRATEGY: the strategy study (SPEC §23) — the account's prop-firm profile is replaced by
 * `strategyStudyProfile`, so the whole history is traded. ACCOUNT: the account's own profile, as
 * paper trading applies it — one evaluation attempt, which ends at a breach or stops at the
 * profit target.
 */
export type PropFirmMode = 'STRATEGY' | 'ACCOUNT';

/**
 * The account's profile without the firm's limits: no daily loss limit, a 100 % static drawdown
 * (only a lost account stops it), no position caps, no firm news rule, no per-trade cap, no profit
 * target. The trading day and the holding rules (flat before a prohibited weekend) are kept. Not
 * a firm's rules — a research assumption, stated in every report.
 */
export function strategyStudyProfile(profile: PropFirmRuleProfile): PropFirmRuleProfile {
  return {
    ...profile,
    id: `${profile.id}-study`,
    name: `Strategy study (no prop-firm limits) — based on ${profile.name}`,
    firm: 'NONE — strategy study',
    dailyLoss: null,
    maxDrawdown: {
      type: 'STATIC',
      limit: { kind: 'PERCENT_OF_INITIAL', value: 100 },
      measure: 'EQUITY',
      trailingStopsAt: { kind: 'NEVER' },
    },
    positionLimits: {
      maxContracts: null,
      maxLots: null,
      quantityWeights: {},
      maxOpenPositions: null,
      perInstrumentMaxQuantity: {},
      maxLeverage: null,
    },
    scaling: null,
    consistency: null,
    news: null,
    trading: { ...profile.trading, maxRiskPerTrade: null },
    objectives: { profitTarget: null, minTradingDays: null },
    payout: null,
  };
}

/** What the replay needs of an engine: closed M5 candles in, events out, and its funnel. */
export interface ResearchEngine {
  onM5(candle: Candle): LsfvgEvent[];
  readonly counters: LsfvgCounters;
}

export interface ResearchParams {
  readonly env: ResearchEnvironment;
  readonly accountId: string;
  readonly strategyId: string;
  readonly data: ReadonlyMap<string, readonly ResearchBar[]>;
  readonly costs: CostModel;
  readonly calendar: CalendarSource;
  /** Trading window; earlier candles only warm the engines up. */
  readonly from: string;
  readonly to: string;
  /** Engine parameter overrides — sensitivity analysis only (the frozen rules are the config's). */
  readonly paramOverrides?: Partial<LsfvgParamsInput>;
  /** Default STRATEGY (the whole history); ACCOUNT runs one evaluation attempt of the profile. */
  readonly propFirm?: PropFirmMode;
  /** Another engine with the same contract (tests replay scripted setups through the gate). */
  readonly engineFactory?: (
    symbol: string,
    tickSize: number,
    params: LsfvgParams,
  ) => ResearchEngine;
  readonly label?: string;
  readonly yieldControl?: () => Promise<void>;
}

export interface ResearchTrade {
  readonly id: string;
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly setupId: string;
  readonly decidedAt: string;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly durationMinutes: number;
  readonly entry: number;
  readonly exit: number;
  readonly stop: number;
  readonly target: number;
  readonly quantity: number;
  readonly exitReason: ExitReason;
  /** Account currency. */
  readonly riskMoney: number;
  readonly grossPnl: number;
  readonly commission: number;
  readonly netPnl: number;
  /** Net P&L in R (null when the risk was zero). */
  readonly r: number | null;
  readonly liquidity: string;
  readonly strongLiquidity: boolean;
  readonly structure: 'CHOCH' | 'BOS';
  readonly score: number;
  /** UTC hour of the entry (session analysis). */
  readonly entryHourUtc: number;
}

export interface ResearchRun {
  readonly label: string;
  readonly strategyId: string;
  readonly accountId: string;
  readonly model: 'A' | 'B';
  readonly params: LsfvgParams;
  readonly costs: CostModel;
  readonly propFirm: {
    readonly mode: PropFirmMode;
    readonly profileId: string;
    readonly name: string;
  };
  readonly calendar: { readonly kind: CalendarSource['kind']; readonly source: string | null };
  readonly window: { readonly from: string; readonly to: string };
  readonly coverage: readonly Coverage[];
  readonly startingBalance: number;
  readonly endingBalance: number;
  readonly trades: readonly ResearchTrade[];
  readonly funnel: Readonly<Record<string, LsfvgCounters>>;
  readonly gate: {
    readonly setups: number;
    readonly approved: number;
    readonly rejected: number;
    readonly filled: number;
    readonly missed: number;
    readonly invalidated: number;
    readonly blockedBy: readonly { checkId: string; count: number; example: string }[];
  };
  /** One point per trading day (end-of-day marks). */
  readonly equity: readonly { day: string; balance: number; equity: number; low: number }[];
  readonly breach: { readonly at: string; readonly detail: string } | null;
  readonly protectiveCloses: number;
  /** §26 records of complete sequences (at most 2,000, oldest first). */
  readonly records: readonly DecisionRecord[];
}

interface Entry {
  readonly symbol: string;
  readonly placedAt: number;
  status: 'WORKING' | 'FILLED' | 'MISSED' | 'CANCELLED';
}

export async function runResearch(p: ResearchParams): Promise<ResearchRun> {
  const { env, costs } = p;
  const base = env.config;
  const account = base.account(p.accountId);
  if (!account) throw new Error(`account ${p.accountId} not found`);
  const configured = base.strategy(p.strategyId);
  if (!configured) throw new Error(`strategy ${p.strategyId} not found`);
  if (configured.rules.engine !== 'lsfvg-v1')
    throw new Error(`strategy ${p.strategyId} is not an lsfvg-v1 strategy`);
  if (!account.strategies.includes(configured.id))
    throw new Error(`strategy ${p.strategyId} is not enabled for account ${p.accountId}`);
  const accountProfile = base.profile(account.propFirmProfileId);
  if (!accountProfile) throw new Error(`prop-firm profile ${account.propFirmProfileId} not found`);
  const propFirmMode = p.propFirm ?? 'STRATEGY';
  const profile =
    propFirmMode === 'STRATEGY' ? strategyStudyProfile(accountProfile) : accountProfile;
  const fromMs = Date.parse(p.from);
  const toMs = Date.parse(p.to);
  if (!(toMs > fromMs)) throw new Error('the research window is empty');

  const params = LsfvgParamsSchema.parse({
    ...(configured.rules.params as LsfvgParamsInput),
    ...p.paramOverrides,
  });
  const strategy: StrategyDefinition = {
    ...configured,
    rules: { ...configured.rules, params },
  };
  const view: DecisionConfigView = {
    ...base,
    strategy: (id) => (id === strategy.id ? strategy : base.strategy(id)),
    profile: (id) => (id === account.propFirmProfileId ? profile : base.profile(id)),
  };
  const symbols = strategy.instruments.filter((s) => p.data.has(s));
  if (symbols.length === 0) throw new Error('no data for any of the strategy’s instruments');
  const specs = new Map<string, InstrumentSpec>();
  for (const s of new Set([...symbols, ...(view.instrumentSymbols?.() ?? [])])) {
    const spec = env.instruments.get(s);
    if (spec) specs.set(s, spec);
  }

  const makeEngine =
    p.engineFactory ?? ((s: string, tick: number, x: LsfvgParams) => new LsfvgEngine(s, tick, x));
  const engines = new Map(
    symbols.map((s) => [s, makeEngine(s, specs.get(s)!.tickSize, params)] as const),
  );
  const broker = new ResearchBroker({
    accountId: account.id,
    currency: account.currency,
    startingBalance: profile.accountSize,
    specs,
    costs,
  });
  const clock = new ManualClock(new Date(fromMs).toISOString());
  const killSwitches = new KillSwitchRegistry(clock);
  killSwitches.load([]);
  const evaluator = new ProtectionEvaluator(env.protectionPolicy);
  const gate = new DecisionEngine({ newApprovalId: () => `rs-apr-${seq}` });

  let seq = 0;
  let tracking: AccountTracking | null = null;
  const entries = new Map<string, Entry>();
  const setups = new Map<string, { setup: LsfvgSetup; decidedAt: string }>();
  const trades: ResearchTrade[] = [];
  const records: DecisionRecord[] = [];
  const blocked = new Map<string, { count: number; example: string }>();
  const counts = { setups: 0, approved: 0, rejected: 0, filled: 0, missed: 0, invalidated: 0 };
  const equity: { day: string; balance: number; equity: number; low: number }[] = [];
  let breach: ResearchRun['breach'] = null;
  let protectiveCloses = 0;
  const closing = new Set<string>();

  const dayOf = (ms: number) => tradingDayWindow(new Date(ms), profile.tradingDayReset);
  const record = (r: DecisionRecord) => {
    if (records.length < MAX_RECORDS) records.push(r);
  };

  // Merge the pairs' candles into time slices.
  const series = symbols.map((s) => ({ symbol: s, bars: p.data.get(s)!, i: 0 }));
  let slices = 0;
  for (;;) {
    let t = Infinity;
    for (const s of series) if (s.i < s.bars.length) t = Math.min(t, s.bars[s.i]!.t);
    if (t === Infinity || t >= toMs) break;
    const slice: { symbol: string; bar: ResearchBar }[] = [];
    for (const s of series) {
      if (s.i < s.bars.length && s.bars[s.i]!.t === t)
        slice.push({ symbol: s.symbol, bar: s.bars[s.i++]! });
    }
    if (p.yieldControl && ++slices % 5_000 === 0) await p.yieldControl();
    const live = t >= fromMs;
    const now = t + M5;

    // 1. The candle executes what was decided before it opened.
    clock.set(new Date(t).toISOString());
    for (const { symbol, bar } of slice) {
      const out = broker.onBar(symbol, bar);
      for (const m of out.missed) {
        const e = entries.get(m.id);
        if (e) e.status = 'MISSED';
        counts.missed++;
      }
      for (const f of out.filled) {
        const e = entries.get(f.position.order.id);
        if (e) e.status = 'FILLED';
        counts.filled++;
      }
      for (const c of out.closed) close(c);
    }
    clock.set(new Date(now).toISOString());

    // 2. Account, prop-firm state and protection at the close (trading window only).
    if (live) {
      for (const s of killSwitches.dueForAutoClear())
        killSwitches.apply(
          killSwitches.planDeactivation({
            scope: s.scope,
            target: s.target,
            reason: 'next trading day',
            actor: SYSTEM,
          }),
        );
      const snapshot = broker.snapshot(now);
      const today = dayOf(now).key;
      tracking = tracking
        ? updateAccountTracking(tracking, snapshot, {
            reset: profile.tradingDayReset,
            tradedToday: activity(now).tradesToday > 0,
            lateObservationThresholdMs: env.lateObservationThresholdMs,
          })
        : initAccountTracking({
            accountId: account.id,
            initialBalance: profile.accountSize,
            snapshot,
            reset: profile.tradingDayReset,
          });
      const lastPoint = equity.at(-1);
      if (lastPoint?.day === today) {
        equity[equity.length - 1] = {
          day: today,
          balance: snapshot.balance,
          equity: snapshot.equity,
          low: Math.min(lastPoint.low, snapshot.equity),
        };
      } else {
        equity.push({
          day: today,
          balance: snapshot.balance,
          equity: snapshot.equity,
          low: snapshot.equity,
        });
      }
      if (snapshot.openPositions.length > 0 || snapshot.pendingOrders > 0) {
        const lookup = (s: string) => {
          try {
            return broker.valued(s);
          } catch {
            return undefined;
          }
        };
        const state = computeAccountState({ profile, tracking, snapshot, instruments: lookup });
        if (state.breached && !breach) {
          breach = {
            at: new Date(now).toISOString(),
            detail: `hard limit crossed (equity ${state.equity}, distance to breach ${state.distanceToBreach})`,
          };
          killSwitches.activate({
            scope: 'ACCOUNT',
            target: account.id,
            reason: 'prop-firm hard limit breached in research (account failed)',
            actor: SYSTEM,
          });
        }
        if (snapshot.openPositions.length > 0) {
          const snapObs = observed(snapshot, {
            source: 'research-broker',
            sourceKind: 'SIMULATED',
            asOf: snapshot.asOf,
          });
          const mon = monitorAccount({
            accountId: account.id,
            now: new Date(now),
            snapshot: snapObs,
            state,
            drawdownRule: profile.maxDrawdown,
            instruments: lookup,
            quote: (s) => quoteObs(s, now),
            policy: env.monitorPolicy,
          });
          for (const a of evaluator.evaluate([mon], {
            now: new Date(now),
            holding: () => profile.holding,
          })) {
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
                      autoClearAt: dayOf(now).end.toISOString(),
                    }
                  : { clearPolicy: 'MANUAL' as const }),
              });
            }
            closing.add(a.positionId);
            broker.queueClose(a.positionId);
            protectiveCloses++;
          }
        }
      }
    }

    // 3. The engines see the closed candles; setups go through the gate.
    for (const { symbol, bar } of slice) {
      const events = engines.get(symbol)!.onM5({
        openTime: new Date(t).toISOString(),
        closeTime: new Date(now).toISOString(),
        open: mid(bar).o,
        high: mid(bar).h,
        low: mid(bar).l,
        close: mid(bar).c,
      });
      if (!live) continue;
      for (const e of events) {
        if (e.kind === 'REJECTED') {
          record(decisionRecord({ rejection: e.rejection }));
          continue;
        }
        if (e.kind === 'INVALIDATED') {
          for (const o of broker.cancel(`${strategy.id}:${e.setupId}`)) {
            const en = entries.get(o.id);
            if (en) en.status = 'CANCELLED';
            counts.invalidated++;
          }
          continue;
        }
        counts.setups++;
        const d = await decide(e.setup, now);
        record(decisionRecord({ setup: e.setup }, gateOutcome(d)));
        if (d.status === 'APPROVED' && d.orderPlan) {
          counts.approved++;
          const id = `rs-ord-${seq}`;
          broker.place({
            id,
            symbol,
            direction: d.orderPlan.direction,
            quantity: d.orderPlan.quantity,
            limit: d.orderPlan.entry,
            stop: d.orderPlan.stop,
            target: d.orderPlan.target,
            activeFrom: now,
            expiresAt: Date.parse(e.setup.expiresAt),
            signalId: `${strategy.id}:${e.setup.id}`,
            placedAt: new Date(now).toISOString(),
          });
          entries.set(id, { symbol, placedAt: now, status: 'WORKING' });
          setups.set(id, { setup: e.setup, decidedAt: d.decidedAt });
        } else {
          counts.rejected++;
          for (const c of d.checks)
            if (c.mandatory && c.verdict !== 'PASS') {
              const b = blocked.get(c.checkId) ?? { count: 0, example: c.reasons[0] ?? c.verdict };
              b.count++;
              blocked.set(c.checkId, b);
            }
        }
      }
    }
  }
  const endMs = Math.min(toMs, clock.now().getTime());
  for (const c of broker.closeAll(endMs)) close(c);

  function close(c: ResearchClose): void {
    const o = c.position.order;
    closing.delete(c.position.id);
    const info = setups.get(o.id);
    const s = info?.setup;
    trades.push({
      id: c.position.id,
      symbol: o.symbol,
      direction: o.direction,
      setupId: s?.id ?? '',
      decidedAt: info?.decidedAt ?? o.placedAt,
      openedAt: new Date(c.position.openedAt).toISOString(),
      closedAt: new Date(c.closedAt).toISOString(),
      durationMinutes: Math.round((c.closedAt - c.position.openedAt) / 60_000),
      entry: c.position.entry,
      exit: c.exit,
      stop: o.stop,
      target: o.target,
      quantity: o.quantity,
      exitReason: c.exitReason,
      riskMoney: c.position.riskMoney,
      grossPnl: c.grossPnl,
      commission: c.position.commission,
      netPnl: c.netPnl,
      r:
        c.position.riskMoney > 0 ? Math.round((c.netPnl / c.position.riskMoney) * 100) / 100 : null,
      liquidity: s?.liquidity.name ?? '',
      strongLiquidity: s?.liquidity.strong ?? false,
      structure: s?.structure.kind ?? 'BOS',
      score: s?.score.total ?? 0,
      entryHourUtc: new Date(c.position.openedAt).getUTCHours(),
    });
  }

  function activity(nowMs: number): AccountActivity {
    const w = dayOf(nowMs);
    const inDay = (ms: number) => ms >= w.start.getTime() && ms < w.end.getTime();
    const entriesBySymbol: Record<string, number> = {};
    let tradesToday = 0;
    for (const e of entries.values()) {
      if (!inDay(e.placedAt) || (e.status !== 'WORKING' && e.status !== 'FILLED')) continue;
      tradesToday++;
      entriesBySymbol[e.symbol] = (entriesBySymbol[e.symbol] ?? 0) + 1;
    }
    const closedToday = trades.filter((tr) => inDay(Date.parse(tr.closedAt))).reverse();
    let streak = 0;
    for (const tr of closedToday) {
      if (tr.netPnl < 0) streak++;
      else break;
    }
    return {
      tradingDayKey: w.key,
      tradesToday,
      consecutiveLosses: streak,
      entriesBySymbol,
      closedTodayR: closedToday.map((tr) => tr.r),
    };
  }

  function quoteObs(symbol: string, nowMs: number): Observed<Quote> {
    const q = broker.quote(symbol);
    const asOf = new Date(nowMs).toISOString();
    return q
      ? observed(
          { symbol, bid: q.bid, ask: q.ask, asOf },
          { source: 'history', sourceKind: 'HISTORICAL', asOf },
        )
      : notObserved('UNAVAILABLE', `no ${symbol} candle yet`, 'history');
  }

  function calendarFor(symbol: string, from: Date, to: Date, at: string) {
    const meta = { sourceKind: 'HISTORICAL' as const, asOf: at };
    if (p.calendar.kind === 'NOT_MODELLED') {
      // Stated in every result: the SPEC's news filter is NOT applied in this run.
      return observed(
        { from: from.toISOString(), to: to.toISOString(), events: [] },
        { source: 'calendar-not-modelled', ...meta },
      );
    }
    const cal = p.calendar;
    if (from.getTime() < Date.parse(cal.from) || to.getTime() > Date.parse(cal.to))
      return notObserved(
        'UNAVAILABLE',
        'historical calendar does not cover this window',
        cal.source,
      );
    const spec = specs.get(symbol);
    const events = cal.events.filter((e) => {
      const ms = Date.parse(e.scheduledAt);
      return (
        ms >= from.getTime() &&
        ms <= to.getTime() &&
        eventAffectsInstrument(e, symbol, spec?.eventCurrencies)
      );
    });
    return observed(
      { from: from.toISOString(), to: to.toISOString(), events: [...events] },
      { source: cal.source, ...meta },
    );
  }

  async function decide(setup: LsfvgSetup, nowMs: number): Promise<TradeDecision> {
    seq++;
    const at = new Date(nowMs).toISOString();
    const candidate: TradeCandidate = {
      accountId: account!.id,
      submittedAt: at,
      signal: toSignal(setup, strategy.id),
    };
    const meta = { source: 'research', sourceKind: 'SIMULATED' as const, asOf: at };
    const snap = broker.snapshot(nowMs);
    const data: DecisionDataPorts = {
      quote: (s) => Promise.resolve(quoteObs(s, nowMs)),
      accountSnapshot: () =>
        Promise.resolve(
          observed(snap, { source: 'research-broker', sourceKind: 'SIMULATED', asOf: at }),
        ),
      tracking: () =>
        Promise.resolve(
          tracking
            ? observed(tracking, meta)
            : notObserved('UNAVAILABLE', 'no tracking yet', 'research'),
        ),
      activity: () => Promise.resolve(observed(activity(nowMs), meta)),
      calendar: (from, to) => Promise.resolve(calendarFor(setup.symbol, from, to, at)),
      newsRisk: (s) =>
        Promise.resolve(
          observed(
            {
              symbol: s,
              level: 'NORMAL' as const,
              assessedAt: at,
              reasons: [
                'news headlines not modelled in research (the calendar filter is separate)',
              ],
            },
            { ...meta, source: 'news-not-modelled' },
          ),
        ),
      aiAnalysis: () =>
        Promise.resolve(notObserved('UNAVAILABLE', 'no AI analysis in research', 'ai')),
      duplicates: () =>
        Promise.resolve(
          observed(
            {
              priorApprovedDecisionId: null,
              workingOrderForSymbol: broker.hasWorking(setup.symbol),
            },
            meta,
          ),
        ),
    };
    const health: ComponentHealth[] = view.policy.requiredComponents.map((component) => ({
      component,
      status: 'ONLINE',
      detail: 'research simulator',
      checkedAt: at,
    }));
    const state: DecisionStatePorts = {
      mode: () => 'BACKTEST',
      killSwitches: (ctx) => killSwitches.evaluate(ctx),
      componentHealth: () => health,
      execution: () => ({
        adapterId: 'research-broker',
        adapterKind: null,
        health: 'ONLINE',
        reconciled: true,
        supportedEntryTypes: ['MARKET', 'LIMIT'],
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
      decisionId: `rs-dec-${seq}`,
      environment: 'BACKTEST_SIMULATOR',
    });
    return gate.evaluate(inputs);
  }

  const funnel: Record<string, LsfvgCounters> = {};
  for (const [s, e] of engines) funnel[s] = { ...e.counters };
  return {
    label: p.label ?? `${strategy.id} ${p.from.slice(0, 10)}–${p.to.slice(0, 10)}`,
    strategyId: strategy.id,
    accountId: account.id,
    model: params.model,
    params,
    costs,
    propFirm: { mode: propFirmMode, profileId: profile.id, name: profile.name },
    calendar: {
      kind: p.calendar.kind,
      source: p.calendar.kind === 'HISTORICAL' ? p.calendar.source : null,
    },
    window: { from: p.from, to: p.to },
    coverage: symbols.map((s) => coverage(s, p.data.get(s)!)),
    startingBalance: profile.accountSize,
    endingBalance: broker.snapshot(endMs).balance,
    trades,
    funnel,
    gate: {
      ...counts,
      blockedBy: [...blocked.entries()]
        .map(([checkId, b]) => ({ checkId, ...b }))
        .sort((a, b) => b.count - a.count),
    },
    equity,
    breach,
    protectiveCloses,
    records,
  };
}
