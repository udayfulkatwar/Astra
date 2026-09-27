/**
 * Position monitor (spec §8, Phase 8): the live view of every open position and of the account's
 * distance to its hard limits, and the alert conditions derived from it. Pure and deterministic;
 * it observes and warns — it never changes an order or closes a position.
 *
 * - Prices: a position is marked at the price it would exit at (LONG → bid, SHORT → ask) from a
 *   FRESH quote only. Without one the mark is null and the position is flagged NO_PRICE — the
 *   broker's own P&L is shown alongside, never substituted silently.
 * - Trailing intraday drawdown path risk: with a TRAILING_INTRADAY_EQUITY rule the threshold
 *   rises with open profit. The worst path is not "everything hits its stop now" but "everything
 *   runs almost to its target — lifting the threshold — and then reverses to its stop". The
 *   monitor computes that path's remaining buffer. A position without a target makes the run-up
 *   unbounded; then only the lock level (if the rule has one) bounds the threshold, otherwise the
 *   path risk is UNKNOWN.
 */
import {
  ZERO,
  dec,
  decMax,
  directionSign,
  toNum,
  type AccountSnapshot,
  type Dec,
  type InstrumentSpec,
  type Observed,
  type OpenPosition,
  type Quote,
} from '@astra/core';
import {
  positionRiskToStop,
  trailingExposure,
  type AccountState,
  type InstrumentLookup,
  type MaxDrawdownRule,
} from '@astra/prop-firm';
import { z } from 'zod';

export const MonitorPolicySchema = z
  .object({
    /** STOP_NEAR when at most this % of the initial stop distance is left. */
    stopProximityPct: z.number().min(1).max(99).default(25),
    /** TARGET_NEAR when at least this % of the way to the target is covered. */
    targetProximityPct: z.number().min(1).max(99).default(80),
    /** Account buffer WARN when the worst case uses at least this % of a hard limit… */
    bufferWarnPct: z.number().min(1).max(99).default(70),
    /** …and CRITICAL from this %. */
    bufferCriticalPct: z.number().min(1).max(100).default(90),
    /** A raised alert clears only once the value is this many points back on the safe side. */
    hysteresisPct: z.number().min(0).max(50).default(5),
  })
  .strict()
  .refine((p) => p.bufferWarnPct < p.bufferCriticalPct, {
    message: 'bufferWarnPct must be below bufferCriticalPct',
    path: ['bufferWarnPct'],
  });
export type MonitorPolicy = z.infer<typeof MonitorPolicySchema>;
export const DEFAULT_MONITOR_POLICY: MonitorPolicy = MonitorPolicySchema.parse({});

export type PositionFlag = 'UNPROTECTED' | 'NO_PRICE' | 'NO_SPEC' | 'NEAR_STOP' | 'NEAR_TARGET';

export interface PositionView {
  readonly positionId: string;
  readonly symbol: string;
  readonly direction: OpenPosition['direction'];
  readonly quantity: number;
  readonly entryPrice: number;
  readonly stopPrice: number | null;
  readonly targetPrice: number | null;
  readonly openedAt: string;
  readonly strategyId: string | null;
  /** Exit-side price from a fresh quote; null when there is none. */
  readonly mark: number | null;
  readonly markReason: string | null;
  /** P&L at the mark (quote-based); the broker's own figure is `brokerUnrealizedPnl`. */
  readonly unrealizedPnl: number | null;
  readonly brokerUnrealizedPnl: number;
  /** Planned loss entry → stop (before costs); null without a stop. */
  readonly initialRisk: number | null;
  /** P&L in multiples of the initial risk. */
  readonly rMultiple: number | null;
  /** Share of the initial stop distance still between mark and stop (100 at entry, 0 at the stop). */
  readonly stopRemainingPct: number | null;
  readonly stopDistanceTicks: number | null;
  /** Progress from entry to target (0 at entry, 100 at the target; negative when losing). */
  readonly targetProgressPct: number | null;
  readonly targetDistanceTicks: number | null;
  /** Loss if the stop is hit from the mark, incl. slippage and commission allowances. */
  readonly riskToStop: number | null;
  readonly flags: PositionFlag[];
}

export interface LimitBuffer {
  readonly limit: number;
  readonly remaining: number;
  readonly usedPct: number;
  readonly worstCaseRemaining: number | null;
  readonly worstCaseUsedPct: number | null;
}

export interface TrailingPathRisk {
  readonly locked: boolean;
  readonly threshold: number;
  /** Level at which the threshold stops rising (null: it never stops). */
  readonly lockLevel: number | null;
  /** Favourable room to the targets, in money; null = unbounded (a position has no target). */
  readonly runUp: number | null;
  /** Threshold after the run-up; null = unbounded. */
  readonly pathThreshold: number | null;
  /** Buffer left if every position runs to its target and then reverses to its stop. */
  readonly pathRemaining: number | null;
  readonly pathUsedPct: number | null;
  readonly note: string;
}

export interface AccountMonitorView {
  readonly accountId: string;
  readonly asOf: string;
  /** UNKNOWN when the account snapshot or state is not available. */
  readonly status: 'OK' | 'UNKNOWN';
  readonly reason: string | null;
  readonly currency: string | null;
  readonly equity: number | null;
  readonly positions: PositionView[];
  readonly dailyLoss: LimitBuffer | null;
  readonly drawdown: LimitBuffer | null;
  /** Only for TRAILING_INTRADAY_EQUITY rules with open positions. */
  readonly trailing: TrailingPathRisk | null;
  /** Highest worst-case usage of any hard limit, incl. the trailing path; null = unknown. */
  readonly bufferUsedPct: number | null;
}

export interface MonitorInput {
  readonly accountId: string;
  readonly now: Date;
  readonly snapshot: Observed<AccountSnapshot>;
  readonly state: AccountState | null;
  readonly drawdownRule: MaxDrawdownRule;
  readonly instruments: InstrumentLookup;
  /** Quote with freshness already applied. */
  readonly quote: (symbol: string) => Observed<Quote>;
  readonly policy: MonitorPolicy;
}

const pct = (part: Dec, whole: Dec): number => toNum(part.div(whole).mul(100), 2);

function viewPosition(
  p: OpenPosition,
  spec: InstrumentSpec | undefined,
  quote: Observed<Quote>,
  policy: MonitorPolicy,
): PositionView {
  const sign = directionSign(p.direction);
  const flags: PositionFlag[] = [];
  let mark: number | null = null;
  let markReason: string | null = null;
  if (quote.status === 'OK') mark = p.direction === 'LONG' ? quote.value.bid : quote.value.ask;
  else markReason = `quote ${quote.status}: ${quote.reason}`;
  if (mark === null) flags.push('NO_PRICE');
  if (p.stopPrice === null) flags.push('UNPROTECTED');
  if (!spec) flags.push('NO_SPEC');

  const entry = dec(p.entryPrice);
  const moneyPerPoint = spec ? dec(spec.tickValue).div(spec.tickSize).mul(p.quantity) : null;
  const ticks = (d: Dec) => (spec ? toNum(d.div(spec.tickSize), 2) : null);

  const initialRisk =
    p.stopPrice !== null && moneyPerPoint
      ? entry.minus(p.stopPrice).mul(sign).mul(moneyPerPoint)
      : null;
  const unrealized =
    mark !== null && moneyPerPoint ? dec(mark).minus(entry).mul(sign).mul(moneyPerPoint) : null;

  let stopRemainingPct: number | null = null;
  let stopDistanceTicks: number | null = null;
  if (mark !== null && p.stopPrice !== null) {
    const toStop = dec(mark).minus(p.stopPrice).mul(sign);
    const planned = entry.minus(p.stopPrice).mul(sign);
    stopDistanceTicks = ticks(toStop);
    if (planned.gt(0)) {
      stopRemainingPct = pct(toStop, planned);
      if (stopRemainingPct <= policy.stopProximityPct) flags.push('NEAR_STOP');
    }
  }
  let targetProgressPct: number | null = null;
  let targetDistanceTicks: number | null = null;
  if (mark !== null && p.targetPrice !== null) {
    const planned = dec(p.targetPrice).minus(entry).mul(sign);
    targetDistanceTicks = ticks(dec(p.targetPrice).minus(mark).mul(sign));
    if (planned.gt(0)) {
      targetProgressPct = pct(dec(mark).minus(entry).mul(sign), planned);
      if (targetProgressPct >= policy.targetProximityPct) flags.push('NEAR_TARGET');
    }
  }

  const risk = mark !== null ? positionRiskToStop({ ...p, currentPrice: mark }, spec) : null;
  return {
    positionId: p.positionId,
    symbol: p.symbol,
    direction: p.direction,
    quantity: p.quantity,
    entryPrice: p.entryPrice,
    stopPrice: p.stopPrice,
    targetPrice: p.targetPrice,
    openedAt: p.openedAt,
    strategyId: p.strategyId ?? null,
    mark,
    markReason,
    unrealizedPnl: unrealized ? toNum(unrealized, 2) : null,
    brokerUnrealizedPnl: p.unrealizedPnl,
    initialRisk: initialRisk ? toNum(initialRisk, 2) : null,
    rMultiple:
      unrealized && initialRisk && initialRisk.gt(0) ? toNum(unrealized.div(initialRisk), 2) : null,
    stopRemainingPct,
    stopDistanceTicks,
    targetProgressPct,
    targetDistanceTicks,
    riskToStop: risk?.riskToStop ?? null,
    flags,
  };
}

function buffer(s: {
  limit: number;
  remaining: number;
  usedPct: number;
  worstCaseRemaining: number | null;
  worstCaseUsedPct: number | null;
}): LimitBuffer {
  return {
    limit: s.limit,
    remaining: s.remaining,
    usedPct: s.usedPct,
    worstCaseRemaining: s.worstCaseRemaining,
    worstCaseUsedPct: s.worstCaseUsedPct,
  };
}

/** Worst path for a TRAILING_INTRADAY_EQUITY threshold (shared with the gate: prop-firm
 *  `trailingExposure`), shown while positions are open. */
export function trailingPathRisk(
  rule: MaxDrawdownRule,
  state: AccountState,
  positions: readonly OpenPosition[],
  instruments: InstrumentLookup,
): TrailingPathRisk | null {
  if (positions.length === 0) return null;
  const ex = trailingExposure(rule, state, positions, instruments);
  if (!ex) return null;
  const limit = dec(state.drawdown.limit);
  return {
    locked: ex.locked,
    threshold: ex.threshold,
    lockLevel: ex.lockLevel,
    runUp: ex.runUp,
    pathThreshold: ex.pathThreshold,
    pathRemaining: ex.pathRemaining,
    pathUsedPct:
      ex.pathRemaining === null ? null : pct(decMax(ZERO, limit.minus(ex.pathRemaining)), limit),
    note: ex.note,
  };
}

export function monitorAccount(input: MonitorInput): AccountMonitorView {
  const base = { accountId: input.accountId, asOf: input.now.toISOString() };
  const snap = input.snapshot;
  if (snap.status !== 'OK' || input.state === null) {
    return {
      ...base,
      status: 'UNKNOWN',
      reason:
        snap.status !== 'OK'
          ? `account snapshot ${snap.status}: ${snap.reason}`
          : 'account state not computed',
      currency: null,
      equity: null,
      positions: [],
      dailyLoss: null,
      drawdown: null,
      trailing: null,
      bufferUsedPct: null,
    };
  }
  const state = input.state;
  const positions = snap.value.openPositions.map((p) =>
    viewPosition(p, input.instruments(p.symbol), input.quote(p.symbol), input.policy),
  );
  const trailing = trailingPathRisk(
    input.drawdownRule,
    state,
    snap.value.openPositions,
    input.instruments,
  );
  const parts = [
    state.drawdown.worstCaseUsedPct,
    state.dailyLoss ? state.dailyLoss.worstCaseUsedPct : 0,
    trailing ? trailing.pathUsedPct : 0,
  ];
  return {
    ...base,
    status: 'OK',
    reason: null,
    currency: state.currency,
    equity: state.equity,
    positions,
    dailyLoss: state.dailyLoss ? buffer(state.dailyLoss) : null,
    drawdown: buffer(state.drawdown),
    trailing,
    bufferUsedPct: parts.some((p) => p === null) ? null : Math.max(...(parts as number[])),
  };
}
