/**
 * Incremental building blocks over CLOSED candles: timeframe aggregation, Wilder ATR and the
 * strict 5-candle swing (fractal) detector. Nothing here ever reads a candle that has not
 * closed, so a result at time t depends only on data up to t.
 */

export interface Candle {
  /** Period start, ISO UTC (inclusive). */
  readonly openTime: string;
  /** Period end, ISO UTC (exclusive). */
  readonly closeTime: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export const isUp = (c: Candle) => c.close > c.open;
export const isDown = (c: Candle) => c.close < c.open;
export const body = (c: Candle) => Math.abs(c.close - c.open);
export const range = (c: Candle) => c.high - c.low;

/**
 * Builds a coarser timeframe (M15, H1 — aligned to UTC epoch multiples) from closed M5 candles.
 * A period is emitted when its last M5 candle closes, or — if that candle is missing (a data
 * gap) — when the first candle of a later period arrives. Emission is never early.
 */
export class Aggregator {
  private current: { openMs: number; o: number; h: number; l: number; c: number } | null = null;

  constructor(private readonly periodMs: number) {}

  push(m5: Candle): Candle[] {
    const out: Candle[] = [];
    const openMs = Date.parse(m5.openTime);
    const start = Math.floor(openMs / this.periodMs) * this.periodMs;
    if (this.current && this.current.openMs !== start) {
      out.push(this.emit());
    }
    if (!this.current) {
      this.current = { openMs: start, o: m5.open, h: m5.high, l: m5.low, c: m5.close };
    } else {
      this.current.h = Math.max(this.current.h, m5.high);
      this.current.l = Math.min(this.current.l, m5.low);
      this.current.c = m5.close;
    }
    if (Date.parse(m5.closeTime) >= start + this.periodMs) out.push(this.emit());
    return out;
  }

  private emit(): Candle {
    const p = this.current!;
    this.current = null;
    return {
      openTime: new Date(p.openMs).toISOString(),
      closeTime: new Date(p.openMs + this.periodMs).toISOString(),
      open: p.o,
      high: p.h,
      low: p.l,
      close: p.c,
    };
  }
}

/** ATR with Wilder smoothing; null until `period + 1` candles (a true range needs the previous close). */
export class Atr {
  private prevClose: number | null = null;
  private seed: number[] = [];
  private current: number | null = null;

  constructor(private readonly period: number) {}

  get value(): number | null {
    return this.current;
  }

  push(c: Candle): void {
    if (this.prevClose !== null) {
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - this.prevClose),
        Math.abs(c.low - this.prevClose),
      );
      if (this.current === null) {
        this.seed.push(tr);
        if (this.seed.length === this.period) {
          this.current = this.seed.reduce((a, b) => a + b, 0) / this.period;
          this.seed = [];
        }
      } else {
        this.current = (this.current * (this.period - 1) + tr) / this.period;
      }
    }
    this.prevClose = c.close;
  }
}

export interface Swing {
  readonly kind: 'HIGH' | 'LOW';
  readonly price: number;
  /** Open time of the swing candle. */
  readonly time: string;
  /** Close time of the second candle to its right — when the swing became known. */
  readonly confirmedAt: string;
}

/**
 * Strict 5-candle fractal (SPEC): high[i] > high[i−1], high[i−2], high[i+1], high[i+2]; valid
 * only after the two right candles have closed. Lows mirror it.
 */
export class SwingDetector {
  private readonly last: Candle[] = [];

  push(c: Candle): Swing[] {
    this.last.push(c);
    if (this.last.length > 5) this.last.shift();
    if (this.last.length < 5) return [];
    const [a, b, m, d, e] = this.last as [Candle, Candle, Candle, Candle, Candle];
    const out: Swing[] = [];
    if (m.high > a.high && m.high > b.high && m.high > d.high && m.high > e.high)
      out.push({ kind: 'HIGH', price: m.high, time: m.openTime, confirmedAt: e.closeTime });
    if (m.low < a.low && m.low < b.low && m.low < d.low && m.low < e.low)
      out.push({ kind: 'LOW', price: m.low, time: m.openTime, confirmedAt: e.closeTime });
    return out;
  }
}
