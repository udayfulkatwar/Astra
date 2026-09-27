/**
 * Internal risk-policy checks for a proposed trade (the Capital Preservation Engine's verdict).
 * Each check is PASS / FAIL / UNKNOWN; approval requires all PASS.
 */
import {
  dec,
  directionSign,
  toNum,
  type AccountActivity,
  type AccountSnapshot,
  type Direction,
  type StrategyDefinition,
} from '@astra/core';
import { trailingConsumption, type AccountState, type TrailingExposure } from '@astra/prop-firm';
import type { AccountHealthAssessment } from './health';
import type { RiskPolicy } from './policy';
import type { PositionSizing } from './position-sizing';

export type RiskCheckVerdict = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface RiskCheck {
  readonly check: string;
  readonly verdict: RiskCheckVerdict;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface RiskVerdict {
  readonly approved: boolean;
  readonly reasons: readonly string[];
  readonly checks: readonly RiskCheck[];
}

export interface RiskPolicyInput {
  readonly policy: RiskPolicy;
  readonly strategy: StrategyDefinition;
  readonly health: AccountHealthAssessment;
  readonly sizing: PositionSizing;
  readonly state: AccountState;
  readonly snapshot: AccountSnapshot;
  readonly activity: AccountActivity;
  readonly symbol: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  /** Trailing intraday-equity exposure (prop-firm `trailingExposure`); null/undefined = none. */
  readonly trailing?: TrailingExposure | null | undefined;
  /** Value of one point for one unit (instrument tick value / tick size). */
  readonly valuePerPoint?: number | undefined;
}

/** Reward-to-risk on price distance. null when levels are invalid. */
export function rewardToRisk(
  direction: Direction,
  entry: number,
  stop: number,
  target: number,
): number | null {
  const sign = directionSign(direction);
  const risk = dec(entry).minus(stop).mul(sign);
  const reward = dec(target).minus(entry).mul(sign);
  if (risk.lte(0) || reward.lte(0)) return null;
  return toNum(reward.div(risk), 4);
}

export function evaluateRiskPolicy(input: RiskPolicyInput): RiskVerdict {
  const { policy, strategy, health, sizing, state, snapshot, activity } = input;
  const checks: RiskCheck[] = [];
  const add = (
    check: string,
    ok: boolean,
    passMsg: string,
    failMsg: string,
    details?: Record<string, unknown>,
  ) =>
    checks.push({
      check,
      verdict: ok ? 'PASS' : 'FAIL',
      message: ok ? passMsg : failMsg,
      ...(details ? { details } : {}),
    });

  if (health.health === 'UNKNOWN') {
    checks.push({
      check: 'account-health',
      verdict: 'UNKNOWN',
      message: `account health UNKNOWN: ${health.reasons.join('; ')}`,
    });
  } else {
    add(
      'account-health',
      health.allowsNewTrades,
      `account health ${health.health}`,
      `account health ${health.health}: ${health.reasons.join('; ')}`,
      {
        health: health.health,
        usagePct: health.usagePct,
        worstCaseUsagePct: health.worstCaseUsagePct,
      },
    );
  }

  const minRR = Math.max(policy.perTrade.minRewardToRisk, strategy.minRewardToRisk);
  const rr = rewardToRisk(input.direction, input.entry, input.stop, input.target);
  add(
    'reward-to-risk',
    rr !== null && rr >= minRR,
    `R:R ${rr} ≥ ${minRR}`,
    rr === null
      ? 'invalid stop/target placement for R:R'
      : `R:R ${rr} below configured minimum ${minRR}`,
    { rewardToRisk: rr, minimum: minRR },
  );

  const maxTrades = Math.min(
    policy.activity.maxTradesPerDay,
    strategy.maxTradesPerDay ?? Number.POSITIVE_INFINITY,
  );
  add(
    'trades-per-day',
    activity.tradesToday < maxTrades,
    `${activity.tradesToday}/${maxTrades} trades today`,
    `max trades per day reached (${activity.tradesToday}/${maxTrades})`,
  );
  add(
    'consecutive-losses',
    activity.consecutiveLosses < policy.activity.maxConsecutiveLosses,
    `${activity.consecutiveLosses} consecutive losses`,
    `consecutive losses ${activity.consecutiveLosses} reached limit ${policy.activity.maxConsecutiveLosses}`,
  );

  const open = snapshot.openPositions;
  add(
    'open-positions',
    open.length + 1 <= policy.exposure.maxOpenPositions,
    `${open.length + 1}/${policy.exposure.maxOpenPositions} positions after trade`,
    `would exceed max open positions (${policy.exposure.maxOpenPositions})`,
  );
  const sameSymbol = open.filter((p) => p.symbol === input.symbol);
  add(
    'positions-per-instrument',
    sameSymbol.length + 1 <= policy.exposure.maxPositionsPerInstrument,
    `${sameSymbol.length + 1}/${policy.exposure.maxPositionsPerInstrument} positions in ${input.symbol}`,
    `would exceed max positions in ${input.symbol} (${policy.exposure.maxPositionsPerInstrument})`,
  );
  if (!policy.exposure.allowPyramiding) {
    add(
      'pyramiding',
      !sameSymbol.some((p) => p.direction === input.direction),
      'no same-direction position open',
      `a ${input.direction} position in ${input.symbol} is already open and pyramiding is disabled`,
    );
  }

  if (!sizing.ok) {
    add('position-size', false, '', `position sizing rejected: ${sizing.reason}`, {
      constraints: sizing.constraints,
    });
  } else {
    add(
      'position-size',
      true,
      `size ${sizing.quantity} (binding: ${sizing.bindingConstraint}), risk ${sizing.dollarRisk}`,
      '',
      {
        quantity: sizing.quantity,
        dollarRisk: sizing.dollarRisk,
        bindingConstraint: sizing.bindingConstraint,
      },
    );

    // Defense in depth: independently verify the survival buffer after a worst-case loss.
    const survival = dec(policy.buffers.survivalBufferAmount);
    const risk = dec(sizing.dollarRisk);
    const trailing = input.trailing;
    let dd = dec(state.drawdown.worstCaseRemaining ?? 0).minus(risk);
    if (trailing?.applies) {
      // Trailing intraday equity: the worst path runs to the target, then reverses to the stop.
      const runUp =
        input.valuePerPoint === undefined
          ? null
          : dec(input.target)
              .minus(input.entry)
              .mul(directionSign(input.direction))
              .mul(input.valuePerPoint)
              .mul(sizing.quantity);
      dd =
        trailing.pathRemaining === null || runUp === null
          ? dec(-1) // unknown path risk never passes
          : dec(trailing.pathRemaining).minus(
              trailingConsumption(trailing, risk, runUp.lt(0) ? dec(0) : runUp),
            );
    }
    const daily = state.dailyLoss ? dec(state.dailyLoss.worstCaseRemaining ?? 0).minus(risk) : null;
    const ok = dd.gte(survival) && (daily === null || daily.gte(survival));
    add(
      'survival-buffer',
      ok,
      'worst case keeps the survival buffer above every hard limit',
      `worst case would leave less than the survival buffer (${policy.buffers.survivalBufferAmount}) above a hard limit`,
      { drawdownRemainingAfter: toNum(dd), dailyRemainingAfter: daily ? toNum(daily) : null },
    );
  }

  if (policy.targets.stopTradingWhenProfitTargetReached && state.profitTarget) {
    add(
      'profit-target-policy',
      !state.profitTarget.reached,
      'profit target not yet reached',
      'profit target reached; policy stops new trades',
    );
  }

  const blocking = checks.filter((c) => c.verdict !== 'PASS');
  return { approved: blocking.length === 0, reasons: blocking.map((c) => c.message), checks };
}
