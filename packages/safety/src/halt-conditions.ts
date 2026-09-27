/**
 * Automatic halt conditions (spec §25). Pure evaluation: given an account's computed state and
 * health, return the kill-switch activations that should exist. The in-core halt monitor applies
 * them idempotently. Per-decision data problems (stale quotes, missing calendar) are handled by
 * the decision gate itself and do not need persistent switches.
 */
import type { KillSwitchScope, KillSwitchState } from './kill-switch';

export interface HaltAction {
  readonly scope: KillSwitchScope;
  readonly target: string | null;
  readonly reason: string;
  readonly clearPolicy: KillSwitchState['clearPolicy'];
  readonly autoClearAt: string | null;
}

export interface AccountHaltInput {
  readonly accountId: string;
  readonly breached: boolean;
  readonly dayLocked: boolean;
  /** Start of the next trading day (ISO), used to auto-clear daily locks. */
  readonly nextTradingDayStart: string;
  /** Positions without protective stops (always a halt condition: risk is unknown). */
  readonly unprotectedPositions: readonly string[];
}

/**
 * Returns at most one ACCOUNT action (kill switches are keyed by scope+target). Reasons are
 * combined; MANUAL clearing wins over NEXT_TRADING_DAY because it is stricter.
 */
export function evaluateAccountHaltConditions(input: AccountHaltInput): HaltAction[] {
  const manual: string[] = [];
  const daily: string[] = [];
  if (input.breached) manual.push('hard prop-firm limit breached');
  else if (input.dayLocked) daily.push('daily loss limit reached');
  if (input.unprotectedPositions.length > 0) {
    manual.push(
      `open position(s) without protective stop: ${input.unprotectedPositions.join(', ')}`,
    );
  }
  if (manual.length === 0 && daily.length === 0) return [];
  const isManual = manual.length > 0;
  return [
    {
      scope: 'ACCOUNT',
      target: input.accountId,
      reason: [...manual, ...daily].join('; '),
      clearPolicy: isManual ? 'MANUAL' : 'NEXT_TRADING_DAY',
      autoClearAt: isManual ? null : input.nextTradingDayStart,
    },
  ];
}
