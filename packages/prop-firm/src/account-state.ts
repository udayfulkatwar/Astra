/**
 * Account State Engine (spec §9): derives every prop-firm-relevant number for ONE account from
 * its profile, tracking state and latest snapshot. Pure and deterministic; exact decimal math.
 *
 * Worst case = every open position stopped out (plus cost allowances). ASTRA reasons about the
 * worst case, not the current mark, when deciding whether new risk is affordable.
 */
import {
  AstraError,
  ZERO,
  dec,
  decMax,
  decMin,
  directionSign,
  toNum,
  type AccountSnapshot,
  type Dec,
  type InstrumentSpec,
  type OpenPosition,
  exposurePositions,
  undetailedPendingOrders,
} from '@astra/core';
import type {
  DailyLossRule,
  InitialBasedLimit,
  MaxDrawdownRule,
  PropFirmRuleProfile,
} from './profile';
import type { AccountTracking } from './tracking';

export type InstrumentLookup = (symbol: string) => InstrumentSpec | undefined;

export interface DailyLossState {
  readonly limit: number;
  readonly reference: number;
  readonly floor: number;
  readonly measureValue: number;
  /** Loss consumed so far (0 when in profit). */
  readonly used: number;
  readonly remaining: number;
  readonly usedPct: number;
  readonly worstCaseRemaining: number | null;
  readonly worstCaseUsedPct: number | null;
  readonly breached: boolean;
  readonly floorSource: 'COMPUTED' | 'REPORTED';
}

export interface DrawdownState {
  readonly type: MaxDrawdownRule['type'];
  readonly limit: number;
  readonly peak: number;
  readonly threshold: number;
  readonly thresholdLocked: boolean;
  readonly measureValue: number;
  readonly used: number;
  readonly remaining: number;
  readonly usedPct: number;
  readonly worstCaseRemaining: number | null;
  readonly worstCaseUsedPct: number | null;
  readonly breached: boolean;
  readonly thresholdSource: 'COMPUTED' | 'REPORTED';
}

export interface PositionRisk {
  readonly positionId: string;
  readonly symbol: string;
  /** Loss if the stop is hit from the current price, incl. cost allowances. null = unknown. */
  readonly riskToStop: number | null;
  readonly unknownReason?: string;
}

export interface OpenRiskState {
  readonly amount: number;
  /** false when any position has no stop or no instrument spec → open risk is UNKNOWN. */
  readonly complete: boolean;
  readonly positions: readonly PositionRisk[];
}

export interface ProfitTargetState {
  readonly target: number;
  readonly progress: number;
  readonly remaining: number;
  readonly progressPct: number;
  readonly reached: boolean;
}

export interface ConsistencyState {
  readonly maxDayProfitSharePct: number;
  readonly totalProfit: number;
  readonly todayRealizedPnl: number;
  readonly bestDayPnl: number;
  /** Today's share of total profit (null when total profit ≤ 0). */
  readonly todaySharePct: number | null;
  readonly bestDaySharePct: number | null;
  readonly todayAtOrAboveLimit: boolean;
}

export interface AccountState {
  readonly accountId: string;
  readonly asOf: string;
  readonly currency: string;
  readonly initialBalance: number;
  readonly balance: number;
  readonly equity: number;
  readonly floatingPnl: number;
  readonly realizedPnlToday: number;
  readonly totalPnl: number;
  readonly tradingDayKey: string;
  readonly dayStartSource: AccountTracking['dayStartSource'];
  readonly dailyLoss: DailyLossState | null;
  readonly drawdown: DrawdownState;
  readonly openRisk: OpenRiskState;
  readonly worstCaseEquity: number | null;
  /** min(remaining) across hard limits at the current mark. */
  readonly distanceToBreach: number;
  /** min(remaining) across hard limits if every open position is stopped out. */
  readonly worstCaseDistanceToBreach: number | null;
  readonly bindingLimit: 'DAILY_LOSS' | 'MAX_DRAWDOWN';
  readonly profitTarget: ProfitTargetState | null;
  readonly consistency: ConsistencyState | null;
  readonly tradingDays: {
    readonly count: number;
    readonly required: number | null;
    readonly met: boolean;
  };
  /** A hard limit was crossed (account failed). */
  readonly breached: boolean;
  /** The daily loss limit was reached; no trading until the next reset. */
  readonly dayLocked: boolean;
}

export function resolveInitialBasedLimit(limit: InitialBasedLimit, initial: Dec): Dec {
  return limit.kind === 'AMOUNT' ? dec(limit.value) : initial.mul(limit.value).div(100);
}

/** Loss if a position's stop is hit from its current price, plus slippage and commission allowances. */
export function positionRiskToStop(
  position: OpenPosition,
  spec: InstrumentSpec | undefined,
): PositionRisk {
  const base = { positionId: position.positionId, symbol: position.symbol };
  if (!spec)
    return {
      ...base,
      riskToStop: null,
      unknownReason: `no instrument spec for ${position.symbol}`,
    };
  if (position.stopPrice === null) {
    return {
      ...base,
      riskToStop: null,
      unknownReason: `position ${position.positionId} has no stop`,
    };
  }
  const sign = directionSign(position.direction);
  const qty = dec(position.quantity);
  const vpp = dec(spec.tickValue).div(spec.tickSize);
  // Adverse move from the current price to the stop (0 if the stop already locks in profit
  // relative to the current price — which cannot persist, but never counts as negative risk).
  const adverse = decMax(ZERO, dec(position.currentPrice).minus(position.stopPrice).mul(sign));
  const slippage = dec(spec.costs.slippageAllowanceTicks).mul(spec.tickValue).mul(qty);
  const commission = dec(spec.costs.commissionPerUnitRoundTurn).mul(qty);
  const risk = adverse.mul(vpp).mul(qty).plus(slippage).plus(commission);
  return { ...base, riskToStop: toNum(risk) };
}

function computeOpenRisk(
  snapshot: AccountSnapshot,
  lookup: InstrumentLookup,
): { state: OpenRiskState; amount: Dec } {
  // Working entry orders count as if filled at their limit (they can fill without asking).
  const positions = exposurePositions(snapshot).map((p) => positionRiskToStop(p, lookup(p.symbol)));
  const undetailed = undetailedPendingOrders(snapshot);
  if (undetailed > 0) {
    positions.push({
      positionId: 'pending-orders',
      symbol: '*',
      riskToStop: null,
      unknownReason: `${undetailed} pending order(s) reported without details`,
    });
  }
  const complete = positions.every((p) => p.riskToStop !== null);
  const amount = positions.reduce((sum, p) => sum.plus(p.riskToStop ?? 0), ZERO);
  return { state: { amount: toNum(amount), complete, positions }, amount };
}

function usedPct(used: Dec, limit: Dec): number {
  return toNum(decMax(ZERO, used).div(limit).mul(100), 4);
}

function computeDailyLoss(
  rule: DailyLossRule,
  tracking: AccountTracking,
  snapshot: AccountSnapshot,
  initial: Dec,
  worstCaseEquity: Dec | null,
): DailyLossState {
  const dayStartBalance = dec(tracking.dayStartBalance);
  const dayStartEquity = dec(tracking.dayStartEquity);
  const reference =
    rule.reference === 'DAY_START_BALANCE'
      ? dayStartBalance
      : rule.reference === 'DAY_START_EQUITY'
        ? dayStartEquity
        : decMax(dayStartBalance, dayStartEquity);

  const limit =
    rule.limit.kind === 'AMOUNT'
      ? dec(rule.limit.value)
      : rule.limit.kind === 'PERCENT_OF_INITIAL'
        ? initial.mul(rule.limit.value).div(100)
        : reference.mul(rule.limit.value).div(100);

  let floor = reference.minus(limit);
  let floorSource: DailyLossState['floorSource'] = 'COMPUTED';
  const reportedFloor = snapshot.reported?.dailyLossFloor;
  if (reportedFloor !== undefined && dec(reportedFloor).gt(floor)) {
    floor = dec(reportedFloor); // conservative: the higher floor wins
    floorSource = 'REPORTED';
  }

  const measureValue = rule.measure === 'EQUITY' ? dec(snapshot.equity) : dec(snapshot.balance);
  const remaining = measureValue.minus(floor);
  const used = limit.minus(remaining);
  // In the worst case all positions are closed at their stops, so realized == equity − open risk
  // for both EQUITY and BALANCE measures.
  const wcRemaining = worstCaseEquity ? worstCaseEquity.minus(floor) : null;

  return {
    limit: toNum(limit),
    reference: toNum(reference),
    floor: toNum(floor),
    measureValue: toNum(measureValue),
    used: toNum(decMax(ZERO, used)),
    remaining: toNum(remaining),
    usedPct: usedPct(used, limit),
    worstCaseRemaining: wcRemaining ? toNum(wcRemaining) : null,
    worstCaseUsedPct: wcRemaining ? usedPct(limit.minus(wcRemaining), limit) : null,
    breached: remaining.lte(0),
    floorSource,
  };
}

export function drawdownPeak(
  rule: MaxDrawdownRule,
  tracking: AccountTracking,
  snapshot: AccountSnapshot,
  initial: Dec,
): Dec {
  switch (rule.type) {
    case 'STATIC':
      return initial;
    case 'TRAILING_INTRADAY_EQUITY':
      return decMax(initial, dec(tracking.equityPeak), dec(snapshot.equity));
    case 'TRAILING_BALANCE':
      return decMax(initial, dec(tracking.balancePeak), dec(snapshot.balance));
    case 'TRAILING_END_OF_DAY':
      return decMax(initial, dec(tracking.endOfDayBalancePeak));
  }
}

function computeDrawdown(
  rule: MaxDrawdownRule,
  tracking: AccountTracking,
  snapshot: AccountSnapshot,
  initial: Dec,
  worstCaseEquity: Dec | null,
): DrawdownState {
  const limit = resolveInitialBasedLimit(rule.limit, initial);
  const peak = drawdownPeak(rule, tracking, snapshot, initial);
  const raw = peak.minus(limit);

  let threshold = raw;
  let locked = false;
  const stop = rule.trailingStopsAt;
  if (stop.kind !== 'NEVER') {
    const lockLevel = stop.kind === 'INITIAL_BALANCE' ? initial : initial.plus(stop.amount);
    if (raw.gte(lockLevel)) {
      threshold = lockLevel;
      locked = true;
    }
  }

  let thresholdSource: DrawdownState['thresholdSource'] = 'COMPUTED';
  const reported = snapshot.reported?.drawdownThreshold;
  if (reported !== undefined && dec(reported).gt(threshold)) {
    threshold = dec(reported); // conservative: the higher threshold wins
    thresholdSource = 'REPORTED';
  }

  const measureValue = rule.measure === 'EQUITY' ? dec(snapshot.equity) : dec(snapshot.balance);
  const remaining = measureValue.minus(threshold);
  const used = limit.minus(remaining);
  const wcRemaining = worstCaseEquity ? worstCaseEquity.minus(threshold) : null;

  return {
    type: rule.type,
    limit: toNum(limit),
    peak: toNum(peak),
    threshold: toNum(threshold),
    thresholdLocked: locked,
    measureValue: toNum(measureValue),
    used: toNum(decMax(ZERO, used)),
    remaining: toNum(remaining),
    usedPct: usedPct(used, limit),
    worstCaseRemaining: wcRemaining ? toNum(wcRemaining) : null,
    worstCaseUsedPct: wcRemaining ? usedPct(limit.minus(wcRemaining), limit) : null,
    breached: remaining.lte(0),
    thresholdSource,
  };
}

function computeConsistency(
  profile: PropFirmRuleProfile,
  tracking: AccountTracking,
  snapshot: AccountSnapshot,
  initial: Dec,
): ConsistencyState | null {
  const rule = profile.consistency;
  if (!rule) return null;
  const totalProfit = dec(snapshot.balance).minus(initial);
  const today = dec(snapshot.balance).minus(tracking.dayStartBalance);
  const best = tracking.completedDays.reduce((m, d) => decMax(m, dec(d.pnl)), today);
  const positiveTotal = totalProfit.gt(0);
  const todayShare = positiveTotal ? decMax(ZERO, today).div(totalProfit).mul(100) : null;
  const bestShare = positiveTotal ? decMax(ZERO, best).div(totalProfit).mul(100) : null;
  return {
    maxDayProfitSharePct: rule.maxDayProfitSharePct,
    totalProfit: toNum(totalProfit),
    todayRealizedPnl: toNum(today),
    bestDayPnl: toNum(best),
    todaySharePct: todayShare ? toNum(todayShare, 4) : null,
    bestDaySharePct: bestShare ? toNum(bestShare, 4) : null,
    todayAtOrAboveLimit: todayShare !== null && todayShare.gte(rule.maxDayProfitSharePct),
  };
}

export function computeAccountState(input: {
  profile: PropFirmRuleProfile;
  tracking: AccountTracking;
  snapshot: AccountSnapshot;
  instruments: InstrumentLookup;
}): AccountState {
  const { profile, tracking, snapshot } = input;
  if (tracking.accountId !== snapshot.accountId) {
    throw new AstraError('VALIDATION', 'tracking and snapshot belong to different accounts');
  }
  if (snapshot.currency !== profile.currency) {
    throw new AstraError(
      'VALIDATION',
      'snapshot currency does not match the rule profile currency',
      {
        snapshot: snapshot.currency,
        profile: profile.currency,
      },
    );
  }

  const initial = dec(tracking.initialBalance);
  const equity = dec(snapshot.equity);
  const balance = dec(snapshot.balance);
  const { state: openRisk, amount: openRiskAmount } = computeOpenRisk(snapshot, input.instruments);
  const worstCaseEquity = openRisk.complete ? equity.minus(openRiskAmount) : null;

  const dailyLoss = profile.dailyLoss
    ? computeDailyLoss(profile.dailyLoss, tracking, snapshot, initial, worstCaseEquity)
    : null;
  const drawdown = computeDrawdown(
    profile.maxDrawdown,
    tracking,
    snapshot,
    initial,
    worstCaseEquity,
  );

  const remainders = [dec(drawdown.remaining)];
  if (dailyLoss) remainders.push(dec(dailyLoss.remaining));
  const distance = decMin(remainders[0]!, ...remainders.slice(1));
  const bindingLimit =
    dailyLoss && dec(dailyLoss.remaining).lt(drawdown.remaining) ? 'DAILY_LOSS' : 'MAX_DRAWDOWN';

  let worstCaseDistance: number | null = null;
  if (openRisk.complete && drawdown.worstCaseRemaining !== null) {
    const wc = [dec(drawdown.worstCaseRemaining)];
    const dailyWc = dailyLoss ? dailyLoss.worstCaseRemaining : null;
    if (dailyWc !== null) wc.push(dec(dailyWc));
    worstCaseDistance = toNum(decMin(wc[0]!, ...wc.slice(1)));
  }

  let profitTarget: ProfitTargetState | null = null;
  if (profile.objectives.profitTarget) {
    const target = resolveInitialBasedLimit(profile.objectives.profitTarget, initial);
    const progress = balance.minus(initial);
    profitTarget = {
      target: toNum(target),
      progress: toNum(progress),
      remaining: toNum(decMax(ZERO, target.minus(progress))),
      progressPct: toNum(decMax(ZERO, progress).div(target).mul(100), 4),
      reached: progress.gte(target),
    };
  }

  const required = profile.objectives.minTradingDays;
  return {
    accountId: snapshot.accountId,
    asOf: snapshot.asOf,
    currency: snapshot.currency,
    initialBalance: toNum(initial),
    balance: toNum(balance),
    equity: toNum(equity),
    floatingPnl: toNum(equity.minus(balance)),
    realizedPnlToday: toNum(balance.minus(tracking.dayStartBalance)),
    totalPnl: toNum(equity.minus(initial)),
    tradingDayKey: tracking.tradingDayKey,
    dayStartSource: tracking.dayStartSource,
    dailyLoss,
    drawdown,
    openRisk,
    worstCaseEquity: worstCaseEquity ? toNum(worstCaseEquity) : null,
    distanceToBreach: toNum(distance),
    worstCaseDistanceToBreach: worstCaseDistance,
    bindingLimit,
    profitTarget,
    consistency: computeConsistency(profile, tracking, snapshot, initial),
    tradingDays: {
      count: tracking.tradingDaysCount,
      required,
      met: required === null || tracking.tradingDaysCount >= required,
    },
    breached:
      drawdown.breached ||
      (dailyLoss !== null &&
        dailyLoss.breached &&
        profile.dailyLoss?.breachConsequence === 'ACCOUNT_FAILED'),
    dayLocked: dailyLoss !== null && dailyLoss.breached,
  };
}
