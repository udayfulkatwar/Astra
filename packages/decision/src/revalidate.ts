/**
 * Pre-submit revalidation (ADR-0027). The approved plan is never trusted on its own age: just
 * before an entry is reserved, the ORIGINAL candidate is run through the same assembler and the
 * same Decision Engine (every mandatory check, risk and prop-firm rule) on freshly gathered
 * inputs. It can only confirm or refuse — a plan is never enlarged or mutated here, and any
 * failure to revalidate is a refusal.
 */
import {
  applyFreshness,
  errorMessage,
  tradingDayWindow,
  type CalendarWindow,
  type NewsRiskAssessment,
  type Observed,
  type Quote,
  type TradeCandidate,
} from '@astra/core';
import { assembleWithProvenance, type AssembleOptions, type AssemblyProvenance } from './assembler';
import type { DecisionEngine } from './engine';
import type { ApprovedOrderPlan, DecisionInputs, TradeDecision } from './types';

/**
 * The last check before an entry is transmitted. SYNCHRONOUS on purpose: the gateway calls it with
 * no await between it and the adapter call, after every durable wait. It re-judges the captured
 * evidence (never re-stamping it as newly observed) at the CURRENT clock and state.
 */
export type FinalGuardVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };
export type FinalGuard = () => FinalGuardVerdict;

export type EntryRevalidation =
  | {
      readonly ok: true;
      /** What the deterministic gate would permit now. Never below the approved quantity here. */
      readonly permittedQuantity: number;
      readonly entry: number;
      readonly checks: number;
      /** REQUIRED: a verdict without it is never transmitted (see the execution gateway). */
      readonly finalGuard: FinalGuard;
    }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * The CURRENT state of the providers whose observations were captured (synchronous reads). A
 * provider that is now ERROR/UNAVAILABLE/INVALID/STALE revokes the captured evidence even if its
 * timestamp is still fresh. The stored AI analysis has no provider to re-read: its age is judged
 * by the engine at the final clock.
 */
export interface CurrentEvidencePorts {
  quote(symbol: string): Observed<Quote>;
  calendar(): Observed<CalendarWindow>;
  newsRisk(symbol: string): Observed<NewsRiskAssessment>;
}

/** Why a freshly evaluated decision does not reproduce the approved plan (empty = it does). */
function planMismatches(
  d: TradeDecision,
  candidate: TradeCandidate,
  plan: ApprovedOrderPlan,
): string[] {
  const reasons: string[] = [];
  if (d.status !== 'APPROVED' || !d.orderPlan) return [...d.reasons];
  const p = d.orderPlan;
  const s = candidate.signal;
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
  return reasons;
}

export async function revalidateApprovedEntry(opts: {
  readonly engine: DecisionEngine;
  /** Everything except the candidate: fresh data ports, current state, config and clock. */
  readonly assemble: Omit<AssembleOptions, 'candidate' | 'decisionId'>;
  /** Current provider state for the final guard (synchronous). */
  readonly current: CurrentEvidencePorts;
  readonly candidate: TradeCandidate;
  readonly plan: ApprovedOrderPlan;
  /** configHash of the original decision: configuration must not have changed since. */
  readonly originalConfigHash: string;
}): Promise<EntryRevalidation> {
  const { plan } = opts;
  try {
    const { inputs, provenance } = await assembleWithProvenance({
      ...opts.assemble,
      candidate: opts.candidate,
      decisionId: 'revalidation',
    });
    const reasons: string[] = [];
    if (inputs.configHash !== opts.originalConfigHash)
      reasons.push('configuration changed since the decision (strategy/risk/firm rules differ)');
    const d = opts.engine.evaluate(inputs);
    reasons.push(...planMismatches(d, opts.candidate, plan));
    if (reasons.length === 0 && d.orderPlan)
      return {
        ok: true,
        permittedQuantity: d.orderPlan.quantity,
        entry: d.orderPlan.entry,
        checks: d.checks.length,
        finalGuard: createFinalGuard({ ...opts, inputs, provenance }),
      };
    return { ok: false, reasons: reasons.map((r) => `[revalidation] ${r}`) };
  } catch (err) {
    return { ok: false, reasons: [`[revalidation] failed: ${errorMessage(err)}`] };
  }
}

function createFinalGuard(o: {
  readonly engine: DecisionEngine;
  readonly assemble: Omit<AssembleOptions, 'candidate' | 'decisionId'>;
  readonly current: CurrentEvidencePorts;
  readonly candidate: TradeCandidate;
  readonly plan: ApprovedOrderPlan;
  readonly originalConfigHash: string;
  readonly inputs: DecisionInputs;
  readonly provenance: AssemblyProvenance;
}): FinalGuard {
  const { inputs, provenance, candidate, plan } = o;
  const { config, state, clock } = o.assemble;
  const fresh = inputs.policy.freshness;
  const decidedAtMs = Date.parse(inputs.now);
  const refuse = (...reasons: string[]): FinalGuardVerdict => ({
    ok: false,
    reasons: reasons.map((r) => `[final-guard] ${r}`),
  });
  return () => {
    try {
      const now = clock.now();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs) || !Number.isFinite(decidedAtMs))
        return refuse('the clock or the decision time is invalid');
      if (nowMs < decidedAtMs)
        return refuse('the clock moved backwards since the inputs were assembled');
      if (config.configHash !== o.originalConfigHash)
        return refuse('configuration changed since the decision');

      // Trading day: the captured tracking belongs to its own day. A day boundary crossed during
      // the wait makes yesterday's reference wrong for today's rules: reassemble, never reuse.
      if (!inputs.profile || inputs.tracking.status !== 'OK')
        return refuse('profile or account tracking unavailable');
      const day = tradingDayWindow(now, inputs.profile.tradingDayReset).key;
      if (day !== inputs.tracking.value.tradingDayKey)
        return refuse(
          `the trading day is now ${day} but the captured tracking is for ${inputs.tracking.value.tradingDayKey}; re-evaluate`,
        );

      // Captured account-derived observations age like the account snapshot (conservative reuse
      // of the existing limit; no new policy). The snapshot itself is aged by the engine below.
      const accountAge = {
        maxAgeMs: fresh.accountSnapshotMaxAgeMs,
        maxFutureSkewMs: fresh.maxFutureSkewMs,
      };
      const accountObs: [string, Observed<unknown>][] = [
        ['account tracking', inputs.tracking],
        ['account activity', inputs.activity],
        ['duplicate check', inputs.duplicates],
      ];
      for (const [label, obs] of accountObs) {
        const v = applyFreshness(obs, now, accountAge);
        if (v.status !== 'OK') return refuse(`${label} is no longer valid (${v.status})`);
      }

      // FX: every consulted rate, with its OWN timestamp, at the final clock and provider state.
      // The money math used the captured rate, so a current rate that differs is a known
      // contradiction (the spec values would have to be re-derived): refuse, never ignore it.
      const quoteAge = { maxAgeMs: fresh.quoteMaxAgeMs, maxFutureSkewMs: fresh.maxFutureSkewMs };
      for (const dep of provenance.fx) {
        if (dep.observed.status !== 'OK') continue; // already a conversion error in the inputs
        const v = applyFreshness(dep.observed, now, quoteAge);
        if (v.status !== 'OK')
          return refuse(`FX quote ${dep.pair} is no longer valid (${v.status})`);
        const cur = o.current.quote(dep.pair);
        if (cur.status !== 'OK')
          return refuse(`FX provider for ${dep.pair} is now ${cur.status}: ${cur.reason}`);
        if (cur.value.bid !== dep.observed.value.bid || cur.value.ask !== dep.observed.value.ask)
          return refuse(`FX quote ${dep.pair} changed since the valuation; re-evaluate`);
      }

      // Known CURRENT facts replace the captured ones, each keeping its own provenance (asOf and
      // source are never re-stamped): a revised calendar, a changed news risk or a moved quote
      // is evaluated by the real engine, so a contradicting veto is seen. A provider that is no
      // longer OK voids the captured evidence even while its timestamp is fresh.
      const symbol = candidate.signal.symbol;
      const replaced: Partial<Pick<DecisionInputs, 'quote' | 'calendar' | 'newsRisk'>> = {};
      const providers: [string, Observed<unknown>, () => Observed<unknown>, string][] = [
        ['quote', inputs.quote, () => o.current.quote(symbol), 'quote'],
        ['calendar', inputs.calendar, () => o.current.calendar(), 'calendar'],
        ['news', inputs.newsRisk, () => o.current.newsRisk(symbol), 'newsRisk'],
      ];
      for (const [label, captured, read, key] of providers) {
        if (captured.status !== 'OK') continue; // not requested / non-OK: the engine decides
        const cur = read();
        if (cur.status !== 'OK')
          return refuse(`${label} provider is now ${cur.status}: ${cur.reason}`);
        (replaced as Record<string, unknown>)[key] = cur;
      }

      // The real Decision Engine, current clock and current synchronous state and evidence.
      const d = o.engine.evaluate({
        ...inputs,
        ...replaced,
        decisionId: 'final-guard',
        now: now.toISOString(),
        mode: state.mode(),
        killSwitches: state.killSwitches({
          accountId: candidate.accountId,
          strategyId: candidate.signal.strategyId,
          symbol,
          requiresAi: inputs.strategy?.requiresAiAnalysis ?? false,
        }),
        componentHealth: state.componentHealth(),
        execution: state.execution(inputs.account),
        liveTradingEnvironmentAuthorized: state.liveTradingEnvironmentAuthorized(),
      });
      const mismatches = planMismatches(d, candidate, plan);
      return mismatches.length > 0 ? refuse(...mismatches) : { ok: true };
    } catch (err) {
      return refuse(`failed: ${errorMessage(err)}`);
    }
  };
}

/** Advances stored tracking from a FRESH broker snapshot (so fresh equity reaches every rule). */
export { updateAccountTracking } from '@astra/prop-firm';
