/**
 * Detection parameters. These are ASTRA's generic, documented definitions (ADR-0010) — DEFAULTS
 * to review against the owner's strategy in Phase 5, not trading rules.
 */
import { z } from 'zod';

export const StructureParamsSchema = z
  .object({
    /**
     * Bars on each side of a swing (fractal strength). A swing high's high is above the highs of
     * the `swingStrength` bars before it and not below those after it; it is known only once
     * those later bars have closed.
     */
    swingStrength: z.number().int().min(1).max(10).default(2),
    /** Highs (lows) within this many ticks count as equal — resting liquidity. */
    equalLevelTicks: z.number().nonnegative().default(2),
    /** …widened to this fraction of ATR(14) once ATR is known (the larger tolerance wins). */
    equalLevelAtrFraction: z.number().min(0).max(1).default(0.1),
    /** Smallest fair value gap reported, in ticks. */
    fvgMinTicks: z.number().positive().default(1),
    /** How many of the most recent swings, breaks, sweeps and gaps are returned. */
    maxItems: z.number().int().min(1).max(200).default(20),
  })
  .strict();

export type StructureParams = z.infer<typeof StructureParamsSchema>;

export const DEFAULT_STRUCTURE_PARAMS: StructureParams = StructureParamsSchema.parse({});
