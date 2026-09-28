/**
 * H1 bias from confirmed H1 swings (DEFAULT reading of the SPEC's HH→HL→HH / LL→LH→LL):
 *
 * - BULLISH: the last two swing highs rise, the lowest swing low between them is above the
 *   swing low before the first of them, and the structure has not broken since — no later swing
 *   low under that higher low, and the last H1 close is still above it.
 * - BEARISH: the mirror image.
 * - Anything else (too few swings, both or neither pattern): NEUTRAL → no trade.
 */
import type { Swing } from './series';

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface BiasAssessment {
  readonly bias: Bias;
  readonly reason: string;
  /** The swings the verdict rests on (for the decision record). */
  readonly swings: {
    readonly previous: number | null;
    readonly last: number | null;
    readonly pivot: number | null;
    readonly before: number | null;
  };
}

const t = (s: Swing) => Date.parse(s.time);

function trend(
  up: boolean,
  extremes: readonly Swing[],
  pivots: readonly Swing[],
  lastClose: number,
): { ok: boolean; reason: string; swings: BiasAssessment['swings'] } {
  const none = { previous: null, last: null, pivot: null, before: null };
  if (extremes.length < 2) return { ok: false, reason: 'fewer than two swings', swings: none };
  const last = extremes.at(-1)!;
  const previous = extremes.at(-2)!;
  const between = pivots.filter((p) => t(p) > t(previous) && t(p) < t(last));
  const beforeAll = pivots.filter((p) => t(p) < t(previous));
  if (between.length === 0 || beforeAll.length === 0)
    return { ok: false, reason: 'no swing between or before the last two', swings: none };
  // Up: the lowest low between the highs vs the low before them. Down: highest high vs high.
  const pivot = between.reduce((m, p) =>
    up ? (p.price < m.price ? p : m) : p.price > m.price ? p : m,
  );
  const before = beforeAll.at(-1)!;
  const swings = {
    previous: previous.price,
    last: last.price,
    pivot: pivot.price,
    before: before.price,
  };
  const extremesOk = up ? last.price > previous.price : last.price < previous.price;
  const pivotOk = up ? pivot.price > before.price : pivot.price < before.price;
  if (!extremesOk || !pivotOk)
    return {
      ok: false,
      reason: up ? 'no higher high and higher low' : 'no lower low and lower high',
      swings,
    };
  const broken = pivots.some(
    (p) => t(p) > t(last) && (up ? p.price < pivot.price : p.price > pivot.price),
  );
  const closedThrough = up ? lastClose < pivot.price : lastClose > pivot.price;
  if (broken || closedThrough)
    return {
      ok: false,
      reason: `structure broken through the ${up ? 'higher low' : 'lower high'}`,
      swings,
    };
  return {
    ok: true,
    reason: up ? 'higher high and higher low' : 'lower low and lower high',
    swings,
  };
}

export function assessBias(
  highs: readonly Swing[],
  lows: readonly Swing[],
  lastH1Close: number | null,
): BiasAssessment {
  if (lastH1Close === null)
    return {
      bias: 'NEUTRAL',
      reason: 'no closed H1 candle',
      swings: { previous: null, last: null, pivot: null, before: null },
    };
  const bull = trend(true, highs, lows, lastH1Close);
  const bear = trend(false, lows, highs, lastH1Close);
  if (bull.ok && bear.ok)
    return {
      bias: 'NEUTRAL',
      reason: 'bullish and bearish at once (ambiguous)',
      swings: bull.swings,
    };
  if (bull.ok) return { bias: 'BULLISH', reason: bull.reason, swings: bull.swings };
  if (bear.ok) return { bias: 'BEARISH', reason: bear.reason, swings: bear.swings };
  return {
    bias: 'NEUTRAL',
    reason: `bullish: ${bull.reason}; bearish: ${bear.reason}`,
    swings: bull.swings,
  };
}
