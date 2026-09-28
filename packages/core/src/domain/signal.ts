/** SIGNAL: a strategy's claim that a setup exists. Never a decision. */
import { z } from 'zod';
import {
  DirectionSchema,
  IsoDateTimeSchema,
  PositiveNumberSchema,
  SlugSchema,
  SymbolSchema,
} from '../schemas';

export const SETUP_STATES = [
  'NO_SETUP',
  'WATCH',
  'QUALIFIED',
  'APPROVED',
  'EXECUTED',
  'INVALIDATED',
] as const;
export type SetupState = (typeof SETUP_STATES)[number];

export const ENTRY_TYPES = ['MARKET', 'LIMIT'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const SignalSchema = z.object({
  id: z.string().min(1),
  strategyId: SlugSchema,
  symbol: SymbolSchema,
  direction: DirectionSchema,
  setupState: z.enum(SETUP_STATES),
  entryType: z.enum(ENTRY_TYPES).default('MARKET'),
  entry: PositiveNumberSchema,
  stop: PositiveNumberSchema,
  target: PositiveNumberSchema,
  timeframe: z.string().optional(),
  detectedAt: IsoDateTimeSchema,
  /** LIMIT entries: when the unfilled order is cancelled (required for LIMIT; a missed entry is no trade). */
  expiresAt: IsoDateTimeSchema.optional(),
  /** Human-readable facts that produced the signal (e.g. "BOS on M15", "liquidity sweep of PDL"). */
  rationale: z.array(z.string()).default([]),
  /** Machine-readable features for later analysis. */
  features: z.record(z.string(), z.unknown()).default({}),
});
export type Signal = z.infer<typeof SignalSchema>;
