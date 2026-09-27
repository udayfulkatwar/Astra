/**
 * Builds OHLC bars from observed prices, per series (symbol × source) and timeframe.
 *
 * Invariants (no fabrication):
 * - A bar exists only for a period in which at least one price was observed. Gaps stay gaps:
 *   no bar is ever synthesised for a period without prices (no carry-forward).
 * - A bar whose period began before continuous observation started (`observingSinceMs`, i.e.
 *   process start) is INCOMPLETE — its open/high/low would misrepresent the period — so it is
 *   tracked only to keep ordering and is discarded, never emitted, stored or displayed.
 * - Prices older than the start of the current bar (or the end of the last completed bar) are
 *   out of order: ignored and counted, never merged into an already-finished period.
 * - Each window keeps at most `maxBars` completed bars (oldest evicted first).
 */
import type { DataSourceKind, TradingHours } from '@astra/core';
import type { Bar } from './bar';
import { TIMEFRAMES, barWindow, type BarWindow, type Timeframe } from './timeframe';

export interface PriceTick {
  readonly symbol: string;
  /** Price basis: last trade if present, otherwise mid. */
  readonly price: number;
  /** Source timestamp (epoch ms). */
  readonly atMs: number;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
}

export interface BarAggregatorOptions {
  /** Trading hours per symbol (D1 alignment); undefined → UTC midnight. */
  readonly tradingHours: (symbol: string) => TradingHours | undefined;
  readonly timeframes?: readonly Timeframe[];
  /** Completed bars kept per series and timeframe (default 1000). */
  readonly maxBars?: number;
  /** Continuous observation began here (epoch ms); earlier-opening bars are incomplete. */
  readonly observingSinceMs?: number;
  /** Called for every completed (and complete-coverage) bar. */
  readonly onBar?: (bar: Bar) => void;
}

export type TickOutcome =
  | { readonly accepted: true; readonly completed: readonly Bar[] }
  | { readonly accepted: false; readonly reason: string };

export interface AggregatorStats {
  /** Prices ignored because they were older than the current bar start. */
  readonly outOfOrder: number;
  /** Bars discarded because observation started after their period began. */
  readonly incompleteDiscarded: number;
  /** Seed bars rejected (not complete, misaligned, duplicate source kind conflict). */
  readonly seedRejected: number;
}

interface WorkingBar {
  readonly openMs: number;
  readonly closeMs: number;
  readonly open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
  lastTickMs: number;
  /** Period began before observation started → discarded when it ends. */
  readonly incomplete: boolean;
}

interface Frame {
  current: WorkingBar | null;
  /** Completed bars, oldest → newest. */
  completed: Bar[];
  /** Close time of the newest completed (or seeded, or discarded) bar. */
  lastCloseMs: number;
  /** Close time of the newest bar evicted from the window. */
  evictedUntilMs: number;
}

interface Series {
  readonly symbol: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  readonly frames: Map<Timeframe, Frame>;
}

export const DEFAULT_MAX_BARS = 1_000;

export class BarAggregator {
  private readonly series = new Map<string, Map<string, Series>>();
  private readonly timeframes: readonly Timeframe[];
  private readonly maxBars: number;
  private readonly observingSinceMs: number;
  private outOfOrder = 0;
  private incompleteDiscarded = 0;
  private seedRejected = 0;

  constructor(private readonly opts: BarAggregatorOptions) {
    this.timeframes = opts.timeframes ?? TIMEFRAMES;
    this.maxBars = opts.maxBars ?? DEFAULT_MAX_BARS;
    this.observingSinceMs = opts.observingSinceMs ?? Number.NEGATIVE_INFINITY;
  }

  /** Adds one observed price; returns the bars it completed. */
  ingest(tick: PriceTick): TickOutcome {
    if (!(tick.price > 0) || !Number.isFinite(tick.price) || !Number.isFinite(tick.atMs)) {
      return { accepted: false, reason: 'price must be a positive finite number' };
    }
    const s = this.seriesFor(tick.symbol, tick.source, tick.sourceKind);
    if (s.sourceKind !== tick.sourceKind) {
      return {
        accepted: false,
        reason: `source ${tick.source} already delivered ${s.sourceKind} data, not ${tick.sourceKind}`,
      };
    }
    const floor = this.floorMs(s);
    if (tick.atMs < floor) {
      this.outOfOrder++;
      return {
        accepted: false,
        reason: `out of order: ${new Date(tick.atMs).toISOString()} is before the current bar start ${new Date(floor).toISOString()}`,
      };
    }
    const hours = this.opts.tradingHours(tick.symbol);
    const completed: Bar[] = [];
    for (const [tf, frame] of s.frames) {
      // Fast path: a price inside the current bar's period (the common case) needs no window
      // computation — the D1 window is a time-zone calculation, costly on every quote.
      const open = frame.current;
      const w: BarWindow =
        open && tick.atMs >= open.openMs && tick.atMs < open.closeMs
          ? open
          : barWindow(tick.atMs, tf, hours);
      if (frame.current && w.openMs >= frame.current.closeMs) {
        const done = this.finish(s, tf, frame);
        if (done) completed.push(done);
      }
      const cur = frame.current;
      if (!cur) {
        frame.current = {
          openMs: w.openMs,
          closeMs: w.closeMs,
          open: tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
          tickCount: 1,
          lastTickMs: tick.atMs,
          incomplete: w.openMs < this.observingSinceMs,
        };
        continue;
      }
      cur.high = Math.max(cur.high, tick.price);
      cur.low = Math.min(cur.low, tick.price);
      cur.tickCount++;
      // A late price inside the bar still counts for high/low; only the newest sets the close.
      if (tick.atMs >= cur.lastTickMs) {
        cur.close = tick.price;
        cur.lastTickMs = tick.atMs;
      }
    }
    return { accepted: true, completed };
  }

  /**
   * Completes every in-progress bar whose period ended at least `graceMs` before `nowMs`, so bars
   * finish even when no further price arrives (e.g. before a market break).
   */
  advance(nowMs: number, graceMs = 0): Bar[] {
    const completed: Bar[] = [];
    for (const bySource of this.series.values()) {
      for (const s of bySource.values()) {
        for (const [tf, frame] of s.frames) {
          if (frame.current && frame.current.closeMs + graceMs <= nowMs) {
            const done = this.finish(s, tf, frame);
            if (done) completed.push(done);
          }
        }
      }
    }
    return completed;
  }

  /**
   * Warm-up with historical COMPLETED bars (e.g. from the database). Bars that are incomplete,
   * misaligned with the current timeframe definition, of an unconfigured timeframe, or whose
   * source already delivered another source kind are rejected and counted. Existing bars win on
   * duplicates. Returns the number of bars added.
   */
  seed(bars: readonly Bar[]): number {
    let added = 0;
    const known = new Map<Frame, Set<number>>();
    const sorted = [...bars].sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
    for (const bar of sorted) {
      const openMs = Date.parse(bar.openTime);
      const closeMs = Date.parse(bar.closeTime);
      const w = barWindow(openMs, bar.timeframe, this.opts.tradingHours(bar.symbol));
      const s = this.seriesFor(bar.symbol, bar.source, bar.sourceKind);
      const frame = s.frames.get(bar.timeframe);
      let seen = frame ? known.get(frame) : undefined;
      if (frame && !seen) {
        seen = new Set(frame.completed.map((b) => Date.parse(b.openTime)));
        known.set(frame, seen);
      }
      if (
        !bar.complete ||
        !frame ||
        !seen ||
        s.sourceKind !== bar.sourceKind ||
        w.openMs !== openMs ||
        w.closeMs !== closeMs ||
        (frame.current !== null && closeMs > frame.current.openMs) ||
        seen.has(openMs)
      ) {
        this.seedRejected++;
        continue;
      }
      // Normalised timestamps: every bar in a window uses the same ISO form.
      frame.completed.push({
        ...bar,
        openTime: new Date(openMs).toISOString(),
        closeTime: new Date(closeMs).toISOString(),
      });
      seen.add(openMs);
      frame.lastCloseMs = Math.max(frame.lastCloseMs, closeMs);
      added++;
    }
    for (const bySource of this.series.values()) {
      for (const s of bySource.values()) {
        for (const frame of s.frames.values()) {
          frame.completed.sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
          this.trim(frame);
        }
      }
    }
    return added;
  }

  /**
   * Bars of one series, oldest → newest. With `includeCurrent`, the in-progress bar (complete:
   * false) is appended — unless it is incomplete (observation started mid-period).
   */
  bars(
    symbol: string,
    source: string,
    timeframe: Timeframe,
    opts: { includeCurrent?: boolean } = {},
  ): Bar[] {
    const s = this.series.get(symbol)?.get(source);
    const frame = s?.frames.get(timeframe);
    if (!s || !frame) return [];
    const out = [...frame.completed];
    if (opts.includeCurrent && frame.current && !frame.current.incomplete) {
      out.push(toBar(s, timeframe, frame.current, false));
    }
    return out;
  }

  /** Sources with a series for `symbol`. */
  sources(symbol: string): string[] {
    return [...(this.series.get(symbol)?.keys() ?? [])];
  }

  /** Most recent activity of a series (latest price or completed bar close), epoch ms. */
  lastActivityMs(symbol: string, source: string): number | null {
    const s = this.series.get(symbol)?.get(source);
    if (!s) return null;
    let latest = Number.NEGATIVE_INFINITY;
    for (const f of s.frames.values()) {
      latest = Math.max(latest, f.current?.lastTickMs ?? f.lastCloseMs);
    }
    return Number.isFinite(latest) ? latest : null;
  }

  /**
   * Instant from which the window of a series holds every observed bar: observation start, or
   * later if older bars were evicted. Null when the series does not exist.
   */
  coverageFromMs(symbol: string, source: string, timeframe: Timeframe): number | null {
    const frame = this.series.get(symbol)?.get(source)?.frames.get(timeframe);
    if (!frame) return null;
    return Math.max(this.observingSinceMs, frame.evictedUntilMs);
  }

  stats(): AggregatorStats {
    return {
      outOfOrder: this.outOfOrder,
      incompleteDiscarded: this.incompleteDiscarded,
      seedRejected: this.seedRejected,
    };
  }

  private seriesFor(symbol: string, source: string, sourceKind: DataSourceKind): Series {
    let bySource = this.series.get(symbol);
    if (!bySource) {
      bySource = new Map();
      this.series.set(symbol, bySource);
    }
    let s = bySource.get(source);
    if (!s) {
      const frames = new Map<Timeframe, Frame>();
      for (const tf of this.timeframes) {
        frames.set(tf, {
          current: null,
          completed: [],
          lastCloseMs: Number.NEGATIVE_INFINITY,
          evictedUntilMs: Number.NEGATIVE_INFINITY,
        });
      }
      s = { symbol, source, sourceKind, frames };
      bySource.set(source, s);
    }
    return s;
  }

  /** Prices before this instant belong to finished periods. */
  private floorMs(s: Series): number {
    let floor = Number.NEGATIVE_INFINITY;
    for (const f of s.frames.values()) {
      floor = Math.max(floor, f.current ? f.current.openMs : f.lastCloseMs);
    }
    return floor;
  }

  private finish(s: Series, tf: Timeframe, frame: Frame): Bar | null {
    const w = frame.current;
    if (!w) return null;
    frame.current = null;
    frame.lastCloseMs = Math.max(frame.lastCloseMs, w.closeMs);
    if (w.incomplete) {
      this.incompleteDiscarded++;
      return null;
    }
    const bar = toBar(s, tf, w, true);
    frame.completed.push(bar);
    this.trim(frame);
    this.opts.onBar?.(bar);
    return bar;
  }

  private trim(frame: Frame): void {
    while (frame.completed.length > this.maxBars) {
      const evicted = frame.completed.shift()!;
      frame.evictedUntilMs = Math.max(frame.evictedUntilMs, Date.parse(evicted.closeTime));
    }
  }
}

function toBar(s: Series, timeframe: Timeframe, w: WorkingBar, complete: boolean): Bar {
  return {
    symbol: s.symbol,
    timeframe,
    openTime: new Date(w.openMs).toISOString(),
    closeTime: new Date(w.closeMs).toISOString(),
    open: w.open,
    high: w.high,
    low: w.low,
    close: w.close,
    volume: null,
    tickCount: w.tickCount,
    complete,
    source: s.source,
    sourceKind: s.sourceKind,
  };
}
