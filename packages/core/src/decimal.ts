/**
 * Decimal arithmetic for risk-critical math (ADR-0004). Binary floats are never used for
 * limit comparisons or quantity flooring.
 */
import Decimal from 'decimal.js';
import { AstraError } from './errors';

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Dec = Decimal;
export type DecInput = number | string | Decimal;

/** Creates a decimal, rejecting NaN/Infinity (which must never enter risk math). */
export function dec(value: DecInput): Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new AstraError('VALIDATION', `non-finite number in decimal math: ${value}`);
  }
  const d = new D(value);
  if (!d.isFinite()) throw new AstraError('VALIDATION', `non-finite decimal: ${String(value)}`);
  return d;
}

export const ZERO = dec(0);
export const ONE = dec(1);
export const HUNDRED = dec(100);

/** Floors `value` down to a multiple of `step` (never rounds up). Negative values floor toward -∞. */
export function floorToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) throw new AstraError('VALIDATION', 'step must be positive');
  return value.div(step).floor().mul(step);
}

/** Rounds `value` up to a multiple of `step`. */
export function ceilToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) throw new AstraError('VALIDATION', 'step must be positive');
  return value.div(step).ceil().mul(step);
}

export function decMin(first: Decimal, ...rest: Decimal[]): Decimal {
  return rest.reduce((m, v) => (v.lt(m) ? v : m), first);
}

export function decMax(first: Decimal, ...rest: Decimal[]): Decimal {
  return rest.reduce((m, v) => (v.gt(m) ? v : m), first);
}

/** Percentage `part / whole * 100`; returns null when `whole` is zero. */
export function pct(part: Decimal, whole: Decimal): Decimal | null {
  if (whole.isZero()) return null;
  return part.div(whole).mul(HUNDRED);
}

/** Converts to a JS number, rounded to `dp` decimal places (default 8) for JSON output. */
export function toNum(value: Decimal, dp = 8): number {
  return value.toDecimalPlaces(dp, D.ROUND_HALF_EVEN).toNumber();
}

/** Money rounding for display/reporting (2 dp). */
export function money(value: Decimal): number {
  return toNum(value, 2);
}
