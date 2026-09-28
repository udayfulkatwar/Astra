/**
 * Internal risk policy: the owner's self-imposed limits, stricter than the prop firm's hard
 * limits. Policies are configuration; templates are marked ownership TEMPLATE.
 */
import {
  NonNegativeNumberSchema,
  PercentSchema,
  PositiveNumberSchema,
  SlugSchema,
} from '@astra/core';
import { z } from 'zod';

export const RiskPolicySchema = z
  .object({
    id: SlugSchema,
    name: z.string().min(1),
    version: z.number().int().positive(),
    /** USER = reviewed by the owner; TEMPLATE = example values awaiting review. */
    ownership: z.enum(['USER', 'TEMPLATE']),
    perTrade: z.object({
      /** Risk per trade as % of min(balance, equity). */
      riskPercentOfEquity: PercentSchema,
      maxRiskAmount: PositiveNumberSchema.nullable(),
      minRewardToRisk: PositiveNumberSchema,
    }),
    buffers: z.object({
      /** Max share of the remaining worst-case daily-loss buffer a single trade may use. */
      maxDailyBufferUsePct: PercentSchema,
      /** Max share of the remaining worst-case drawdown buffer a single trade may use. */
      maxDrawdownBufferUsePct: PercentSchema,
      /** After a worst-case loss the account must stay at least this far from every hard limit. */
      survivalBufferAmount: NonNegativeNumberSchema,
    }),
    exposure: z.object({
      maxOpenRiskPercentOfEquity: PercentSchema,
      maxOpenPositions: z.number().int().positive(),
      maxPositionsPerInstrument: z.number().int().positive(),
      allowPyramiding: z.boolean(),
    }),
    activity: z.object({
      maxTradesPerDay: z.number().int().positive(),
      /**
       * Losses in a row within the current trading day; the count starts fresh at each
       * trading-day reset (owner decision 2026-09-28).
       */
      maxConsecutiveLosses: z.number().int().positive(),
    }),
    health: z.object({
      /** Hard-limit usage (%) at which the account enters CAUTION (reduced size). */
      cautionUsagePct: PercentSchema,
      /** Usage (%) at which new trades stop (RESTRICTED). */
      restrictedUsagePct: PercentSchema,
      /** Worst-case usage (%) at which the account is BREACH_RISK. */
      breachRiskUsagePct: PercentSchema,
      /** Position-size multiplier while in CAUTION, in (0, 1]. */
      cautionSizeMultiplier: z.number().gt(0).lte(1),
    }),
    timing: z.object({
      /** No new trades this many minutes before a mandatory flat time / weekly close. */
      noNewTradesMinutesBeforeFlat: z.number().int().nonnegative(),
    }),
    targets: z.object({
      stopTradingWhenProfitTargetReached: z.boolean(),
    }),
  })
  .refine(
    (p) =>
      p.health.cautionUsagePct < p.health.restrictedUsagePct &&
      p.health.restrictedUsagePct <= p.health.breachRiskUsagePct,
    {
      message: 'health thresholds must satisfy caution < restricted ≤ breachRisk',
      path: ['health'],
    },
  );
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;
