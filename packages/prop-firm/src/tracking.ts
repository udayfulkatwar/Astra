/**
 * Account tracking: state ASTRA maintains between broker snapshots that prop-firm rules depend
 * on — day-start values, equity/balance peaks (for trailing drawdown), completed-day P&L (for
 * consistency) and trading-day count. Pure functions; persistence is the caller's job.
 */
import {
  AstraError,
  FiniteNumberSchema,
  IsoDateTimeSchema,
  PositiveNumberSchema,
  SlugSchema,
  dec,
  decMax,
  money,
  tradingDayWindow,
  type AccountSnapshot,
  type LocalTimeInZone,
} from '@astra/core';
import { z } from 'zod';

export const DAY_START_SOURCES = [
  'REPORTED',
  'OBSERVED_AT_RESET',
  'OBSERVED_LATE',
  'INITIAL',
] as const;
export type DayStartSource = (typeof DAY_START_SOURCES)[number];

export const AccountTrackingSchema = z.object({
  accountId: SlugSchema,
  /** Starting balance of the account (the firm's "initial balance"). */
  initialBalance: PositiveNumberSchema,
  tradingDayKey: z.string().min(1),
  dayStartBalance: FiniteNumberSchema,
  dayStartEquity: FiniteNumberSchema,
  dayStartSource: z.enum(DAY_START_SOURCES),
  /** Highest equity ever observed (incl. unrealized). */
  equityPeak: FiniteNumberSchema,
  /** Highest realized balance ever observed. */
  balancePeak: FiniteNumberSchema,
  /** Highest end-of-day balance. */
  endOfDayBalancePeak: FiniteNumberSchema,
  lastBalance: FiniteNumberSchema,
  /** Realized P&L of completed trading days (most recent last). */
  completedDays: z.array(z.object({ day: z.string(), pnl: FiniteNumberSchema })),
  tradingDaysCount: z.number().int().nonnegative(),
  /** Whether the current trading day has already been counted as a trading day. */
  currentDayCounted: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type AccountTracking = z.infer<typeof AccountTrackingSchema>;

/** Starts tracking a brand-new account from its initial balance. */
export function initAccountTracking(params: {
  accountId: string;
  initialBalance: number;
  snapshot: AccountSnapshot;
  reset: LocalTimeInZone;
}): AccountTracking {
  const { snapshot } = params;
  const dayKey = tradingDayWindow(new Date(snapshot.asOf), params.reset).key;
  const reported = snapshot.reported;
  return {
    accountId: params.accountId,
    initialBalance: params.initialBalance,
    tradingDayKey: dayKey,
    dayStartBalance: reported?.dayStartBalance ?? snapshot.balance,
    dayStartEquity: reported?.dayStartEquity ?? snapshot.equity,
    dayStartSource: reported?.dayStartBalance !== undefined ? 'REPORTED' : 'INITIAL',
    equityPeak: Math.max(params.initialBalance, snapshot.equity),
    balancePeak: Math.max(params.initialBalance, snapshot.balance),
    endOfDayBalancePeak: params.initialBalance,
    lastBalance: snapshot.balance,
    completedDays: [],
    tradingDaysCount: 0,
    currentDayCounted: false,
    updatedAt: snapshot.asOf,
  };
}

export interface UpdateTrackingOptions {
  reset: LocalTimeInZone;
  /** Whether at least one trade was opened in the current trading day (from ASTRA's records). */
  tradedToday: boolean;
  /**
   * If the first snapshot of a new day arrives later than this after the reset, day-start values
   * are only approximately known; ASTRA then uses the conservative (higher) candidate.
   */
  lateObservationThresholdMs: number;
  /** Number of completed days to retain for consistency checks. */
  retainDays?: number;
}

/**
 * Advances tracking with a new snapshot. Out-of-order snapshots are rejected (they would corrupt
 * peaks and day-start values).
 */
export function updateAccountTracking(
  prev: AccountTracking,
  snapshot: AccountSnapshot,
  opts: UpdateTrackingOptions,
): AccountTracking {
  if (snapshot.accountId !== prev.accountId) {
    throw new AstraError('VALIDATION', 'snapshot belongs to a different account', {
      expected: prev.accountId,
      received: snapshot.accountId,
    });
  }
  const at = new Date(snapshot.asOf);
  if (at.getTime() < Date.parse(prev.updatedAt)) {
    throw new AstraError('CONFLICT', 'out-of-order account snapshot', {
      previous: prev.updatedAt,
      received: snapshot.asOf,
    });
  }

  const window = tradingDayWindow(at, opts.reset);
  let next: AccountTracking = { ...prev };

  if (window.key !== prev.tradingDayKey) {
    // Day rollover: close out the previous day.
    const dayPnl = money(dec(prev.lastBalance).minus(prev.dayStartBalance));
    const retain = opts.retainDays ?? 400;
    next.completedDays = [...prev.completedDays, { day: prev.tradingDayKey, pnl: dayPnl }].slice(
      -retain,
    );
    next.endOfDayBalancePeak = decMax(
      dec(prev.endOfDayBalancePeak),
      dec(prev.lastBalance),
    ).toNumber();
    next.tradingDayKey = window.key;
    next.currentDayCounted = false;

    const reported = snapshot.reported;
    if (reported?.dayStartBalance !== undefined && reported.dayStartEquity !== undefined) {
      next.dayStartBalance = reported.dayStartBalance;
      next.dayStartEquity = reported.dayStartEquity;
      next.dayStartSource = 'REPORTED';
    } else {
      const lateBy = at.getTime() - window.start.getTime();
      if (lateBy <= opts.lateObservationThresholdMs) {
        next.dayStartBalance = snapshot.balance;
        next.dayStartEquity = snapshot.equity;
        next.dayStartSource = 'OBSERVED_AT_RESET';
      } else {
        // True day-start values are unknown. A higher reference means a higher daily-loss floor,
        // which is the conservative choice.
        next.dayStartBalance = decMax(dec(prev.lastBalance), dec(snapshot.balance)).toNumber();
        next.dayStartEquity = decMax(
          dec(prev.lastBalance),
          dec(snapshot.balance),
          dec(snapshot.equity),
        ).toNumber();
        next.dayStartSource = 'OBSERVED_LATE';
      }
    }
  }

  next.equityPeak = decMax(dec(prev.equityPeak), dec(snapshot.equity)).toNumber();
  next.balancePeak = decMax(dec(prev.balancePeak), dec(snapshot.balance)).toNumber();
  next.lastBalance = snapshot.balance;
  if (opts.tradedToday && !next.currentDayCounted) {
    next.tradingDaysCount = prev.tradingDaysCount + 1;
    next.currentDayCounted = true;
  }
  next.updatedAt = snapshot.asOf;
  next = AccountTrackingSchema.parse(next);
  return next;
}

/**
 * Merges two tracking states of the SAME account (the persisted one and a newly computed one,
 * possibly produced by another process from older data). The later observation provides the
 * state; every peak/counter that can only grow is the larger of both, so a stale writer can never
 * lower a peak or the drawdown/daily-loss references derived from it. The stored state wins ties.
 */
export function mergeAccountTracking(
  stored: AccountTracking,
  incoming: AccountTracking,
): AccountTracking {
  if (stored.accountId !== incoming.accountId) {
    throw new AstraError('VALIDATION', 'cannot merge tracking of different accounts', {
      stored: stored.accountId,
      incoming: incoming.accountId,
    });
  }
  const base = Date.parse(incoming.updatedAt) > Date.parse(stored.updatedAt) ? incoming : stored;
  return AccountTrackingSchema.parse({
    ...base,
    equityPeak: Math.max(stored.equityPeak, incoming.equityPeak),
    balancePeak: Math.max(stored.balancePeak, incoming.balancePeak),
    endOfDayBalancePeak: Math.max(stored.endOfDayBalancePeak, incoming.endOfDayBalancePeak),
    tradingDaysCount: Math.max(stored.tradingDaysCount, incoming.tradingDaysCount),
  });
}
