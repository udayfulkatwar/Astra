/** Market DATA types. */
import { z } from 'zod';
import { IsoDateTimeSchema, PositiveNumberSchema, SymbolSchema } from '../schemas';

export const QuoteSchema = z
  .object({
    symbol: SymbolSchema,
    bid: PositiveNumberSchema,
    ask: PositiveNumberSchema,
    last: PositiveNumberSchema.optional(),
    /** Source timestamp (UTC). */
    asOf: IsoDateTimeSchema,
  })
  .refine((q) => q.ask >= q.bid, { message: 'ask must be ≥ bid (crossed quote)', path: ['ask'] });
export type Quote = z.infer<typeof QuoteSchema>;
