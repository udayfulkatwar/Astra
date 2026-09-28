/**
 * Account definitions (configuration) and account snapshots (DATA from the broker/platform).
 * Every account is isolated: nothing in a snapshot references another account (spec §14, §45).
 */
import { z } from 'zod';
import {
  CurrencySchema,
  DirectionSchema,
  FiniteNumberSchema,
  IsoDateTimeSchema,
  PositiveNumberSchema,
  SlugSchema,
  SymbolSchema,
} from '../schemas';

export const ACCOUNT_STATUSES = ['ACTIVE', 'DISABLED', 'PASSED', 'BREACHED', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Environment-variable NAME (never a value) that holds a credential. */
export const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{2,127}$/, { message: 'must be an environment variable name' });

export const AccountDefinitionSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  firm: z.string().min(1),
  propFirmProfileId: SlugSchema,
  riskPolicyId: SlugSchema,
  currency: CurrencySchema,
  status: z.enum(ACCOUNT_STATUSES),
  broker: z.object({
    /** Registered BrokerAdapter id, e.g. "paper". */
    adapterId: z.string().min(1),
    /** Broker-side account reference (not a secret). */
    accountRef: z.string().min(1),
    /** Name of the env var holding credentials, if the adapter needs them. */
    credentialsEnv: EnvVarNameSchema.optional(),
  }),
  strategies: z.array(SlugSchema),
  instruments: z.array(SymbolSchema).min(1),
  /** One of six independent factors required for live trading (ADR-0008). */
  liveTradingAuthorized: z.boolean().default(false),
  notes: z.string().optional(),
});
export type AccountDefinition = z.infer<typeof AccountDefinitionSchema>;

export const OpenPositionSchema = z.object({
  positionId: z.string().min(1),
  symbol: SymbolSchema,
  direction: DirectionSchema,
  quantity: PositiveNumberSchema,
  entryPrice: PositiveNumberSchema,
  currentPrice: PositiveNumberSchema,
  /** Protective stop. null = no stop → open risk is UNKNOWN (fail-closed). */
  stopPrice: PositiveNumberSchema.nullable(),
  targetPrice: PositiveNumberSchema.nullable(),
  unrealizedPnl: FiniteNumberSchema,
  openedAt: IsoDateTimeSchema,
  strategyId: SlugSchema.optional(),
});
export type OpenPosition = z.infer<typeof OpenPositionSchema>;

/** An entry order resting at the broker (a LIMIT not yet filled): exposure that may still open. */
export const WorkingOrderSchema = z.object({
  clientOrderId: z.string().min(1),
  symbol: SymbolSchema,
  direction: DirectionSchema,
  /** Unfilled quantity. */
  quantity: PositiveNumberSchema,
  limitPrice: PositiveNumberSchema,
  /** The bracket the position will carry once filled. */
  stopPrice: PositiveNumberSchema,
  targetPrice: PositiveNumberSchema,
  placedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  strategyId: SlugSchema.optional(),
});
export type WorkingOrder = z.infer<typeof WorkingOrderSchema>;

/**
 * Account DATA as reported by the platform at `asOf`. Values the firm itself reports (e.g. its
 * own drawdown threshold) are optional; when present, ASTRA uses the more conservative of the
 * reported and computed value.
 */
export const AccountSnapshotSchema = z.object({
  accountId: SlugSchema,
  asOf: IsoDateTimeSchema,
  currency: CurrencySchema,
  /** Realized balance. */
  balance: FiniteNumberSchema,
  /** Balance + floating P&L. */
  equity: FiniteNumberSchema,
  openPositions: z.array(OpenPositionSchema),
  /** Every order not yet final at the broker (entries and anything else). */
  pendingOrders: z.number().int().nonnegative(),
  /**
   * Details of the pending entry orders. Risk rules count each as if filled at its limit; pending
   * orders without details make open risk UNKNOWN (fail-closed).
   */
  workingOrders: z.array(WorkingOrderSchema).optional(),
  reported: z
    .object({
      drawdownThreshold: FiniteNumberSchema.optional(),
      dailyLossFloor: FiniteNumberSchema.optional(),
      dayStartBalance: FiniteNumberSchema.optional(),
      dayStartEquity: FiniteNumberSchema.optional(),
    })
    .optional(),
});
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;

/**
 * Trading activity derived from ASTRA's own records (orders/journal), not from the broker.
 */
export const AccountActivitySchema = z.object({
  tradingDayKey: z.string().min(1),
  tradesToday: z.number().int().nonnegative(),
  consecutiveLosses: z.number().int().nonnegative(),
});
export type AccountActivity = z.infer<typeof AccountActivitySchema>;

/**
 * Positions plus working entry orders as would-be positions (filled at their limit, flat P&L):
 * the exposure every limit — open risk, position counts, hedging, firm quantity caps — must count.
 */
export function exposurePositions(snapshot: AccountSnapshot): OpenPosition[] {
  const working = (snapshot.workingOrders ?? []).map((o): OpenPosition => ({
    positionId: `working:${o.clientOrderId}`,
    symbol: o.symbol,
    direction: o.direction,
    quantity: o.quantity,
    entryPrice: o.limitPrice,
    currentPrice: o.limitPrice,
    stopPrice: o.stopPrice,
    targetPrice: o.targetPrice,
    unrealizedPnl: 0,
    openedAt: o.placedAt,
    ...(o.strategyId ? { strategyId: o.strategyId } : {}),
  }));
  return [...snapshot.openPositions, ...working];
}

/** Pending orders the broker reported without details (their exposure is unknown). */
export const undetailedPendingOrders = (snapshot: AccountSnapshot): number =>
  Math.max(0, snapshot.pendingOrders - (snapshot.workingOrders?.length ?? 0));
