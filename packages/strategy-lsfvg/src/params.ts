/**
 * Parameters of the Liquidity Structure FVG strategy v1.0 (the owner's specification). Values
 * marked SPEC come from the owner's document; values marked DEFAULT are the interpretations
 * the owner accepted ("use your defaults", 2026-09-28) or ASTRA's own where the document is
 * silent. Research may vary them only as a sensitivity analysis — the frozen rules are these.
 */
import { z } from 'zod';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const LsfvgParamsSchema = z.object({
  /** A = fixed 2R target; B = nearest opposing external liquidity giving at least 2R (SPEC). */
  model: z.enum(['A', 'B']),
  /** ATR period on every timeframe (SPEC: ATR(14), Wilder). */
  atrPeriod: z.number().int().min(2).default(14),
  /** Displacement: body ≥ this share of the candle's range (SPEC 0.60). */
  displacementBodyToRange: z.number().positive().max(1).default(0.6),
  /** Displacement: body ≥ this multiple of the M15 ATR (SPEC 0.80; DEFAULT: M15 ATR). */
  displacementBodyToAtr: z.number().positive().default(0.8),
  /** Equal highs / lows: |l1 − l2| ≤ this × M15 ATR (SPEC 0.10; DEFAULT: M15 ATR). */
  equalLevelAtrFraction: z.number().positive().default(0.1),
  /** Stop beyond the sweep extreme by this × M5 ATR (SPEC 0.10; DEFAULT: M5 ATR). */
  stopAtrFraction: z.number().nonnegative().default(0.1),
  /** The close back inside may come on the sweep candle or within this many more M15 candles (DEFAULT 2). */
  reclaimCandles: z.number().int().nonnegative().default(2),
  /**
   * The displacement that breaks structure must come within this many M15 candles after the
   * sweep candle (DEFAULT 6 = 90 min; the document sets no limit).
   */
  displacementWindowCandles: z.number().int().positive().default(6),
  /** The entry order waits at most this many M5 candles for the retrace (DEFAULT 12 = 1 h). */
  entryWaitM5Candles: z.number().int().positive().default(12),
  /** Minimum reward : risk (SPEC 2). */
  minRewardToRisk: z.number().positive().default(2),
  /**
   * Model B target choice. NEAREST_WITH_MIN_RR (DEFAULT): the nearest opposing level that gives
   * at least minRewardToRisk. NEAREST_ONLY: the nearest opposing level, and no trade if it is too
   * close (the stricter reading — for sensitivity analysis).
   */
  modelBTarget: z.enum(['NEAREST_WITH_MIN_RR', 'NEAREST_ONLY']).default('NEAREST_WITH_MIN_RR'),
  /** Asian range in UTC (DEFAULT 00:00–06:00). */
  asianSession: z
    .object({ startUtc: Hhmm, endUtc: Hhmm })
    .default({ startUtc: '00:00', endUtc: '06:00' }),
  /** Trading day for the previous day's high / low (DEFAULT: ends 17:00 New York). */
  tradingDay: z
    .object({ timeZone: z.string().min(1), time: Hhmm })
    .default({ timeZone: 'America/New_York', time: '17:00' }),
  /** Unswept M15 swing levels kept as liquidity (oldest dropped first). */
  maxSwingLevels: z.number().int().positive().default(40),
});
export type LsfvgParams = z.infer<typeof LsfvgParamsSchema>;
export type LsfvgParamsInput = z.input<typeof LsfvgParamsSchema>;

/** Score components (SPEC §: H1 +2, strong PD/session liquidity +2, sweep +3, …; max 18). */
export const SCORE = {
  h1Bias: 2,
  strongLiquidity: 2,
  sweep: 3,
  structure: 3,
  displacement: 2,
  fvg: 2,
  retrace: 2,
  rewardToRisk: 2,
} as const;
export const MAX_SCORE = Object.values(SCORE).reduce((a, b) => a + b, 0);
