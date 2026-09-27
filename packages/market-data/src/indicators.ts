/** Indicators over real, completed bars only (decimal math, deterministic). */
import { dec, decMax, toNum, type Dec } from '@astra/core';
import type { Bar } from './bar';

export const ATR_PERIOD = 14;

/** True range: max(high − low, |high − previous close|, |low − previous close|). */
export function trueRange(bar: Pick<Bar, 'high' | 'low'>, previousClose: number): Dec {
  const h = dec(bar.high);
  const l = dec(bar.low);
  const pc = dec(previousClose);
  return decMax(h.minus(l), h.minus(pc).abs(), l.minus(pc).abs());
}

/**
 * Average True Range with Wilder smoothing: the first value is the simple mean of the first
 * `period` true ranges, then ATRₜ = (ATRₜ₋₁ × (period − 1) + TRₜ) / period. Each true range needs
 * the previous bar's close, so `period + 1` complete bars are required; with fewer the result is
 * null (never estimated). In-progress bars are ignored.
 */
export function averageTrueRange(bars: readonly Bar[], period = ATR_PERIOD): number | null {
  const complete = bars.filter((b) => b.complete);
  if (!Number.isInteger(period) || period < 1 || complete.length < period + 1) return null;
  const ranges: Dec[] = [];
  for (let i = 1; i < complete.length; i++) {
    ranges.push(trueRange(complete[i]!, complete[i - 1]!.close));
  }
  let value = ranges
    .slice(0, period)
    .reduce((sum, tr) => sum.plus(tr), dec(0))
    .div(period);
  for (let i = period; i < ranges.length; i++) {
    value = value
      .mul(period - 1)
      .plus(ranges[i]!)
      .div(period);
  }
  return toNum(value, 8);
}
