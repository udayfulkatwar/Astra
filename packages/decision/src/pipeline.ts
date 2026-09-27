/**
 * Gate pipeline (ADR-0003). Runs every check (no short-circuit, so all reasons are reported),
 * isolates exceptions as ERROR, and refuses to be configured without a check for every
 * required layer.
 */
import { AstraError, errorMessage } from '@astra/core';
import type { GateCheck } from './checks/check';
import type { Derivations } from './derive';
import { GATE_LAYERS, type DecisionInputs, type GateCheckResult, type GateLayer } from './types';

export class GatePipeline {
  readonly checks: readonly GateCheck[];
  readonly requiredLayers: readonly GateLayer[];

  constructor(checks: readonly GateCheck[], requiredLayers: readonly GateLayer[] = GATE_LAYERS) {
    const ids = new Set<string>();
    for (const c of checks) {
      if (ids.has(c.id)) throw new AstraError('CONFIG_INVALID', `duplicate gate check id ${c.id}`);
      ids.add(c.id);
    }
    this.checks = checks;
    this.requiredLayers = requiredLayers;
  }

  /** Required layers that have no mandatory check registered. */
  missingLayers(): GateLayer[] {
    const covered = new Set(this.checks.filter((c) => c.mandatory).map((c) => c.layer));
    return this.requiredLayers.filter((l) => !covered.has(l));
  }

  run(inputs: DecisionInputs, derived: Derivations): GateCheckResult[] {
    const results: GateCheckResult[] = this.checks.map((check) => {
      try {
        const outcome = check.evaluate(inputs, derived);
        return {
          checkId: check.id,
          layer: check.layer,
          mandatory: check.mandatory,
          verdict: outcome.verdict,
          reasons: outcome.reasons,
          ...(outcome.details ? { details: outcome.details } : {}),
        };
      } catch (err) {
        return {
          checkId: check.id,
          layer: check.layer,
          mandatory: check.mandatory,
          verdict: 'ERROR',
          reasons: [`check ${check.id} threw: ${errorMessage(err)}`],
        };
      }
    });
    for (const layer of this.missingLayers()) {
      results.push({
        checkId: 'pipeline.required-layer',
        layer,
        mandatory: true,
        verdict: 'FAIL',
        reasons: [`pipeline misconfigured: no mandatory check for required layer ${layer}`],
      });
    }
    return results;
  }
}
