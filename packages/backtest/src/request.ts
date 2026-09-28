/** A backtest run request (API and demo): the run settings plus the date range and data source. */
import { IsoDateTimeSchema, PositiveNumberSchema } from '@astra/core';
import { z } from 'zod';
import { BacktestConfigSchema } from './config';

export const MAX_BACKTEST_DAYS = 184;

export const BacktestRequestSchema = BacktestConfigSchema.extend({
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  data: z.discriminatedUnion('kind', [
    /** Bars recorded by ASTRA, optionally from one source. */
    z.object({ kind: z.literal('STORED'), source: z.string().min(1).max(100).optional() }).strict(),
    /** Seeded SIMULATED bars (engine test); starts at `startPrice` or the current quote. */
    z
      .object({
        kind: z.literal('SIMULATED'),
        seed: z.number().int().min(0).max(2_147_483_647),
        startPrice: PositiveNumberSchema.optional(),
      })
      .strict(),
  ]),
})
  .strict()
  .refine((r) => Date.parse(r.to) > Date.parse(r.from), { message: 'to must be after from' })
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= MAX_BACKTEST_DAYS * 86_400_000, {
    message: `at most ${MAX_BACKTEST_DAYS} days per run`,
  });
export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;
export type BacktestRequestInput = z.input<typeof BacktestRequestSchema>;

/** The run settings part of a request. */
export function backtestConfigOf(req: BacktestRequest) {
  return {
    symbol: req.symbol,
    accountId: req.accountId,
    strategy: req.strategy,
    spreadTicks: req.spreadTicks,
    slippageTicks: req.slippageTicks,
    calendar: req.calendar,
    news: req.news,
  };
}
