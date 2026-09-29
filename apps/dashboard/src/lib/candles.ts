/** Pure helpers for the candlestick chart (Charts page). */
import type { Bar } from '../api/types';

export interface Candle {
  /** Epoch seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  color?: string;
  wickColor?: string;
  borderColor?: string;
}

/** Decimal places of a tick size: 0.25 → 2, 0.00001 → 5, 1 → 0. */
export function tickDecimals(tick: number): number {
  if (!(tick > 0) || !Number.isFinite(tick)) return 2;
  const frac = tick.toFixed(12).replace(/0+$/, '').split('.')[1] ?? '';
  return Math.min(frac.length, 10);
}

/**
 * Bars → chart candles. The chart needs strictly ascending times, so out-of-order or duplicate
 * bars are dropped (never merged). The in-progress bar gets its own colours so it is never
 * mistaken for a closed candle.
 */
export function toCandles(
  bars: readonly Bar[],
  inProgress: { up: string; down: string },
): Candle[] {
  const out: Candle[] = [];
  let last = -Infinity;
  for (const b of bars) {
    const time = Date.parse(b.openTime) / 1000;
    if (!(time > last)) continue;
    last = time;
    const c: Candle = { time, open: b.open, high: b.high, low: b.low, close: b.close };
    if (!b.complete) {
      const color = b.close >= b.open ? inProgress.up : inProgress.down;
      Object.assign(c, { color, wickColor: color, borderColor: color });
    }
    out.push(c);
  }
  return out;
}

/** A provider-to-ASTRA delay for people: 300 → "0.3 s", 65 000 → "1 min 5 s". */
export function delay(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 0) return `${(ms / 1000).toFixed(1)} s (clock ahead)`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${min} min ${s} s` : `${min} min`;
}
