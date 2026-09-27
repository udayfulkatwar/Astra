/**
 * M1 → higher-timeframe bars during a replay. A higher bar is emitted only once its period has
 * ended (the M1 bar closing at the period end, or the first M1 bar of a later period), so the
 * strategy never sees a bar that was still forming. A period that began before the first M1 bar
 * is incomplete and never emitted.
 */
import type { TradingHours } from '@astra/core';
import { barWindow, type Bar, type Timeframe } from '@astra/market-data';

interface Working {
  openMs: number;
  closeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  incomplete: boolean;
}

export class Resampler {
  private current: Working | null = null;
  private firstOpenMs: number | null = null;

  constructor(
    private readonly timeframe: Exclude<Timeframe, 'M1'>,
    private readonly hours: TradingHours | undefined,
  ) {}

  /** Adds one complete M1 bar; returns the higher bars that completed (in order). */
  push(m1: Bar): Bar[] {
    const done: Bar[] = [];
    const openMs = Date.parse(m1.openTime);
    this.firstOpenMs ??= openMs;
    const w = barWindow(openMs, this.timeframe, this.hours);
    if (this.current && w.openMs !== this.current.openMs) this.finish(m1, done);
    if (!this.current) {
      this.current = {
        openMs: w.openMs,
        closeMs: w.closeMs,
        open: m1.open,
        high: m1.high,
        low: m1.low,
        close: m1.close,
        ticks: m1.tickCount,
        incomplete: w.openMs < this.firstOpenMs,
      };
    } else {
      this.current.high = Math.max(this.current.high, m1.high);
      this.current.low = Math.min(this.current.low, m1.low);
      this.current.close = m1.close;
      this.current.ticks += m1.tickCount;
    }
    if (Date.parse(m1.closeTime) >= this.current.closeMs) this.finish(m1, done);
    return done;
  }

  private finish(template: Bar, done: Bar[]): void {
    const c = this.current;
    this.current = null;
    if (!c || c.incomplete) return;
    done.push({
      symbol: template.symbol,
      timeframe: this.timeframe,
      openTime: new Date(c.openMs).toISOString(),
      closeTime: new Date(c.closeMs).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: null,
      tickCount: c.ticks,
      complete: true,
      source: template.source,
      sourceKind: template.sourceKind,
    });
  }
}
