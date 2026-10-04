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

const CompletedDaySchema = z.object({
  day: z.string(),
  pnl: FiniteNumberSchema,
  /**
   * When the day's closing balance used for `pnl` was observed (the last observation of that day
   * the writer had). Evidence about THAT day, independent of the writer's current snapshot time.
   * Absent on entries recorded before it existed.
   */
  basisAt: IsoDateTimeSchema.optional(),
});
export type CompletedDay = z.infer<typeof CompletedDaySchema>;

/**
 * Two different P&L values recorded for one completed day. LATER_BASIS: one entry was computed
 * from a strictly later observation of that day and was kept (the other is preserved here).
 * UNRESOLVED: the evidence cannot order them — tracking is then not usable for new entries
 * (fail closed) until an audited correction exists.
 */
const DayConflictSchema = z.object({
  day: z.string(),
  kept: CompletedDaySchema,
  other: CompletedDaySchema,
  resolution: z.enum(['LATER_BASIS', 'UNRESOLVED']),
});
export type CompletedDayConflict = z.infer<typeof DayConflictSchema>;

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
  completedDays: z.array(CompletedDaySchema),
  /** Conflicting completed-day evidence seen while merging (never dropped). */
  completedDayConflicts: z.array(DayConflictSchema).optional(),
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
    next.completedDays = [
      ...prev.completedDays,
      { day: prev.tradingDayKey, pnl: dayPnl, basisAt: prev.updatedAt },
    ].slice(-retain);
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

/** Trust in a day-start reference (used only to label a merged reference, never to lower it). */
const DAY_START_RANK: Record<DayStartSource, number> = {
  REPORTED: 3,
  OBSERVED_AT_RESET: 2,
  INITIAL: 1,
  OBSERVED_LATE: 0,
};

/** Completed-day conflicts the evidence could not resolve: tracking must not be used for entries. */
export function unresolvedDayConflicts(t: AccountTracking): CompletedDayConflict[] {
  return (t.completedDayConflicts ?? []).filter((c) => c.resolution === 'UNRESOLVED');
}

/** What a rollover from `t` would record for t's current, not yet completed, day. */
function closingEntry(t: AccountTracking): CompletedDay {
  return {
    day: t.tradingDayKey,
    pnl: money(dec(t.lastBalance).minus(t.dayStartBalance)),
    basisAt: t.updatedAt,
  };
}

const basisMs = (e: CompletedDay): number =>
  e.basisAt === undefined ? Number.NaN : Date.parse(e.basisAt);

/**
 * Union of completed-day evidence. A side still ON a day the other has already rolled past holds
 * its own observations of that day, i.e. the entry its rollover would record. For one day:
 * identical P&L → one entry; different P&L → the entry computed from a strictly later observation
 * of THAT day wins (the other is kept as a LATER_BASIS conflict); otherwise UNRESOLVED (the higher
 * P&L is kept, which is the stricter consistency input, and tracking fails closed).
 */
function mergeCompletedDays(
  stored: AccountTracking,
  incoming: AccountTracking,
): { days: CompletedDay[]; conflicts: CompletedDayConflict[]; closedOlder: boolean } {
  const byDay = new Map<string, CompletedDay[]>();
  const add = (e: CompletedDay) => {
    const list = byDay.get(e.day) ?? [];
    if (!list.some((x) => x.pnl === e.pnl && x.basisAt === e.basisAt)) list.push(e);
    byDay.set(e.day, list);
  };
  for (const e of stored.completedDays) add(e);
  for (const e of incoming.completedDays) add(e);
  // Trading-day keys are ISO dates: lexicographic order is chronological.
  const older =
    stored.tradingDayKey < incoming.tradingDayKey
      ? stored
      : incoming.tradingDayKey < stored.tradingDayKey
        ? incoming
        : null;
  const olderClose = older ? closingEntry(older) : null;
  if (olderClose) add(olderClose);

  const conflicts: CompletedDayConflict[] = [];
  const days: CompletedDay[] = [];
  for (const [day, list] of byDay) {
    if (new Set(list.map((e) => e.pnl)).size === 1) {
      days.push([...list].sort((a, b) => (basisMs(b) || 0) - (basisMs(a) || 0))[0]!);
      continue;
    }
    const ranked = [...list].sort((a, b) => basisMs(b) - basisMs(a));
    const ordered =
      list.every((e) => Number.isFinite(basisMs(e))) && basisMs(ranked[0]!) > basisMs(ranked[1]!);
    const kept = ordered ? ranked[0]! : list.reduce((m, e) => (e.pnl > m.pnl ? e : m), list[0]!);
    days.push(kept);
    for (const other of list)
      if (other.pnl !== kept.pnl)
        conflicts.push({ day, kept, other, resolution: ordered ? 'LATER_BASIS' : 'UNRESOLVED' });
  }
  days.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
  const closedOlder =
    olderClose !== null &&
    days.some(
      (d) =>
        d.day === olderClose.day && d.pnl === olderClose.pnl && d.basisAt === olderClose.basisAt,
    );
  return { days, conflicts, closedOlder };
}

/**
 * Merges two tracking states of the SAME account (the persisted one and a newly computed one,
 * possibly produced by another process from older data or a stale cache).
 *
 * - Peaks and counters that can only grow are the larger of both.
 * - Different trading days: the LATER day owns every day field (day start, counted flag), so
 *   yesterday's day-start floor never leaks into a genuine day reset.
 * - SAME trading day: the references never decrease, whatever either source claims (a lower
 *   correction needs separately evidenced, audited handling, which does not exist); the label
 *   never claims more trust than the source(s) that supplied the kept values. `currentDayCounted`
 *   is sticky.
 * - Completed-day history is the union by day; contradictory P&L for one day is resolved only by
 *   evidence about THAT day (a strictly later closing observation), never by which writer's
 *   current snapshot is newer, and is recorded either way. Unresolvable conflicts make tracking
 *   unusable for new entries (`unresolvedDayConflicts`).
 * - Balance and `updatedAt` come from the later observation; an equal timestamp lets the incoming
 *   state win.
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
  const incomingIsLater = Date.parse(incoming.updatedAt) >= Date.parse(stored.updatedAt);
  const later = incomingIsLater ? incoming : stored;
  const sameDay = stored.tradingDayKey === incoming.tradingDayKey;
  const dayOwner = sameDay
    ? later
    : incoming.tradingDayKey > stored.tradingDayKey
      ? incoming
      : stored;

  let day: Pick<
    AccountTracking,
    'tradingDayKey' | 'dayStartBalance' | 'dayStartEquity' | 'dayStartSource' | 'currentDayCounted'
  >;
  if (!sameDay) {
    day = {
      tradingDayKey: dayOwner.tradingDayKey,
      dayStartBalance: dayOwner.dayStartBalance,
      dayStartEquity: dayOwner.dayStartEquity,
      dayStartSource: dayOwner.dayStartSource,
      currentDayCounted: dayOwner.currentDayCounted,
    };
  } else {
    const balance = Math.max(stored.dayStartBalance, incoming.dayStartBalance);
    const equity = Math.max(stored.dayStartEquity, incoming.dayStartEquity);
    const supplies = (t: AccountTracking) =>
      t.dayStartBalance === balance && t.dayStartEquity === equity;
    const rank = (t: AccountTracking) => DAY_START_RANK[t.dayStartSource];
    const [hi, lo] = rank(stored) >= rank(incoming) ? [stored, incoming] : [incoming, stored];
    // The kept values' label: the more trusted side if it supplies them, else the weaker side.
    const source = (supplies(hi) ? hi : lo).dayStartSource;
    day = {
      tradingDayKey: later.tradingDayKey,
      dayStartBalance: balance,
      dayStartEquity: equity,
      dayStartSource: source,
      currentDayCounted: stored.currentDayCounted || incoming.currentDayCounted,
    };
  }

  const history = mergeCompletedDays(stored, incoming);
  const seen = new Set<string>();
  const conflicts = [
    ...(stored.completedDayConflicts ?? []),
    ...(incoming.completedDayConflicts ?? []),
    ...history.conflicts,
  ].filter((c) => {
    const key = JSON.stringify([c.day, c.kept, c.other, c.resolution]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The older side's closing balance is that day's end-of-day balance when its entry was kept.
  const older = sameDay ? null : dayOwner === incoming ? stored : incoming;
  const endOfDayBalancePeak = Math.max(
    stored.endOfDayBalancePeak,
    incoming.endOfDayBalancePeak,
    older && history.closedOlder ? older.lastBalance : Number.NEGATIVE_INFINITY,
  );

  return AccountTrackingSchema.parse({
    ...later,
    ...day,
    completedDays: history.days.slice(-400),
    ...(conflicts.length > 0 ? { completedDayConflicts: conflicts.slice(-400) } : {}),
    equityPeak: Math.max(stored.equityPeak, incoming.equityPeak),
    balancePeak: Math.max(stored.balancePeak, incoming.balancePeak),
    endOfDayBalancePeak,
    tradingDaysCount: Math.max(stored.tradingDaysCount, incoming.tradingDaysCount),
  });
}
