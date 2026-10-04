/**
 * Pre-submit revalidation (ADR-0027). The approved plan is never trusted on its own age: just
 * before an entry is reserved, the ORIGINAL candidate is run through the same assembler and the
 * same Decision Engine (every mandatory check, risk and prop-firm rule) on freshly gathered
 * inputs. It can only confirm or refuse — a plan is never enlarged or mutated here, and any
 * failure to revalidate is a refusal.
 */
import { errorMessage, type TradeCandidate } from '@astra/core';
import { assembleDecisionInputs, type AssembleOptions } from './assembler';
import type { DecisionEngine } from './engine';
import type { ApprovedOrderPlan } from './types';

export type EntryRevalidation =
  | {
      readonly ok: true;
      /** What the deterministic gate would permit now. Never below the approved quantity here. */
      readonly permittedQuantity: number;
      readonly entry: number;
      readonly checks: number;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

export async function revalidateApprovedEntry(opts: {
  readonly engine: DecisionEngine;
  /** Everything except the candidate: fresh data ports, current state, config and clock. */
  readonly assemble: Omit<AssembleOptions, 'candidate' | 'decisionId'>;
  readonly candidate: TradeCandidate;
  readonly plan: ApprovedOrderPlan;
  /** configHash of the original decision: configuration must not have changed since. */
  readonly originalConfigHash: string;
}): Promise<EntryRevalidation> {
  const { plan } = opts;
  try {
    const inputs = await assembleDecisionInputs({
      ...opts.assemble,
      candidate: opts.candidate,
      decisionId: 'revalidation',
    });
    const reasons: string[] = [];
    if (inputs.configHash !== opts.originalConfigHash)
      reasons.push('configuration changed since the decision (strategy/risk/firm rules differ)');
    const d = opts.engine.evaluate(inputs);
    if (d.status !== 'APPROVED' || !d.orderPlan) {
      reasons.push(...d.reasons);
    } else {
      const p = d.orderPlan;
      const s = opts.candidate.signal;
      if (
        p.symbol !== plan.symbol ||
        p.direction !== plan.direction ||
        p.entryType !== plan.entryType ||
        p.stop !== plan.stop ||
        p.target !== plan.target ||
        s.stop !== plan.stop ||
        s.target !== plan.target
      )
        reasons.push('the approved plan no longer matches the original strategy signal');
      if (plan.entryType === 'LIMIT' && p.entry !== plan.entry)
        reasons.push(`LIMIT price changed from ${plan.entry} to ${p.entry}`);
      if (!Number.isFinite(p.quantity) || p.quantity < plan.quantity)
        reasons.push(
          `permitted size is now ${p.quantity}, below the approved ${plan.quantity} (not enlarged or reduced silently)`,
        );
      if (reasons.length === 0)
        return { ok: true, permittedQuantity: p.quantity, entry: p.entry, checks: d.checks.length };
    }
    return { ok: false, reasons: reasons.map((r) => `[revalidation] ${r}`) };
  } catch (err) {
    return { ok: false, reasons: [`[revalidation] failed: ${errorMessage(err)}`] };
  }
}

/** Advances stored tracking from a FRESH broker snapshot (so fresh equity reaches every rule). */
export { updateAccountTracking } from '@astra/prop-firm';
