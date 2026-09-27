import type { Derivations } from '../derive';
import type { CheckVerdict, DecisionInputs, GateLayer } from '../types';

export interface CheckOutcome {
  readonly verdict: CheckVerdict;
  readonly reasons: readonly string[];
  readonly details?: Record<string, unknown>;
}

/** A gate check is a pure function over the frozen inputs and derivations. */
export interface GateCheck {
  readonly id: string;
  readonly layer: GateLayer;
  readonly mandatory: boolean;
  readonly description: string;
  evaluate(inputs: DecisionInputs, derived: Derivations): CheckOutcome;
}

const withDetails = (details?: Record<string, unknown>) => (details ? { details } : {});

export const pass = (reason: string, details?: Record<string, unknown>): CheckOutcome => ({
  verdict: 'PASS',
  reasons: [reason],
  ...withDetails(details),
});

export const fail = (
  reasons: string | readonly string[],
  details?: Record<string, unknown>,
): CheckOutcome => ({
  verdict: 'FAIL',
  reasons: typeof reasons === 'string' ? [reasons] : reasons,
  ...withDetails(details),
});

export const unknown = (reason: string, details?: Record<string, unknown>): CheckOutcome => ({
  verdict: 'UNKNOWN',
  reasons: [reason],
  ...withDetails(details),
});

/** Maps a PASS/FAIL/UNKNOWN sub-verdict list to one outcome: any FAIL → FAIL, else any UNKNOWN → UNKNOWN. */
export function combine(
  items: readonly { verdict: 'PASS' | 'FAIL' | 'UNKNOWN'; message: string }[],
  passMessage: string,
  details?: Record<string, unknown>,
): CheckOutcome {
  const failed = items.filter((i) => i.verdict === 'FAIL').map((i) => i.message);
  const unknowns = items.filter((i) => i.verdict === 'UNKNOWN').map((i) => i.message);
  if (failed.length > 0) return fail([...failed, ...unknowns], details);
  if (unknowns.length > 0)
    return { verdict: 'UNKNOWN', reasons: unknowns, ...withDetails(details) };
  return pass(passMessage, details);
}
