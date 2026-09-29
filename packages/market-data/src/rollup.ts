/**
 * Builds coarser bars from complete 1-minute bars of one series (a provider's own history).
 *
 * A coarser bar is emitted only when its whole period is covered by the history: the period
 * starts at or after the first 1-minute bar's period and has ended by `nowMs`. Minutes without a
 * candle inside a period stay gaps (as for live bars: no trade → no price); nothing is filled.
 */
import type { TradingHours } from '@astra/core';
import type { Bar } from './bar';
import { barWindow, type Timeframe } from './timeframe';

export function rollUp(
  m1: readonly Bar[],
  timeframe: Timeframe,
  hours: TradingHours | undefined,
  nowMs: number,
): Bar[] {
  if (m1.length === 0) return [];
  const sorted = [...m1].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  const historyStartMs = Date.parse(sorted[0]!.openTime);
  const out: Bar[] = [];
  let cur: { openMs: number; closeMs: number; bars: Bar[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const first = cur.bars[0]!;
    const last = cur.bars.at(-1)!;
    // Only whole periods: one that began before the history (partly unseen) or has not ended yet
    // (still forming) is left out rather than shown with made-up extremes.
    if (cur.closeMs <= nowMs && cur.openMs >= historyStartMs) {
      const volumes = cur.bars.map((b) => b.volume);
      out.push({
        symbol: first.symbol,
        timeframe,
        openTime: new Date(cur.openMs).toISOString(),
        closeTime: new Date(cur.closeMs).toISOString(),
        open: first.open,
        high: Math.max(...cur.bars.map((b) => b.high)),
        low: Math.min(...cur.bars.map((b) => b.low)),
        close: last.close,
        volume: volumes.every((v) => v !== null) ? volumes.reduce((a, v) => a + v, 0) : null,
        tickCount: 0,
        complete: true,
        source: first.source,
        sourceKind: first.sourceKind,
      });
    }
    cur = null;
  };
  for (const b of sorted) {
    if (!b.complete || b.timeframe !== 'M1') continue;
    const openMs = Date.parse(b.openTime);
    const w = barWindow(openMs, timeframe, hours);
    if (!cur || cur.openMs !== w.openMs) {
      flush();
      cur = { openMs: w.openMs, closeMs: w.closeMs, bars: [] };
    }
    cur.bars.push(b);
  }
  flush();
  return out;
}
