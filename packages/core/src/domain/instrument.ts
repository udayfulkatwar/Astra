/** Instrument specifications (broker/exchange facts). Never invented: supplied via config. */
import { z } from 'zod';
import { TradingHoursSchema } from '../sessions';
import {
  CurrencySchema,
  NonNegativeNumberSchema,
  PositiveNumberSchema,
  SymbolSchema,
  VerificationSchema,
} from '../schemas';

export const ASSET_CLASSES = [
  'FUTURES',
  'FOREX',
  'CFD_INDEX',
  'CFD_METAL',
  'CFD_COMMODITY',
  'CRYPTO',
  'EQUITY',
  'ETF',
] as const;

export const QUANTITY_UNITS = ['CONTRACTS', 'LOTS', 'UNITS'] as const;
export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

export const InstrumentSpecSchema = z
  .object({
    symbol: SymbolSchema,
    displayName: z.string().min(1),
    assetClass: z.enum(ASSET_CLASSES),
    quantityUnit: z.enum(QUANTITY_UNITS),
    /** Currency in which tickValue is expressed. */
    quoteCurrency: CurrencySchema,
    /** Minimum price increment. */
    tickSize: PositiveNumberSchema,
    /** Value of a one-tick move for a quantity of 1, in quoteCurrency. */
    tickValue: PositiveNumberSchema,
    /** Quantity increment (e.g. 1 contract, 0.01 lots). */
    quantityStep: PositiveNumberSchema,
    minQuantity: PositiveNumberSchema,
    /** Broker/exchange maximum per order, if any. */
    maxQuantity: PositiveNumberSchema.optional(),
    /** Spread guard: new trades are refused when the spread exceeds this many ticks. */
    maxSpreadTicks: PositiveNumberSchema,
    /** Cost assumptions used in worst-case risk (conservative estimates, not fills). */
    costs: z.object({
      commissionPerUnitRoundTurn: NonNegativeNumberSchema,
      slippageAllowanceTicks: NonNegativeNumberSchema,
    }),
    /**
     * Scheduled trading hours. Absent → market status UNKNOWN → no new trades (fail-closed).
     * Broker/exchange specific: verify against your platform.
     */
    tradingHours: TradingHoursSchema.optional(),
    /**
     * Max distance between a signal's entry and the executable price for this instrument (ticks).
     * Overrides the global decision policy value: ticks differ greatly in value across instruments.
     */
    maxEntryDeviationTicks: PositiveNumberSchema.optional(),
    /** Data-quality guard: a quote-to-quote move larger than this is treated as abnormal. */
    maxQuoteJumpTicks: PositiveNumberSchema.optional(),
    /** Symbol used by each market-data/broker adapter, keyed by adapter id (e.g. { mt5: "XAUUSD.r" }). */
    providerSymbols: z.record(z.string(), z.string().min(1)).optional(),
    verification: VerificationSchema,
    notes: z.string().optional(),
  })
  .refine((s) => s.minQuantity >= s.quantityStep, {
    message: 'minQuantity must be at least one quantityStep',
    path: ['minQuantity'],
  })
  .refine((s) => s.maxQuantity === undefined || s.maxQuantity >= s.minQuantity, {
    message: 'maxQuantity must be ≥ minQuantity',
    path: ['maxQuantity'],
  });
export type InstrumentSpec = z.infer<typeof InstrumentSpecSchema>;

/** Currency value of a one-unit price move for quantity 1. */
export function valuePerPoint(spec: Pick<InstrumentSpec, 'tickSize' | 'tickValue'>): number {
  return spec.tickValue / spec.tickSize;
}
