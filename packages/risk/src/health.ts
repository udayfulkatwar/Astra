/**
 * Account health classification (spec §9): SAFE → CAUTION → RESTRICTED → BREACH_RISK → HALTED,
 * plus UNKNOWN when inputs are incomplete. Only SAFE and CAUTION permit new trades.
 */
import type { AccountActivity, AccountStatus } from '@astra/core';
import type { AccountState } from '@astra/prop-firm';
import type { RiskPolicy } from './policy';

export const ACCOUNT_HEALTH_STATES = [
  'SAFE',
  'CAUTION',
  'RESTRICTED',
  'BREACH_RISK',
  'HALTED',
  'UNKNOWN',
] as const;
export type AccountHealth = (typeof ACCOUNT_HEALTH_STATES)[number];

export interface AccountHealthAssessment {
  readonly health: AccountHealth;
  readonly allowsNewTrades: boolean;
  /** Multiplier applied to position size (1 when SAFE, policy value when CAUTION, 0 otherwise). */
  readonly sizeMultiplier: number;
  /** Max usage (%) of any hard limit at the current mark. */
  readonly usagePct: number;
  /** Max usage (%) of any hard limit if all open positions are stopped out. null = unknown. */
  readonly worstCaseUsagePct: number | null;
  readonly reasons: readonly string[];
}

export function classifyAccountHealth(input: {
  state: AccountState;
  policy: RiskPolicy;
  activity: AccountActivity;
  accountStatus: AccountStatus;
}): AccountHealthAssessment {
  const { state, policy, activity } = input;
  const usage = Math.max(state.drawdown.usedPct, state.dailyLoss?.usedPct ?? 0);
  const wcParts = [
    state.drawdown.worstCaseUsedPct,
    state.dailyLoss ? state.dailyLoss.worstCaseUsedPct : 0,
  ];
  const worstCaseUsage = wcParts.some((p) => p === null)
    ? null
    : Math.max(...(wcParts as number[]));

  const result = (health: AccountHealth, reasons: string[]): AccountHealthAssessment => ({
    health,
    allowsNewTrades: health === 'SAFE' || health === 'CAUTION',
    sizeMultiplier:
      health === 'SAFE' ? 1 : health === 'CAUTION' ? policy.health.cautionSizeMultiplier : 0,
    usagePct: usage,
    worstCaseUsagePct: worstCaseUsage,
    reasons,
  });

  // HALTED — nothing may trade.
  const halted: string[] = [];
  if (input.accountStatus !== 'ACTIVE') halted.push(`account status ${input.accountStatus}`);
  if (state.breached) halted.push('hard limit breached');
  if (state.dayLocked) halted.push('daily loss limit reached; locked until reset');
  if (halted.length > 0) return result('HALTED', halted);

  // UNKNOWN — cannot reason about risk.
  if (!state.openRisk.complete || worstCaseUsage === null) {
    const why = state.openRisk.positions.find((p) => p.riskToStop === null)?.unknownReason;
    return result('UNKNOWN', [`open risk unknown${why ? `: ${why}` : ''}`]);
  }

  // BREACH_RISK — the worst case is too close to a hard limit.
  const breach: string[] = [];
  if (worstCaseUsage >= policy.health.breachRiskUsagePct) {
    breach.push(
      `worst-case usage ${worstCaseUsage.toFixed(1)}% ≥ ${policy.health.breachRiskUsagePct}%`,
    );
  }
  if (
    state.worstCaseDistanceToBreach !== null &&
    state.worstCaseDistanceToBreach <= policy.buffers.survivalBufferAmount
  ) {
    breach.push(
      `worst-case distance to breach ${state.worstCaseDistanceToBreach} ≤ survival buffer ${policy.buffers.survivalBufferAmount}`,
    );
  }
  if (breach.length > 0) return result('BREACH_RISK', breach);

  // CAUTION / RESTRICTED use worst-case usage: risk already committed at open stops counts as used.
  // RESTRICTED — policy limits reached for now.
  const restricted: string[] = [];
  if (worstCaseUsage >= policy.health.restrictedUsagePct) {
    restricted.push(
      `worst-case limit usage ${worstCaseUsage.toFixed(1)}% ≥ ${policy.health.restrictedUsagePct}%`,
    );
  }
  if (activity.tradesToday >= policy.activity.maxTradesPerDay) {
    restricted.push(
      `max trades per day reached (${activity.tradesToday}/${policy.activity.maxTradesPerDay})`,
    );
  }
  if (activity.consecutiveLosses >= policy.activity.maxConsecutiveLosses) {
    restricted.push(
      `consecutive losses ${activity.consecutiveLosses} ≥ ${policy.activity.maxConsecutiveLosses}`,
    );
  }
  if (policy.targets.stopTradingWhenProfitTargetReached && state.profitTarget?.reached) {
    restricted.push('profit target reached; policy stops trading');
  }
  if (restricted.length > 0) return result('RESTRICTED', restricted);

  if (worstCaseUsage >= policy.health.cautionUsagePct) {
    return result('CAUTION', [
      `worst-case limit usage ${worstCaseUsage.toFixed(1)}% ≥ ${policy.health.cautionUsagePct}%; size reduced`,
    ]);
  }
  return result('SAFE', []);
}
