/** OHLC bars built from observed quotes, and the persistence port that stores them. */
import {
  DataSourceKindSchema,
  IsoDateTimeSchema,
  NonNegativeNumberSchema,
  PositiveNumberSchema,
  SymbolSchema,
  type DataSourceKind,
} from '@astra/core';
import { z } from 'zod';
import { TimeframeSchema, type Timeframe } from './timeframe';

export interface Bar {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Period start, ISO UTC (inclusive). */
  readonly openTime: string;
  /** Period end, ISO UTC (exclusive). */
  readonly closeTime: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Traded volume when the source reports it; quote-built bars have none (null, never 0). */
  readonly volume: number | null;
  /** Number of quotes aggregated into the bar (0 when a provider bar does not say). */
  readonly tickCount: number;
  /** False only for the bar still in progress. */
  readonly complete: boolean;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
}

export const BarSchema: z.ZodType<Bar> = z
  .object({
    symbol: SymbolSchema,
    timeframe: TimeframeSchema,
    openTime: IsoDateTimeSchema,
    closeTime: IsoDateTimeSchema,
    open: PositiveNumberSchema,
    high: PositiveNumberSchema,
    low: PositiveNumberSchema,
    close: PositiveNumberSchema,
    volume: NonNegativeNumberSchema.nullable(),
    tickCount: z.number().int().nonnegative(),
    complete: z.boolean(),
    source: z.string().min(1),
    sourceKind: DataSourceKindSchema,
  })
  .refine((b) => b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close), {
    message: 'bar must satisfy low ≤ open, close ≤ high',
    path: ['high'],
  })
  .refine((b) => Date.parse(b.closeTime) > Date.parse(b.openTime), {
    message: 'closeTime must be after openTime',
    path: ['closeTime'],
  });

/** Persistence port for completed bars (implemented by `@astra/db`). */
export interface BarStore {
  /** Inserts or replaces completed bars (keyed by symbol, timeframe, openTime, source). */
  upsert(bars: readonly Bar[]): Promise<void>;
  /** The most recent `limit` completed bars, oldest → newest. */
  recent(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]>;
}
