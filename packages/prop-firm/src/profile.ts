/**
 * Prop-firm rule profile schema (spec §8, §13). Profiles are DATA loaded from configuration —
 * the engine contains no firm-specific rules. Every rule family is explicit: a firm without a
 * daily loss limit states `dailyLoss: null` rather than omitting it, so an omission can never be
 * mistaken for "no limit".
 */
import {
  CurrencySchema,
  EventImpactSchema,
  FiniteNumberSchema,
  LocalTimeInZoneSchema,
  PercentSchema,
  PositiveNumberSchema,
  SlugSchema,
  SymbolSchema,
  VerificationSchema,
  WeeklyTimeSchema,
} from '@astra/core';
import { z } from 'zod';

const AmountLimitSchema = z.object({ kind: z.literal('AMOUNT'), value: PositiveNumberSchema });
const PercentOfInitialSchema = z.object({
  kind: z.literal('PERCENT_OF_INITIAL'),
  value: PercentSchema,
});
const PercentOfDayStartSchema = z.object({
  kind: z.literal('PERCENT_OF_DAY_START'),
  value: PercentSchema,
});

export const InitialBasedLimitSchema = z.discriminatedUnion('kind', [
  AmountLimitSchema,
  PercentOfInitialSchema,
]);
export type InitialBasedLimit = z.infer<typeof InitialBasedLimitSchema>;

export const DailyLossRuleSchema = z.object({
  limit: z.discriminatedUnion('kind', [
    AmountLimitSchema,
    PercentOfInitialSchema,
    PercentOfDayStartSchema,
  ]),
  /** Value the daily loss is measured from at the start of the trading day. */
  reference: z.enum([
    'DAY_START_BALANCE',
    'DAY_START_EQUITY',
    'DAY_START_HIGHER_OF_BALANCE_EQUITY',
  ]),
  /** EQUITY includes floating P&L; BALANCE counts realized P&L only. */
  measure: z.enum(['EQUITY', 'BALANCE']),
  /** ACCOUNT_FAILED = hard breach; DAY_LOCKED = trading locked until next reset. */
  breachConsequence: z.enum(['ACCOUNT_FAILED', 'DAY_LOCKED']),
});
export type DailyLossRule = z.infer<typeof DailyLossRuleSchema>;

export const DRAWDOWN_TYPES = [
  'STATIC',
  'TRAILING_INTRADAY_EQUITY',
  'TRAILING_BALANCE',
  'TRAILING_END_OF_DAY',
] as const;
export type DrawdownType = (typeof DRAWDOWN_TYPES)[number];

export const TrailingStopSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NEVER') }),
  z.object({ kind: z.literal('INITIAL_BALANCE') }),
  z.object({ kind: z.literal('INITIAL_BALANCE_PLUS'), amount: PositiveNumberSchema }),
]);

export const MaxDrawdownRuleSchema = z
  .object({
    /**
     * STATIC: threshold = initial − limit.
     * TRAILING_INTRADAY_EQUITY: trails the highest equity (incl. unrealized) ever reached.
     * TRAILING_BALANCE: trails the highest realized balance.
     * TRAILING_END_OF_DAY: trails the highest end-of-day balance.
     */
    type: z.enum(DRAWDOWN_TYPES),
    limit: InitialBasedLimitSchema,
    /** Value compared against the threshold. */
    measure: z.enum(['EQUITY', 'BALANCE']),
    /** Level at which a trailing threshold stops moving up. */
    trailingStopsAt: TrailingStopSchema,
  })
  .refine((r) => r.type !== 'STATIC' || r.trailingStopsAt.kind === 'NEVER', {
    message: 'a STATIC drawdown cannot have a trailing stop level',
    path: ['trailingStopsAt'],
  });
export type MaxDrawdownRule = z.infer<typeof MaxDrawdownRuleSchema>;

export const PositionLimitsSchema = z.object({
  /** Max total weighted quantity across CONTRACTS instruments. */
  maxContracts: PositiveNumberSchema.nullable(),
  /** Max total weighted quantity across LOTS instruments. */
  maxLots: PositiveNumberSchema.nullable(),
  /** Weight per symbol when counting toward maxContracts/maxLots (e.g. micro = 0.1). Default 1. */
  quantityWeights: z.record(SymbolSchema, PositiveNumberSchema).default({}),
  maxOpenPositions: z.number().int().positive().nullable(),
  perInstrumentMaxQuantity: z.record(SymbolSchema, PositiveNumberSchema).default({}),
  /** Max total notional / equity. */
  maxLeverage: PositiveNumberSchema.nullable(),
});
export type PositionLimits = z.infer<typeof PositionLimitsSchema>;

export const ScalingPlanSchema = z.object({
  /** Tier applies when (balance − initial) ≥ minProfit; highest applicable tier wins. */
  tiers: z
    .array(z.object({ minProfit: FiniteNumberSchema, maxWeightedQuantity: PositiveNumberSchema }))
    .min(1),
});
export type ScalingPlan = z.infer<typeof ScalingPlanSchema>;

export const ConsistencyRuleSchema = z.object({
  /** Maximum share of total profit that may come from a single day. */
  maxDayProfitSharePct: PercentSchema,
  /** BLOCK_NEW_TRADES stops trading for the day once today's share reaches the limit. */
  enforcement: z.enum(['BLOCK_NEW_TRADES', 'MONITOR']),
});
export type ConsistencyRule = z.infer<typeof ConsistencyRuleSchema>;

export const NewsRestrictionSchema = z.object({
  impactLevels: z.array(EventImpactSchema).min(1),
  minutesBefore: z.number().int().nonnegative(),
  minutesAfter: z.number().int().nonnegative(),
});
export type NewsRestriction = z.infer<typeof NewsRestrictionSchema>;

export const HoldingRulesSchema = z
  .object({
    overnight: z.enum(['ALLOWED', 'PROHIBITED']),
    weekend: z.enum(['ALLOWED', 'PROHIBITED']),
    /** Positions must be flat by this local time every trading day. */
    flatBy: LocalTimeInZoneSchema.nullable(),
    /** Weekly market close used for the weekend rule. */
    weeklyClose: WeeklyTimeSchema.nullable(),
  })
  .refine((h) => h.overnight === 'ALLOWED' || h.flatBy !== null, {
    message: 'overnight PROHIBITED requires a flatBy time',
    path: ['flatBy'],
  })
  .refine((h) => h.weekend === 'ALLOWED' || h.weeklyClose !== null || h.flatBy !== null, {
    message: 'weekend PROHIBITED requires weeklyClose or flatBy',
    path: ['weeklyClose'],
  });
export type HoldingRules = z.infer<typeof HoldingRulesSchema>;

export const TradingRulesSchema = z.object({
  stopLossRequired: z.boolean(),
  maxRiskPerTrade: InitialBasedLimitSchema.nullable(),
  hedgingAllowed: z.boolean(),
});

export const ObjectivesSchema = z.object({
  profitTarget: InitialBasedLimitSchema.nullable(),
  minTradingDays: z.number().int().nonnegative().nullable(),
});

export const PayoutRulesSchema = z.object({
  minTradingDays: z.number().int().nonnegative().nullable(),
  minProfit: PositiveNumberSchema.nullable(),
  maxPayoutAmount: PositiveNumberSchema.nullable(),
  profitSplitPct: PercentSchema.nullable(),
  notes: z.string().optional(),
});

export const PROFILE_PHASES = ['EVALUATION', 'VERIFICATION', 'FUNDED', 'OTHER'] as const;

export const PropFirmRuleProfileSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  firm: z.string().min(1),
  program: z.string().min(1),
  phase: z.enum(PROFILE_PHASES),
  version: z.number().int().positive(),
  currency: CurrencySchema,
  accountSize: PositiveNumberSchema,
  verification: VerificationSchema,
  /** When the firm's trading day rolls over (daily loss, trading days, day P&L all use it). */
  tradingDayReset: LocalTimeInZoneSchema,
  dailyLoss: DailyLossRuleSchema.nullable(),
  maxDrawdown: MaxDrawdownRuleSchema,
  positionLimits: PositionLimitsSchema,
  scaling: ScalingPlanSchema.nullable(),
  consistency: ConsistencyRuleSchema.nullable(),
  news: NewsRestrictionSchema.nullable(),
  holding: HoldingRulesSchema,
  trading: TradingRulesSchema,
  objectives: ObjectivesSchema,
  payout: PayoutRulesSchema.nullable(),
  notes: z.string().optional(),
});
export type PropFirmRuleProfile = z.infer<typeof PropFirmRuleProfileSchema>;
