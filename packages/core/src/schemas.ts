/** Shared primitive schemas used across configuration, API payloads and records. */
import { z } from 'zod';

/** Lower-case identifier for config entities (accounts, profiles, strategies, policies). */
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { message: 'must be lower-case letters, digits and dashes' });

/** Instrument symbol, e.g. XAUUSD, US100, MNQ, ES. */
export const SymbolSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/, { message: 'must be an upper-case instrument symbol' });

export const CurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: 'must be an ISO-4217 code' });

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const IsoDateSchema = z.iso.date();

/** Finite number (Zod 4 rejects NaN and ±Infinity). */
export const FiniteNumberSchema = z.number();
export const PositiveNumberSchema = z.number().positive();
export const NonNegativeNumberSchema = z.number().nonnegative();
/** A percentage in (0, 100]. */
export const PercentSchema = z.number().gt(0).lte(100);

export const DIRECTIONS = ['LONG', 'SHORT'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const DirectionSchema = z.enum(DIRECTIONS);

/** +1 for LONG, -1 for SHORT: price move × sign = P&L direction. */
export function directionSign(direction: Direction): 1 | -1 {
  return direction === 'LONG' ? 1 : -1;
}

/**
 * Verification of externally-defined facts (prop-firm rules, broker contract specs).
 * ASTRA ships templates as UNVERIFIED; the owner marks them USER_VERIFIED after checking the
 * firm's/broker's current terms. LIVE mode refuses UNVERIFIED items (ADR-0006, ADR-0008).
 */
export const VerificationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('UNVERIFIED'),
    note: z.string().optional(),
  }),
  z.object({
    status: z.literal('USER_VERIFIED'),
    verifiedBy: z.string().min(1),
    verifiedAt: IsoDateSchema,
    source: z.string().min(1),
    note: z.string().optional(),
  }),
]);
export type Verification = z.infer<typeof VerificationSchema>;
