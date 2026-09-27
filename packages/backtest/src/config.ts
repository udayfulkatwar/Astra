/**
 * Backtest run settings. Execution assumptions are explicit parameters, reported with every
 * result: they are modelling choices, not facts about the market.
 */
import { SlugSchema, SymbolSchema } from '@astra/core';
import { TimeframeSchema } from '@astra/market-data';
import { z } from 'zod';

export const BacktestConfigSchema = z
  .object({
    symbol: SymbolSchema,
    /** Configured account whose prop-firm profile and risk policy apply. */
    accountId: SlugSchema,
    strategy: z
      .object({
        id: z.literal('structure-breakout-template').default('structure-breakout-template'),
        /** Timeframe the strategy reads (bars are resampled from M1). */
        timeframe: TimeframeSchema.exclude(['M1']).default('M15'),
        rewardToRisk: z.number().min(0.5).max(10).default(2),
        /** Minimum stop distance in ticks (tiny stops are skipped). */
        minStopTicks: z.number().int().min(1).default(8),
      })
      .strict()
      .default({
        id: 'structure-breakout-template',
        timeframe: 'M15',
        rewardToRisk: 2,
        minStopTicks: 8,
      }),
    /** Bid/ask spread assumed around the bar prices (quote-built bars are mids). */
    spreadTicks: z.number().nonnegative().default(1),
    /** Adverse slippage on market entries, protective closes and stop exits. */
    slippageTicks: z.number().nonnegative().default(1),
    /**
     * SIMULATED_SCHEDULE: the labelled simulated calendar. NOT_MODELLED: no calendar data — the
     * blackout is not applied and the result says so. There is no silent default.
     */
    calendar: z.enum(['SIMULATED_SCHEDULE', 'NOT_MODELLED']),
  })
  .strict();
export type BacktestConfig = z.infer<typeof BacktestConfigSchema>;
export type BacktestConfigInput = z.input<typeof BacktestConfigSchema>;
