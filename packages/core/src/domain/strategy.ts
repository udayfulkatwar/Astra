/**
 * Strategy definitions. Strategies are configurable modules (spec §13, §25). ASTRA never invents
 * the owner's rules: TEMPLATE strategies are placeholders and cannot be ACTIVE in LIVE mode.
 */
import { z } from 'zod';
import { PercentSchema, PositiveNumberSchema, SlugSchema, SymbolSchema } from '../schemas';
import { EventImpactSchema } from './calendar';

export const STRATEGY_STATUSES = ['ACTIVE', 'DISABLED', 'DRAFT'] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export const StrategyDefinitionSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  version: z.number().int().positive(),
  /** USER = the owner's actual strategy; TEMPLATE = placeholder awaiting the owner's rules. */
  ownership: z.enum(['USER', 'TEMPLATE']),
  status: z.enum(STRATEGY_STATUSES),
  description: z.string().default(''),
  instruments: z.array(SymbolSchema).min(1),
  timeframes: z.array(z.string().min(1)).default([]),
  direction: z.enum(['LONG_ONLY', 'SHORT_ONLY', 'BOTH']),
  minRewardToRisk: PositiveNumberSchema,
  /** Optional strategy cap on risk per trade (% of equity); the smaller of policy and strategy wins. */
  maxRiskPercentPerTrade: PercentSchema.optional(),
  maxTradesPerDay: z.number().int().positive().optional(),
  /** A signal older than this is expired and cannot be approved. */
  signalTtlSeconds: z.number().int().positive(),
  /** When true, a valid, non-conflicting AI analysis is mandatory for approval. */
  requiresAiAnalysis: z.boolean(),
  /** Strategy-specific event blackout; merged with global and prop-firm rules (most restrictive wins). */
  eventBlackout: z
    .object({
      impactLevels: z.array(EventImpactSchema).min(1),
      minutesBefore: z.number().int().nonnegative(),
      minutesAfter: z.number().int().nonnegative(),
    })
    .optional(),
  /**
   * Entry / confirmation / stop / target / management rules (Phase 5). Free-form until the
   * strategy engine defines typed rule schemas; never interpreted by the safety core.
   */
  rules: z.record(z.string(), z.unknown()).default({}),
  /**
   * The strategy's own risk limits (owner rules), enforced by the gate's `strategy.limits`
   * check on top of the account's risk policy. Every limit is optional.
   */
  limits: z
    .object({
      /** Entries per symbol per trading day (working orders count). */
      maxEntriesPerSymbolPerDay: z.number().int().positive().optional(),
      /** Stop new trades for the day once the realized loss today reaches this % of the day-start balance. */
      dailyRealizedLossStopPercent: PercentSchema.optional(),
      /** Stop new trades for the day after this many consecutive full-risk losses today. */
      fullRiskLosses: z
        .object({
          /** A closed trade at or below this net R is a full-risk loss (e.g. −0.9). */
          atOrBelowR: z.number().max(0),
          maxConsecutive: z.number().int().positive(),
        })
        .optional(),
      /** Correlated groups (e.g. USD pairs): caps on simultaneous positions and their open risk. */
      correlation: z
        .array(
          z.object({
            id: SlugSchema,
            symbols: z.array(SymbolSchema).min(2),
            maxOpenPositions: z.number().int().positive(),
            maxOpenRiskPercent: PercentSchema,
          }),
        )
        .optional(),
    })
    .optional(),
  /** Session ids (config astra.yaml `sessions`) in which the strategy may trade. Empty = any. */
  sessions: z.array(SlugSchema).optional(),
});
export type StrategyDefinition = z.infer<typeof StrategyDefinitionSchema>;
