/**
 * Bar timeframes and their period windows.
 *
 * - Intraday timeframes (M1…H4) align to UTC epoch multiples: an H4 bar opens at 00:00, 04:00, …
 *   UTC. Every boundary of a coarser intraday timeframe is also a boundary of the finer ones.
 * - D1 aligns to the instrument's trading day (`tradingHours.dayStart` in its time zone, DST-safe),
 *   so a CME-style day runs 18:00 → 18:00 New York time and is 23 h or 25 h long on DST changes.
 *   Without configured trading hours, D1 falls back to UTC midnight (documented; such an
 *   instrument is refused by the market.session gate anyway).
 */
import { marketStatus, tradingDayWindow, type TradingHours } from '@astra/core';
import { z } from 'zod';

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TimeframeSchema = z.enum(TIMEFRAMES);

export type IntradayTimeframe = Exclude<Timeframe, 'D1'>;

const MINUTE_MS = 60_000;

export const INTRADAY_MS: Readonly<Record<IntradayTimeframe, number>> = {
  M1: MINUTE_MS,
  M5: 5 * MINUTE_MS,
  M15: 15 * MINUTE_MS,
  M30: 30 * MINUTE_MS,
  H1: 60 * MINUTE_MS,
  H4: 240 * MINUTE_MS,
};

export interface BarWindow {
  /** Inclusive start (epoch ms). */
  readonly openMs: number;
  /** Exclusive end (epoch ms). */
  readonly closeMs: number;
}

/** The trading-day window used for D1 bars (UTC midnight when no trading hours are configured). */
export function dailyWindow(atMs: number, hours: TradingHours | undefined): BarWindow {
  const w = tradingDayWindow(new Date(atMs), {
    timeZone: hours?.timeZone ?? 'UTC',
    time: hours?.dayStart ?? '00:00',
  });
  return { openMs: w.start.getTime(), closeMs: w.end.getTime() };
}

/**
 * The trading day before the one opening at `dayOpenMs`: the nearest earlier D1 window in which
 * the market is scheduled to be open at some point (weekends are skipped; exchange holidays are
 * not modelled). Without trading hours every UTC day counts. Null if none within a week.
 */
export function previousTradingDay(
  dayOpenMs: number,
  hours: TradingHours | undefined,
): BarWindow | null {
  let w = dailyWindow(dayOpenMs - 1, hours);
  for (let i = 0; i < 7; i++) {
    if (!hours) return w;
    const status = marketStatus(new Date(w.openMs), hours);
    if (status.open || (status.nextOpen !== null && Date.parse(status.nextOpen) < w.closeMs)) {
      return w;
    }
    w = dailyWindow(w.openMs - 1, hours);
  }
  return null;
}

/** The bar period of `timeframe` containing the instant `atMs`. */
export function barWindow(
  atMs: number,
  timeframe: Timeframe,
  hours: TradingHours | undefined,
): BarWindow {
  if (timeframe === 'D1') return dailyWindow(atMs, hours);
  const size = INTRADAY_MS[timeframe];
  const openMs = Math.floor(atMs / size) * size;
  return { openMs, closeMs: openMs + size };
}
