/** Decision-gate policy (system configuration). */
import { ComponentIdSchema, EventImpactSchema, PositiveNumberSchema } from '@astra/core';
import { z } from 'zod';

export const DecisionPolicySchema = z.object({
  /** An approval must be executed within this many seconds or it expires. */
  approvalTtlSeconds: z.number().int().positive().max(600),
  freshness: z.object({
    quoteMaxAgeMs: z.number().int().positive(),
    accountSnapshotMaxAgeMs: z.number().int().positive(),
    calendarMaxAgeMs: z.number().int().positive(),
    newsMaxAgeMs: z.number().int().positive(),
    aiAnalysisMaxAgeMs: z.number().int().positive(),
    maxFutureSkewMs: z.number().int().nonnegative(),
  }),
  /** Default max distance between signal entry and executable price, in ticks (instruments may override). */
  maxEntryDeviationTicks: PositiveNumberSchema,
  /** No new trades this many minutes before an instrument's scheduled market close. */
  minMinutesBeforeMarketClose: z.number().int().nonnegative(),
  /**
   * Longest a LIMIT entry may rest at the broker (its `expiresAt`), in minutes. Everything the gate
   * checked must hold for that whole window. Absent: 240.
   */
  maxWorkingOrderMinutes: z.number().int().positive().max(1440).optional(),
  /** Components that must be healthy for any approval. */
  requiredComponents: z.array(ComponentIdSchema),
  /** Whether DEGRADED (not only ONLINE) is acceptable for required components. */
  allowDegradedComponents: z.boolean(),
  /** Global default event blackout; merged with strategy and firm rules (most restrictive wins). */
  eventBlackout: z.object({
    impactLevels: z.array(EventImpactSchema).min(1),
    minutesBefore: z.number().int().nonnegative(),
    minutesAfter: z.number().int().nonnegative(),
  }),
  news: z.object({
    /** When true, a fresh news-risk assessment is mandatory for approval. */
    required: z.boolean(),
    blockLevels: z.array(z.enum(['NORMAL', 'ELEVATED', 'HIGH'])).min(1),
  }),
  ai: z.object({
    /** Minimum confidence of a mandatory AI analysis. */
    minConfidence: z.number().min(0).max(1),
  }),
});
export type DecisionPolicy = z.infer<typeof DecisionPolicySchema>;
