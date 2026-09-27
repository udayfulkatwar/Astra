/**
 * Trailing intraday-equity drawdown: the path-dependent worst case (ADR-0012, ADR-0013).
 *
 * With a TRAILING_INTRADAY_EQUITY rule open profit raises the threshold. The worst path for an
 * open position is therefore not "stopped out now" but "runs (almost) to its target — lifting the
 * peak and the threshold — then reverses to its stop". The threshold rise is bounded by the
 * rule's lock level, if it has one. The gate, position sizing, the survival check and the
 * position monitor all use these functions, so they cannot disagree.
 */
import {
  ZERO,
  dec,
  decMax,
  decMin,
  directionSign,
  toNum,
  type Dec,
  type OpenPosition,
} from '@astra/core';
import {
  resolveInitialBasedLimit,
  type AccountState,
  type InstrumentLookup,
} from './account-state';
import type { MaxDrawdownRule } from './profile';

export interface TrailingExposure {
  /** Unlocked TRAILING_INTRADAY_EQUITY: the path applies. Locked → plain worst case. */
  readonly applies: boolean;
  readonly locked: boolean;
  readonly threshold: number;
  /** Level at which the threshold stops rising; null = never. */
  readonly lockLevel: number | null;
  /** Open positions' favourable room to their targets, in money; null = unbounded. */
  readonly runUp: number | null;
  /** Threshold after that run-up; null = unbounded. */
  readonly pathThreshold: number | null;
  /** Worst-case equity minus the path threshold; null = unknown / unbounded. */
  readonly pathRemaining: number | null;
  /** Further threshold rise still possible beyond the open positions' run-up; null = no limit. */
  readonly riseCapRemaining: number | null;
  readonly note: string;
}

/**
 * The trailing exposure of an account (null unless the rule is TRAILING_INTRADAY_EQUITY). Run-up
 * is measured from the prices the snapshot's equity is based on (`currentPrice`).
 */
export function trailingExposure(
  rule: MaxDrawdownRule,
  state: AccountState,
  positions: readonly OpenPosition[],
  instruments: InstrumentLookup,
): TrailingExposure | null {
  if (rule.type !== 'TRAILING_INTRADAY_EQUITY') return null;
  const initial = dec(state.initialBalance);
  const limit = resolveInitialBasedLimit(rule.limit, initial);
  const stop = rule.trailingStopsAt;
  const lock =
    stop.kind === 'NEVER'
      ? null
      : stop.kind === 'INITIAL_BALANCE'
        ? initial
        : initial.plus(stop.amount);
  const current = dec(state.drawdown.threshold);
  const worstCaseEquity = state.worstCaseEquity === null ? null : dec(state.worstCaseEquity);
  const base = {
    locked: state.drawdown.thresholdLocked,
    threshold: state.drawdown.threshold,
    lockLevel: lock ? toNum(lock) : null,
  };

  if (state.drawdown.thresholdLocked) {
    return {
      ...base,
      applies: false,
      runUp: 0,
      pathThreshold: state.drawdown.threshold,
      pathRemaining: state.drawdown.worstCaseRemaining,
      riseCapRemaining: 0,
      note: 'threshold locked: open profit can no longer raise it',
    };
  }

  let runUp: Dec | null = ZERO;
  for (const p of positions) {
    const spec = instruments(p.symbol);
    if (p.targetPrice === null || !spec) {
      runUp = null;
      break;
    }
    const room = decMax(
      ZERO,
      dec(p.targetPrice).minus(p.currentPrice).mul(directionSign(p.direction)),
    );
    runUp = runUp.plus(room.mul(spec.tickValue).div(spec.tickSize).mul(p.quantity));
  }

  let pathThreshold: Dec | null;
  let note: string;
  if (runUp === null) {
    pathThreshold = lock;
    note = lock
      ? 'a position has no target: its run-up is unbounded, so the threshold can rise to its lock level'
      : 'a position has no target and the threshold never locks: the trailing path risk is unbounded';
  } else {
    const peak = decMax(dec(state.drawdown.peak), dec(state.equity).plus(runUp));
    let raised = peak.minus(limit);
    if (lock && raised.gte(lock)) raised = lock;
    pathThreshold = raised;
    note =
      'open positions run to their targets, lifting the threshold, then reverse to their stops';
  }
  if (pathThreshold && pathThreshold.lt(current)) pathThreshold = current;
  const pathRemaining =
    pathThreshold && worstCaseEquity ? worstCaseEquity.minus(pathThreshold) : null;
  return {
    ...base,
    applies: true,
    runUp: runUp ? toNum(runUp, 2) : null,
    pathThreshold: pathThreshold ? toNum(pathThreshold, 2) : null,
    pathRemaining: pathRemaining ? toNum(pathRemaining, 2) : null,
    riseCapRemaining:
      lock && pathThreshold ? toNum(decMax(ZERO, lock.minus(pathThreshold)), 2) : null,
    note,
  };
}

/** Money a new trade consumes from the trailing path: its stop loss plus the threshold rise
 *  its run-up to target can cause (bounded by what is left to the lock level). */
export function trailingConsumption(
  exposure: TrailingExposure,
  tradeLoss: Dec,
  tradeRunUp: Dec,
): Dec {
  const rise =
    exposure.riseCapRemaining === null
      ? tradeRunUp
      : decMin(tradeRunUp, dec(exposure.riseCapRemaining));
  return tradeLoss.plus(rise);
}

/**
 * Largest quantity q with q·risk + min(q·runUp, cap) ≤ budget (cap null = no limit). Not rounded
 * to the quantity step (the caller floors it).
 */
export function maxQuantityWithinTrailingPath(
  budget: Dec,
  riskPerUnit: Dec,
  runUpPerUnit: Dec,
  cap: Dec | null,
): Dec {
  if (budget.lte(0) || riskPerUnit.lte(0)) return ZERO;
  const combined = budget.div(riskPerUnit.plus(runUpPerUnit));
  if (cap === null || runUpPerUnit.lte(0)) return combined;
  // Below q = cap / runUp the run-up is not yet capped.
  const knee = cap.div(runUpPerUnit);
  if (combined.lte(knee)) return combined;
  return decMax(knee, budget.minus(cap).div(riskPerUnit));
}
