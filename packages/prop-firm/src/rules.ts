/**
 * Prop-Firm Rule Engine — the spec's `canTrade(account, proposedTrade)` (§10).
 *
 * Every rule returns PASS / FAIL / UNKNOWN with a human-readable message. The verdict is
 * APPROVED only if every rule passes; any FAIL → REJECTED; otherwise any UNKNOWN → UNKNOWN
 * (which also means "not approved"). Rules evaluate the WORST CASE: all open positions and the
 * proposed trade stopped out, with cost allowances.
 */
import {
  ZERO,
  dec,
  decMax,
  directionSign,
  effectiveImpact,
  exposurePositions,
  eventAffects,
  minutesBetween,
  nextDailyTime,
  nextWeeklyTime,
  toNum,
  valuePerPoint,
  type AccountDefinition,
  type AccountSnapshot,
  type CalendarWindow,
  type Dec,
  type Direction,
  type InstrumentSpec,
  type Observed,
} from '@astra/core';
import type { AccountState, InstrumentLookup } from './account-state';
import { resolveInitialBasedLimit } from './account-state';
import { trailingConsumption, trailingExposure } from './trailing';
import type { NewsRestriction, PropFirmRuleProfile } from './profile';

export type RuleVerdict = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface RuleCheck {
  readonly rule: string;
  readonly verdict: RuleVerdict;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface ProposedTrade {
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  /** Loss if stopped out, incl. cost allowances, in account currency (from position sizing). */
  readonly worstCaseLoss: number;
}

export interface PropFirmEvaluationInput {
  readonly profile: PropFirmRuleProfile;
  readonly account: AccountDefinition;
  readonly state: AccountState;
  readonly snapshot: AccountSnapshot;
  readonly proposal: ProposedTrade;
  readonly instruments: InstrumentLookup;
  /** Economic calendar; required when the profile restricts news trading. */
  readonly calendar: Observed<CalendarWindow>;
  readonly now: Date;
  /**
   * Latest time the entry can happen (a resting LIMIT order fills until it expires). News and
   * flat-time rules then cover the whole window. Default: now.
   */
  readonly entryUntil?: Date;
  /** Refuse new trades this many minutes before a mandatory flat time / weekly close. */
  readonly flatBufferMinutes: number;
}

export type PropFirmStatus = 'APPROVED' | 'REJECTED' | 'UNKNOWN';

export interface PropFirmVerdict {
  readonly approved: boolean;
  readonly status: PropFirmStatus;
  /** Messages of every non-passing rule. */
  readonly reasons: readonly string[];
  readonly checks: readonly RuleCheck[];
}

const pass = (rule: string, message: string, details?: Record<string, unknown>): RuleCheck => ({
  rule,
  verdict: 'PASS',
  message,
  ...(details ? { details } : {}),
});
const fail = (rule: string, message: string, details?: Record<string, unknown>): RuleCheck => ({
  rule,
  verdict: 'FAIL',
  message,
  ...(details ? { details } : {}),
});
const unknown = (rule: string, message: string, details?: Record<string, unknown>): RuleCheck => ({
  rule,
  verdict: 'UNKNOWN',
  message,
  ...(details ? { details } : {}),
});

function weightOf(profile: PropFirmRuleProfile, symbol: string): Dec {
  return dec(profile.positionLimits.quantityWeights[symbol] ?? 1);
}

interface WeightedTotals {
  contracts: Dec;
  lots: Dec;
  all: Dec;
  unknownSymbols: string[];
}

function weightedOpenTotals(
  profile: PropFirmRuleProfile,
  snapshot: AccountSnapshot,
  lookup: InstrumentLookup,
): WeightedTotals {
  const totals: WeightedTotals = { contracts: ZERO, lots: ZERO, all: ZERO, unknownSymbols: [] };
  for (const p of exposurePositions(snapshot)) {
    const spec = lookup(p.symbol);
    if (!spec) {
      totals.unknownSymbols.push(p.symbol);
      continue;
    }
    const w = weightOf(profile, p.symbol).mul(p.quantity);
    totals.all = totals.all.plus(w);
    if (spec.quantityUnit === 'CONTRACTS') totals.contracts = totals.contracts.plus(w);
    if (spec.quantityUnit === 'LOTS') totals.lots = totals.lots.plus(w);
  }
  return totals;
}

function applicableScalingLimit(profile: PropFirmRuleProfile, state: AccountState): Dec | null {
  if (!profile.scaling) return null;
  const profit = dec(state.balance).minus(state.initialBalance);
  const tiers = [...profile.scaling.tiers].sort((a, b) => a.minProfit - b.minProfit);
  const applicable = tiers.filter((t) => profit.gte(t.minProfit));
  // Below the lowest tier nothing is allowed.
  const tier = applicable.at(-1);
  return tier ? dec(tier.maxWeightedQuantity) : ZERO;
}

export interface QuantityHeadroom {
  /** Maximum additional quantity the firm's position limits allow. null = no firm limit. */
  readonly maxQuantity: number | null;
  readonly bindingRule: string | null;
  /** Open positions on instruments without specs make headroom unknown. */
  readonly complete: boolean;
}

/**
 * Maximum additional quantity of `spec.symbol` allowed by firm position limits
 * (contracts/lots caps, per-instrument caps, scaling plan). Used by position sizing.
 */
export function firmQuantityHeadroom(params: {
  profile: PropFirmRuleProfile;
  state: AccountState;
  snapshot: AccountSnapshot;
  spec: InstrumentSpec;
  instruments: InstrumentLookup;
}): QuantityHeadroom {
  const { profile, snapshot, spec } = params;
  const totals = weightedOpenTotals(profile, snapshot, params.instruments);
  const weight = weightOf(profile, spec.symbol);
  const limits: { rule: string; qty: Dec }[] = [];
  const pl = profile.positionLimits;

  if (spec.quantityUnit === 'CONTRACTS' && pl.maxContracts !== null) {
    limits.push({
      rule: 'max-contracts',
      qty: dec(pl.maxContracts).minus(totals.contracts).div(weight),
    });
  }
  if (spec.quantityUnit === 'LOTS' && pl.maxLots !== null) {
    limits.push({ rule: 'max-lots', qty: dec(pl.maxLots).minus(totals.lots).div(weight) });
  }
  const perInstrument = pl.perInstrumentMaxQuantity[spec.symbol];
  if (perInstrument !== undefined) {
    const openQty = exposurePositions(snapshot)
      .filter((p) => p.symbol === spec.symbol)
      .reduce((s, p) => s.plus(p.quantity), ZERO);
    limits.push({ rule: 'per-instrument-max', qty: dec(perInstrument).minus(openQty) });
  }
  const scaling = applicableScalingLimit(profile, params.state);
  if (scaling !== null) {
    limits.push({ rule: 'scaling-plan', qty: scaling.minus(totals.all).div(weight) });
  }

  if (limits.length === 0) {
    return { maxQuantity: null, bindingRule: null, complete: totals.unknownSymbols.length === 0 };
  }
  const binding = limits.reduce((m, l) => (l.qty.lt(m.qty) ? l : m));
  return {
    maxQuantity: toNum(binding.qty.lt(0) ? ZERO : binding.qty),
    bindingRule: binding.rule,
    complete: totals.unknownSymbols.length === 0,
  };
}

function checkNews(
  rule: NewsRestriction,
  symbol: string,
  calendar: Observed<CalendarWindow>,
  now: Date,
  until: Date,
): RuleCheck {
  const id = 'news-restriction';
  if (calendar.status !== 'OK') {
    return unknown(id, `economic calendar ${calendar.status}: ${calendar.reason}`);
  }
  const needFrom = now.getTime() - rule.minutesAfter * 60_000;
  const needTo = Math.max(now.getTime(), until.getTime()) + rule.minutesBefore * 60_000;
  const w = calendar.value;
  if (Date.parse(w.from) > needFrom || Date.parse(w.to) < needTo) {
    return unknown(id, 'economic calendar does not cover the restricted window', {
      coverage: { from: w.from, to: w.to },
      required: { from: new Date(needFrom).toISOString(), to: new Date(needTo).toISOString() },
    });
  }
  const blocking = w.events.filter((e) => {
    const t = Date.parse(e.scheduledAt);
    return (
      rule.impactLevels.includes(effectiveImpact(e.impact)) &&
      eventAffects(e, symbol) &&
      t >= needFrom &&
      t <= needTo
    );
  });
  if (blocking.length > 0) {
    const first = blocking[0]!;
    return fail(
      id,
      `firm news restriction: ${first.title} (${first.impact}) at ${first.scheduledAt}`,
      {
        events: blocking.map((e) => ({
          id: e.id,
          title: e.title,
          at: e.scheduledAt,
          impact: e.impact,
        })),
      },
    );
  }
  return pass(id, 'no restricted events in the firm news window');
}

/** The spec's canTrade(account, proposedTrade). */
export function evaluatePropFirmRules(input: PropFirmEvaluationInput): PropFirmVerdict {
  const { profile, account, state, snapshot, proposal, now } = input;
  const entryEnd = input.entryUntil && input.entryUntil > now ? input.entryUntil : now;
  const checks: RuleCheck[] = [];
  const spec = input.instruments(proposal.symbol);

  // Account status and breach state.
  checks.push(
    account.status === 'ACTIVE'
      ? pass('account-status', 'account is ACTIVE')
      : fail('account-status', `account status is ${account.status}`),
  );
  if (state.breached) {
    checks.push(fail('breach-state', 'account has breached a hard limit'));
  } else if (state.dayLocked) {
    checks.push(fail('breach-state', 'daily loss limit reached; locked until the next reset'));
  } else {
    checks.push(pass('breach-state', 'no limit breached'));
  }

  if (!spec) {
    checks.push(fail('instrument-spec', `no instrument spec for ${proposal.symbol}`));
  }

  // Stop placement (a stop is always required by ASTRA; the firm may require it too).
  const sign = directionSign(proposal.direction);
  const stopDistance = dec(proposal.entry).minus(proposal.stop).mul(sign);
  checks.push(
    stopDistance.gt(0)
      ? pass('stop-loss', 'protective stop is on the correct side of entry')
      : fail('stop-loss', 'stop must be below entry for LONG and above entry for SHORT'),
  );

  // Worst-case daily loss.
  const tradeLoss = dec(proposal.worstCaseLoss);
  if (!state.openRisk.complete) {
    const reason = state.openRisk.positions.find((p) => p.riskToStop === null)?.unknownReason;
    checks.push(
      unknown('daily-loss-worst-case', `open risk unknown: ${reason ?? 'unknown position risk'}`),
    );
    checks.push(
      unknown('drawdown-worst-case', `open risk unknown: ${reason ?? 'unknown position risk'}`),
    );
  } else {
    if (state.dailyLoss === null) {
      checks.push(pass('daily-loss-worst-case', 'profile has no daily loss limit'));
    } else {
      const after = dec(state.dailyLoss.worstCaseRemaining ?? 0).minus(tradeLoss);
      const details = { remainingAfterWorstCase: toNum(after), floor: state.dailyLoss.floor };
      checks.push(
        after.gt(0)
          ? pass('daily-loss-worst-case', 'daily loss floor holds if all stops are hit', details)
          : fail(
              'daily-loss-worst-case',
              'remaining daily loss buffer insufficient: worst case would breach the daily loss floor',
              details,
            ),
      );
    }
    const trailing = trailingExposure(
      profile.maxDrawdown,
      state,
      exposurePositions(snapshot),
      input.instruments,
    );
    if (trailing?.applies) {
      // Trailing intraday equity: the trade may run to its target (raising the threshold) and
      // then reverse to its stop — the buffer must survive that path, not just the stop.
      if (trailing.pathRemaining === null || !spec) {
        checks.push(
          unknown(
            'drawdown-worst-case',
            `trailing drawdown path risk unknown: ${spec ? trailing.note : `no instrument spec for ${proposal.symbol}`}`,
          ),
        );
      } else {
        const runUp = decMax(ZERO, dec(proposal.target).minus(proposal.entry).mul(sign))
          .mul(valuePerPoint(spec))
          .mul(proposal.quantity);
        const consumed = trailingConsumption(trailing, tradeLoss, runUp);
        const ddAfter = dec(trailing.pathRemaining).minus(consumed);
        const ddDetails = {
          mode: 'TRAILING_PATH',
          remainingAfterWorstPath: toNum(ddAfter),
          threshold: state.drawdown.threshold,
          pathThresholdBefore: trailing.pathThreshold,
          tradeRunUp: toNum(runUp, 2),
          lockLevel: trailing.lockLevel,
        };
        checks.push(
          ddAfter.gt(0)
            ? pass(
                'drawdown-worst-case',
                'trailing drawdown threshold holds even if the trade runs to its target and then reverses to its stop',
                ddDetails,
              )
            : fail(
                'drawdown-worst-case',
                'remaining trailing drawdown buffer insufficient: a run to the target followed by a reversal to the stop would breach the threshold',
                ddDetails,
              ),
        );
      }
    } else {
      const ddAfter = dec(state.drawdown.worstCaseRemaining ?? 0).minus(tradeLoss);
      const ddDetails = {
        remainingAfterWorstCase: toNum(ddAfter),
        threshold: state.drawdown.threshold,
      };
      checks.push(
        ddAfter.gt(0)
          ? pass('drawdown-worst-case', 'drawdown threshold holds if all stops are hit', ddDetails)
          : fail(
              'drawdown-worst-case',
              'remaining drawdown buffer insufficient: worst case would breach the max drawdown threshold',
              ddDetails,
            ),
      );
    }
  }

  // Firm max risk per trade.
  if (profile.trading.maxRiskPerTrade) {
    const limit = resolveInitialBasedLimit(
      profile.trading.maxRiskPerTrade,
      dec(state.initialBalance),
    );
    checks.push(
      tradeLoss.lte(limit)
        ? pass('max-risk-per-trade', 'trade risk within firm per-trade limit')
        : fail(
            'max-risk-per-trade',
            `trade risk ${toNum(tradeLoss)} exceeds firm per-trade limit ${toNum(limit)}`,
          ),
    );
  }

  // Position limits (contracts, lots, per-instrument, scaling).
  if (spec) {
    const headroom = firmQuantityHeadroom({
      profile,
      state,
      snapshot,
      spec,
      instruments: input.instruments,
    });
    if (!headroom.complete) {
      checks.push(
        unknown(
          'position-limits',
          'open positions on instruments without specs; limits cannot be verified',
        ),
      );
    } else if (headroom.maxQuantity === null) {
      checks.push(pass('position-limits', 'no firm quantity limits apply'));
    } else {
      checks.push(
        dec(proposal.quantity).lte(headroom.maxQuantity)
          ? pass('position-limits', 'quantity within firm limits', {
              headroom: headroom.maxQuantity,
            })
          : fail(
              'position-limits',
              `quantity ${proposal.quantity} exceeds firm limit (${headroom.bindingRule}: max additional ${headroom.maxQuantity})`,
              { headroom: headroom.maxQuantity, bindingRule: headroom.bindingRule },
            ),
      );
    }
  }

  const pl = profile.positionLimits;
  if (pl.maxOpenPositions !== null) {
    const after = exposurePositions(snapshot).length + 1;
    checks.push(
      after <= pl.maxOpenPositions
        ? pass('max-open-positions', `${after}/${pl.maxOpenPositions} positions after trade`)
        : fail('max-open-positions', `would exceed max open positions (${pl.maxOpenPositions})`),
    );
  }

  if (!profile.trading.hedgingAllowed) {
    const opposite = exposurePositions(snapshot).some(
      (p) => p.symbol === proposal.symbol && p.direction !== proposal.direction,
    );
    checks.push(
      opposite
        ? fail('hedging', 'firm prohibits hedging and an opposite position is open')
        : pass('hedging', 'no opposite position open'),
    );
  }

  if (pl.maxLeverage !== null && spec) {
    let notional = ZERO;
    let complete = true;
    for (const p of exposurePositions(snapshot)) {
      const s = input.instruments(p.symbol);
      if (!s) {
        complete = false;
        continue;
      }
      notional = notional.plus(dec(p.currentPrice).mul(valuePerPoint(s)).mul(p.quantity));
    }
    notional = notional.plus(dec(proposal.entry).mul(valuePerPoint(spec)).mul(proposal.quantity));
    const equity = dec(state.equity);
    if (!complete) {
      checks.push(unknown('leverage', 'cannot compute notional for all open positions'));
    } else if (equity.lte(0)) {
      checks.push(fail('leverage', 'equity is not positive'));
    } else {
      const leverage = notional.div(equity);
      checks.push(
        leverage.lte(pl.maxLeverage)
          ? pass('leverage', `leverage ${toNum(leverage, 2)}x within ${pl.maxLeverage}x`)
          : fail('leverage', `leverage ${toNum(leverage, 2)}x exceeds firm max ${pl.maxLeverage}x`),
      );
    }
  }

  // News restriction.
  if (profile.news) {
    checks.push(checkNews(profile.news, proposal.symbol, input.calendar, now, entryEnd));
  }

  // Holding rules: mandatory flat time and weekend close.
  const h = profile.holding;
  if (h.flatBy) {
    const until = minutesBetween(entryEnd, nextDailyTime(now, h.flatBy));
    checks.push(
      until > input.flatBufferMinutes
        ? pass('flat-by', `${Math.floor(until)} min until mandatory flat time`)
        : fail(
            'flat-by',
            `within ${input.flatBufferMinutes} min of mandatory flat time (${h.flatBy.time} ${h.flatBy.timeZone})`,
          ),
    );
  }
  if (h.weekend === 'PROHIBITED' && h.weeklyClose) {
    const until = minutesBetween(entryEnd, nextWeeklyTime(now, h.weeklyClose));
    checks.push(
      until > input.flatBufferMinutes
        ? pass('weekend-holding', `${Math.floor(until)} min until weekly close`)
        : fail(
            'weekend-holding',
            `within ${input.flatBufferMinutes} min of weekly close; weekend holding prohibited`,
          ),
    );
  }

  // Consistency.
  if (profile.consistency?.enforcement === 'BLOCK_NEW_TRADES' && state.consistency) {
    checks.push(
      state.consistency.todayAtOrAboveLimit
        ? fail(
            'consistency',
            `today's profit is ${state.consistency.todaySharePct}% of total profit (limit ${state.consistency.maxDayProfitSharePct}%)`,
          )
        : pass('consistency', 'daily profit share within consistency limit'),
    );
  }

  const failed = checks.filter((c) => c.verdict === 'FAIL');
  const unknowns = checks.filter((c) => c.verdict === 'UNKNOWN');
  const status: PropFirmStatus =
    failed.length > 0 ? 'REJECTED' : unknowns.length > 0 ? 'UNKNOWN' : 'APPROVED';
  return {
    approved: status === 'APPROVED',
    status,
    reasons: [...failed, ...unknowns].map((c) => c.message),
    checks,
  };
}
