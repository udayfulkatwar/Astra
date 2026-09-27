/**
 * Market sessions (spec §56) and instrument trading hours.
 *
 * - A SessionDefinition is a named daily window (e.g. London 08:00–16:30 Europe/London) used by
 *   strategies to restrict when they may trade. Windows may cross local midnight.
 * - TradingHours is an instrument's weekly schedule of open intervals in the exchange/broker
 *   time zone (e.g. CME Globex: Sun 18:00 → Mon 17:00 ET, daily break 17:00–18:00).
 *
 * Both are evaluated on local wall-clock time via Luxon, so DST is handled automatically.
 * Exchange holidays are not modelled here; on a holiday the absence of fresh quotes blocks
 * trading through the data-freshness gate.
 */
import { DateTime } from 'luxon';
import { z } from 'zod';
import { SlugSchema } from './schemas';
import { LocalTimeSchema, TimeZoneSchema, WEEKDAYS, nextWeeklyTime, type Weekday } from './time';

const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

function minutesOfDay(time: string): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

function weekdayIndex(day: Weekday): number {
  return WEEKDAYS.indexOf(day); // MON = 0 … SUN = 6
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export const SessionDefinitionSchema = z
  .object({
    id: SlugSchema,
    name: z.string().min(1),
    timeZone: TimeZoneSchema,
    start: LocalTimeSchema,
    /** End time; earlier than `start` means the session crosses local midnight. */
    end: LocalTimeSchema,
    /** Days on which the session STARTS (local). */
    days: z.array(z.enum(WEEKDAYS)).min(1),
  })
  .refine((s) => s.start !== s.end, {
    message: 'session start and end must differ',
    path: ['end'],
  });
export type SessionDefinition = z.infer<typeof SessionDefinitionSchema>;

/** Whether `instant` falls inside the session window. */
export function isInSession(instant: Date, s: SessionDefinition): boolean {
  const local = DateTime.fromJSDate(instant, { zone: s.timeZone });
  const minute = local.hour * 60 + local.minute;
  const start = minutesOfDay(s.start);
  const end = minutesOfDay(s.end);
  const today = WEEKDAYS[local.weekday - 1]!;
  const yesterday = WEEKDAYS[(local.weekday + 5) % 7]!;
  if (end > start) return s.days.includes(today) && minute >= start && minute < end;
  // Crosses midnight: evening part belongs to today's start, early-morning part to yesterday's.
  return (
    (s.days.includes(today) && minute >= start) || (s.days.includes(yesterday) && minute < end)
  );
}

export function activeSessions(instant: Date, sessions: readonly SessionDefinition[]): string[] {
  return sessions.filter((s) => isInSession(instant, s)).map((s) => s.id);
}

// ---------------------------------------------------------------------------------------------
// Instrument trading hours
// ---------------------------------------------------------------------------------------------

export const WeeklyPointSchema = z.object({ day: z.enum(WEEKDAYS), time: LocalTimeSchema });
export type WeeklyPoint = z.infer<typeof WeeklyPointSchema>;

export const TradingHoursSchema = z.object({
  timeZone: TimeZoneSchema,
  /** Trading-day boundary (local), used for daily bars and "previous day" levels. */
  dayStart: LocalTimeSchema,
  /** Open intervals of the week. An interval whose close precedes its open wraps the week end. */
  weekly: z
    .array(z.object({ open: WeeklyPointSchema, close: WeeklyPointSchema }))
    .min(1)
    .refine((w) => w.every((i) => i.open.day !== i.close.day || i.open.time !== i.close.time), {
      message: 'an interval cannot open and close at the same instant',
    }),
});
export type TradingHours = z.infer<typeof TradingHoursSchema>;

function minuteOfWeek(p: WeeklyPoint): number {
  return weekdayIndex(p.day) * MINUTES_PER_DAY + minutesOfDay(p.time);
}

function contains(openMin: number, closeMin: number, m: number): boolean {
  return closeMin > openMin ? m >= openMin && m < closeMin : m >= openMin || m < closeMin;
}

export interface MarketStatus {
  readonly open: boolean;
  /** Next scheduled close (when open) — ISO UTC. */
  readonly nextClose: string | null;
  /** Next scheduled open (when closed) — ISO UTC. */
  readonly nextOpen: string | null;
  /** Minutes until the next scheduled close (when open). */
  readonly minutesToClose: number | null;
}

/** Scheduled market status of an instrument at `instant`. */
export function marketStatus(instant: Date, hours: TradingHours): MarketStatus {
  const local = DateTime.fromJSDate(instant, { zone: hours.timeZone });
  const m =
    ((local.weekday - 1) * MINUTES_PER_DAY + local.hour * 60 + local.minute) % MINUTES_PER_WEEK;
  const at = (p: WeeklyPoint) => nextWeeklyTime(instant, { ...p, timeZone: hours.timeZone });

  const current = hours.weekly.find((i) =>
    contains(minuteOfWeek(i.open), minuteOfWeek(i.close), m),
  );
  if (current) {
    const close = at(current.close);
    return {
      open: true,
      nextClose: close.toISOString(),
      nextOpen: null,
      minutesToClose: (close.getTime() - instant.getTime()) / 60_000,
    };
  }
  const opens = hours.weekly.map((i) => at(i.open).getTime());
  return {
    open: false,
    nextClose: null,
    nextOpen: new Date(Math.min(...opens)).toISOString(),
    minutesToClose: null,
  };
}
