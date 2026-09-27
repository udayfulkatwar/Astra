/**
 * Time handling. ASTRA uses UTC internally (spec §55); named IANA time zones are used only to
 * evaluate rules defined in local time (prop-firm day resets, flat-by times, sessions).
 */
import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { AstraError } from './errors';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests, backtests and replays. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: string | Date) {
    this.current = typeof start === 'string' ? parseIsoStrict(start) : start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: string | Date): void {
    this.current = typeof at === 'string' ? parseIsoStrict(at) : at.getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export function toIso(d: Date): string {
  return d.toISOString();
}

export function parseIsoStrict(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new AstraError('VALIDATION', `invalid ISO timestamp "${iso}"`);
  return ms;
}

export function isValidTimeZone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export const TimeZoneSchema = z
  .string()
  .refine(isValidTimeZone, { message: 'must be a valid IANA time zone, e.g. America/New_York' });

/** Local wall-clock time "HH:mm" (24h). */
export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:mm (24h)' });

export const LocalTimeInZoneSchema = z.object({
  timeZone: TimeZoneSchema,
  time: LocalTimeSchema,
});
export type LocalTimeInZone = z.infer<typeof LocalTimeInZoneSchema>;

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WeeklyTimeSchema = LocalTimeInZoneSchema.extend({ day: z.enum(WEEKDAYS) });
export type WeeklyTime = z.infer<typeof WeeklyTimeSchema>;

function splitTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':');
  return { hour: Number(h), minute: Number(m) };
}

export interface TradingDayWindow {
  /** Trading-day label: local calendar date (in the reset zone) of the last instant of the window. */
  readonly key: string;
  readonly start: Date;
  readonly end: Date;
}

/**
 * Returns the trading-day window containing `instant` for a daily reset at a local time.
 * Example: reset 17:00 America/New_York → Monday's window is Sun 17:00 → Mon 17:00 ET, key = Monday.
 * Example: reset 00:00 Europe/Prague → key is the Prague calendar date.
 * DST is handled by Luxon: the reset stays at the same wall-clock time.
 */
export function tradingDayWindow(instant: Date, reset: LocalTimeInZone): TradingDayWindow {
  const { hour, minute } = splitTime(reset.time);
  const local = DateTime.fromJSDate(instant, { zone: reset.timeZone });
  let start = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (start > local) start = start.minus({ days: 1 });
  const end = start.plus({ days: 1 });
  const key = end.minus({ milliseconds: 1 }).toISODate();
  if (key === null) throw new AstraError('INTERNAL', 'failed to compute trading day key');
  return { key, start: start.toJSDate(), end: end.toJSDate() };
}

/** Next occurrence (strictly after or equal to `instant`) of a daily local time. */
export function nextDailyTime(instant: Date, at: LocalTimeInZone): Date {
  const { hour, minute } = splitTime(at.time);
  const local = DateTime.fromJSDate(instant, { zone: at.timeZone });
  let candidate = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (candidate < local) candidate = candidate.plus({ days: 1 });
  return candidate.toJSDate();
}

/** Next occurrence (at or after `instant`) of a weekly local time, e.g. FRI 16:00 America/New_York. */
export function nextWeeklyTime(instant: Date, at: WeeklyTime): Date {
  const { hour, minute } = splitTime(at.time);
  const targetWeekday = WEEKDAYS.indexOf(at.day) + 1; // Luxon: 1 = Monday
  const local = DateTime.fromJSDate(instant, { zone: at.timeZone });
  let candidate = local.set({ hour, minute, second: 0, millisecond: 0 });
  const dayDelta = (targetWeekday - candidate.weekday + 7) % 7;
  candidate = candidate.plus({ days: dayDelta });
  if (candidate < local) candidate = candidate.plus({ days: 7 });
  return candidate.toJSDate();
}

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}
