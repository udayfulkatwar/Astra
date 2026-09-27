/**
 * Decision Engine: frozen inputs → derivations → gate checks → TradeDecision.
 * Pure and synchronous given the inputs (ids are injected), so decisions are reproducible.
 */
import { newId, type TradingMode } from '@astra/core';
import { STANDARD_CHECKS } from './checks';
import { deriveAll, type Derivations } from './derive';
import { GatePipeline } from './pipeline';
import type {
  ApprovedOrderPlan,
  DecisionExplanation,
  DecisionInputs,
  GateCheckResult,
  TradeDecision,
} from './types';

export interface DecisionEngineOptions {
  readonly pipeline?: GatePipeline;
  readonly newApprovalId?: () => string;
}

export class DecisionEngine {
  private readonly pipeline: GatePipeline;
  private readonly newApprovalId: () => string;

  constructor(opts: DecisionEngineOptions = {}) {
    this.pipeline = opts.pipeline ?? new GatePipeline(STANDARD_CHECKS);
    this.newApprovalId = opts.newApprovalId ?? (() => newId('approval'));
  }

  evaluate(inputs: DecisionInputs): TradeDecision {
    const derived = deriveAll(inputs);
    const checks = this.pipeline.run(inputs, derived);
    const blocking = checks.filter((c) => c.mandatory && c.verdict !== 'PASS');
    const sizing = derived.sizing.ok && derived.sizing.value.ok ? derived.sizing.value : null;
    const entry = derived.effectiveEntry.ok ? derived.effectiveEntry.value : null;

    // Approval requires at least one check, every mandatory check PASS, and a concrete size.
    const approved =
      checks.length > 0 && blocking.length === 0 && sizing !== null && entry !== null;
    const reasons = approved
      ? []
      : blocking.length > 0
        ? blocking.flatMap((c) => c.reasons.map((r) => `[${c.checkId}] ${r}`))
        : ['[decision] no valid position size or entry price'];

    const signal = inputs.candidate.signal;
    const orderPlan: ApprovedOrderPlan | null =
      approved && sizing && entry !== null
        ? {
            symbol: signal.symbol,
            direction: signal.direction,
            entryType: signal.entryType,
            entry,
            stop: signal.stop,
            target: signal.target,
            quantity: sizing.quantity,
          }
        : null;
    const approval = approved
      ? {
          approvalId: this.newApprovalId(),
          expiresAt: new Date(
            Date.parse(inputs.now) + inputs.policy.approvalTtlSeconds * 1000,
          ).toISOString(),
        }
      : null;

    return {
      decisionId: inputs.decisionId,
      accountId: inputs.candidate.accountId,
      strategyId: signal.strategyId,
      signalId: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      mode: inputs.mode,
      status: approved ? 'APPROVED' : 'REJECTED',
      reasons,
      checks,
      sizing: approved ? sizing : null,
      orderPlan,
      approval,
      configHash: inputs.configHash,
      decidedAt: inputs.now,
      explanation: explain(inputs, derived, checks, orderPlan, approval, inputs.mode),
    };
  }
}

function explain(
  inputs: DecisionInputs,
  derived: Derivations,
  checks: readonly GateCheckResult[],
  plan: ApprovedOrderPlan | null,
  approval: TradeDecision['approval'],
  mode: TradingMode,
): DecisionExplanation {
  const s = inputs.candidate.signal;
  const sizing = derived.sizing.ok && derived.sizing.value.ok ? derived.sizing.value : null;
  const failing = checks.filter((c) => c.mandatory && c.verdict !== 'PASS');
  const what = plan
    ? `APPROVED ${plan.direction} ${plan.quantity} ${plan.symbol} @ ~${plan.entry} (stop ${plan.stop}, target ${plan.target}) in ${mode}`
    : `NO TRADE: ${s.direction} ${s.symbol} from strategy ${s.strategyId} rejected in ${mode}`;
  const why = plan
    ? [...s.rationale, `all ${checks.length} gate checks passed`]
    : failing.flatMap((c) => c.reasons.map((r) => `${c.layer}: ${r}`));
  const risk = sizing
    ? `worst-case loss ${sizing.dollarRisk} ${inputs.account?.currency ?? ''} (${sizing.riskPctOfEquity}% of equity), binding limit: ${sizing.bindingConstraint}`.trim()
    : 'no position sized';
  const invalidatedBy = [
    `price reaching the stop at ${s.stop}`,
    ...(approval ? [`approval expiry at ${approval.expiresAt}`] : []),
    ...(inputs.strategy ? [`signal TTL of ${inputs.strategy.signalTtlSeconds}s`] : []),
  ];
  const wouldStop = [
    'any applicable kill switch (global, account, strategy, instrument, execution)',
    'mode change to HALTED',
    'daily-loss or drawdown limit usage reaching the restricted threshold',
    'a restricted economic event entering the blackout window',
  ];
  return { what, why, when: inputs.now, risk, invalidatedBy, wouldStop };
}
