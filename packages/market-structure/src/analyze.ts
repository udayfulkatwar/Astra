/**
 * Market structure from COMPLETE bars of one symbol and timeframe, in a single forward pass.
 *
 * No lookahead: every swing, break, sweep and gap is detected from bars that had closed at the
 * time it is reported (`confirmedAt` / `at`), so analysing a prefix of the bars reports exactly
 * the events of the full analysis up to that prefix's end. In-progress bars are ignored (nothing
 * repaints). Definitions (ADR-0010):
 *
 * - Swing high: a bar whose high is above the highs of the `swingStrength` bars before it and not
 *   below the highs of the `swingStrength` bars after it (the first of equal highs wins); known
 *   when the last of those later bars closes. Swing lows mirror this. Labels compare with the
 *   previous swing of the same kind: HH / LH / EQH, HL / LL / EQL (EQ within the equal-level
 *   tolerance at confirmation time).
 * - Break of structure: a bar CLOSES beyond the latest confirmed swing high (bullish) or low
 *   (bearish) that has not been broken yet. Against the prevailing trend it is a CHoCH (change of
 *   character), otherwise a BOS; the first break sets the trend.
 * - Liquidity: every confirmed swing level stays INTACT until price trades beyond it. A bar that
 *   trades beyond but closes back inside SWEEPS it; a close beyond BREAKS it. Intact swing highs
 *   (lows) within the equal-level tolerance form a buy-side (sell-side) liquidity pool.
 * - Fair value gap: three bars where the third's low is above the first's high (bullish) or the
 *   third's high is below the first's low (bearish), by at least `fvgMinTicks`. Later bars trading
 *   into the gap mitigate it (PARTIAL) until it is FILLED.
 */
import { AstraError } from '@astra/core';
import { ATR_PERIOD, type Bar, type Timeframe } from '@astra/market-data';
import { StructureParamsSchema, type StructureParams } from './params';

export type Trend = 'UP' | 'DOWN' | 'UNKNOWN';
export type SwingKind = 'HIGH' | 'LOW';
export type SwingLabel = 'HH' | 'LH' | 'EQH' | 'HL' | 'LL' | 'EQL';
export type LevelStatus = 'INTACT' | 'SWEPT' | 'BROKEN';
/** Buy-side liquidity rests above highs, sell-side below lows. */
export type LiquiditySide = 'BUY_SIDE' | 'SELL_SIDE';

export interface Swing {
  readonly kind: SwingKind;
  readonly price: number;
  /** Open time of the swing bar. */
  readonly time: string;
  /** Close time of the bar that confirmed it — when it became known. */
  readonly confirmedAt: string;
  /** Against the previous swing of the same kind; null for the first. */
  readonly label: SwingLabel | null;
  readonly status: LevelStatus;
  /** Close time of the bar that swept or broke it. */
  readonly resolvedAt: string | null;
}

export interface StructureBreak {
  readonly type: 'BOS' | 'CHOCH';
  readonly direction: 'BULLISH' | 'BEARISH';
  /** The swing level closed beyond. */
  readonly level: number;
  readonly swingTime: string;
  /** Close time of the breaking bar. */
  readonly at: string;
  readonly close: number;
  /** Trend before the break. */
  readonly from: Trend;
}

export interface LiquiditySweep {
  readonly side: LiquiditySide;
  readonly level: number;
  readonly swingTime: string;
  /** Close time of the sweeping bar. */
  readonly at: string;
  /** How far the wick went beyond the level. */
  readonly extreme: number;
  readonly close: number;
}

export interface LiquidityPool {
  readonly side: LiquiditySide;
  /** The outermost of the equal levels (stops rest beyond it). */
  readonly level: number;
  readonly swingTimes: string[];
}

export interface LiquidityTarget {
  readonly side: LiquiditySide;
  readonly level: number;
  readonly kind: 'SWING' | 'EQUAL_LEVELS';
  readonly swingTime: string;
}

export interface FairValueGap {
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly top: number;
  readonly bottom: number;
  /** Close time of the third bar. */
  readonly at: string;
  readonly status: 'OPEN' | 'PARTIAL' | 'FILLED';
  /** Deepest price traded back into the gap; null while untouched. */
  readonly mitigatedTo: number | null;
  readonly filledAt: string | null;
}

export interface MarketStructure {
  readonly symbol: string | null;
  readonly timeframe: Timeframe | null;
  /** Close time of the last complete bar analysed; null without bars. */
  readonly asOf: string | null;
  readonly barsAnalysed: number;
  /** False until there are enough bars for a swing (2 × swingStrength + 1). */
  readonly sufficient: boolean;
  readonly params: StructureParams;
  /** Equal-level tolerance at `asOf`, in price. */
  readonly equalTolerance: number;
  readonly trend: Trend;
  readonly lastClose: number | null;
  /** Most recent `maxItems` swings, oldest → newest. */
  readonly swings: Swing[];
  readonly lastSwingHigh: Swing | null;
  readonly lastSwingLow: Swing | null;
  readonly breaks: StructureBreak[];
  readonly lastBreak: StructureBreak | null;
  readonly sweeps: LiquiditySweep[];
  /** Intact equal highs / lows (two or more swings within tolerance). */
  readonly pools: LiquidityPool[];
  /** Nearest intact liquidity above / below the last close. */
  readonly nearestAbove: LiquidityTarget | null;
  readonly nearestBelow: LiquidityTarget | null;
  /** Unfilled gaps (OPEN / PARTIAL), most recent `maxItems`. */
  readonly fvgs: FairValueGap[];
}

export interface StructureInput {
  /** Bars of ONE symbol and timeframe, oldest → newest; the in-progress bar is ignored. */
  readonly bars: readonly Bar[];
  /** The series analysed (identifies the result even without bars; bars must match it). */
  readonly symbol?: string | undefined;
  readonly timeframe?: Timeframe | undefined;
  readonly tickSize: number;
  readonly params?: Partial<StructureParams> | undefined;
}

type MutableSwing = { -readonly [K in keyof Swing]: Swing[K] };
type MutableGap = { -readonly [K in keyof FairValueGap]: FairValueGap[K] };

/** Price difference in ticks, rounded to absorb binary floating-point noise (0.01 steps). */
function inTicks(diff: number, tickSize: number): number {
  return Math.round((diff / tickSize) * 1e6) / 1e6;
}

function validate(bars: readonly Bar[], symbol?: string, timeframe?: Timeframe): void {
  for (const b of bars) {
    if (
      (symbol !== undefined && b.symbol !== symbol) ||
      (timeframe !== undefined && b.timeframe !== timeframe)
    ) {
      throw new AstraError(
        'VALIDATION',
        `bar ${b.symbol} ${b.timeframe} ${b.openTime} does not belong to ${symbol ?? b.symbol} ${timeframe ?? b.timeframe}`,
      );
    }
  }
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    if (cur.symbol !== prev.symbol || cur.timeframe !== prev.timeframe) {
      throw new AstraError(
        'VALIDATION',
        `structure needs bars of one symbol and timeframe (got ${prev.symbol} ${prev.timeframe} and ${cur.symbol} ${cur.timeframe})`,
      );
    }
    if (Date.parse(cur.openTime) < Date.parse(prev.closeTime)) {
      throw new AstraError(
        'VALIDATION',
        `bars must be ordered and non-overlapping (${cur.openTime} starts before ${prev.closeTime})`,
      );
    }
  }
}

function label(
  kind: SwingKind,
  price: number,
  previous: MutableSwing | undefined,
  tolTicks: number,
  tick: number,
): SwingLabel | null {
  if (!previous) return null;
  const diff = inTicks(price - previous.price, tick);
  if (Math.abs(diff) <= tolTicks) return kind === 'HIGH' ? 'EQH' : 'EQL';
  if (kind === 'HIGH') return diff > 0 ? 'HH' : 'LH';
  return diff > 0 ? 'HL' : 'LL';
}

/** Clusters intact levels of one side whose neighbours are within the tolerance. */
function pools(
  levels: readonly MutableSwing[],
  side: LiquiditySide,
  tolTicks: number,
  tick: number,
): LiquidityPool[] {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const out: LiquidityPool[] = [];
  let group: MutableSwing[] = [];
  const flush = () => {
    if (group.length >= 2) {
      const prices = group.map((s) => s.price);
      out.push({
        side,
        level: side === 'BUY_SIDE' ? Math.max(...prices) : Math.min(...prices),
        swingTimes: group.map((s) => s.time).sort(),
      });
    }
    group = [];
  };
  for (const s of sorted) {
    const last = group.at(-1);
    if (last && inTicks(s.price - last.price, tick) > tolTicks) flush();
    group.push(s);
  }
  flush();
  return out;
}

export function analyzeStructure(input: StructureInput): MarketStructure {
  const params = StructureParamsSchema.parse(input.params ?? {});
  const tick = input.tickSize;
  if (!(tick > 0) || !Number.isFinite(tick)) {
    throw new AstraError('VALIDATION', 'tickSize must be a positive number');
  }
  const bars = input.bars.filter((b) => b.complete);
  validate(bars, input.symbol, input.timeframe);
  const n = params.swingStrength;

  let trend: Trend = 'UNKNOWN';
  let breakHigh: MutableSwing | null = null;
  let breakLow: MutableSwing | null = null;
  const swings: MutableSwing[] = [];
  const intactHighs: MutableSwing[] = [];
  const intactLows: MutableSwing[] = [];
  const breaks: StructureBreak[] = [];
  const sweeps: LiquiditySweep[] = [];
  const gaps: MutableGap[] = [];
  let lastHigh: MutableSwing | undefined;
  let lastLow: MutableSwing | undefined;

  // Wilder ATR(14) up to the current bar (the tolerance must not use later bars).
  let atr: number | null = null;
  let trSum = 0;
  let trCount = 0;
  const tolTicks = () =>
    Math.max(
      params.equalLevelTicks,
      atr === null ? 0 : inTicks(params.equalLevelAtrFraction * atr, tick),
    );

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const at = bar.closeTime;

    if (i > 0) {
      const pc = bars[i - 1]!.close;
      const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc));
      trCount++;
      if (atr === null) {
        trSum += tr;
        if (trCount === ATR_PERIOD) atr = trSum / ATR_PERIOD;
      } else {
        atr = (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
      }
    }

    // 1. Liquidity: levels confirmed before this bar that it trades beyond.
    for (let k = intactHighs.length - 1; k >= 0; k--) {
      const s = intactHighs[k]!;
      if (bar.high <= s.price) continue;
      intactHighs.splice(k, 1);
      s.resolvedAt = at;
      if (bar.close > s.price) {
        s.status = 'BROKEN';
      } else {
        s.status = 'SWEPT';
        sweeps.push({
          side: 'BUY_SIDE',
          level: s.price,
          swingTime: s.time,
          at,
          extreme: bar.high,
          close: bar.close,
        });
      }
    }
    for (let k = intactLows.length - 1; k >= 0; k--) {
      const s = intactLows[k]!;
      if (bar.low >= s.price) continue;
      intactLows.splice(k, 1);
      s.resolvedAt = at;
      if (bar.close < s.price) {
        s.status = 'BROKEN';
      } else {
        s.status = 'SWEPT';
        sweeps.push({
          side: 'SELL_SIDE',
          level: s.price,
          swingTime: s.time,
          at,
          extreme: bar.low,
          close: bar.close,
        });
      }
    }

    // 2. Structure: closes beyond the latest unbroken swing.
    if (breakHigh && bar.close > breakHigh.price) {
      breaks.push({
        type: trend === 'DOWN' ? 'CHOCH' : 'BOS',
        direction: 'BULLISH',
        level: breakHigh.price,
        swingTime: breakHigh.time,
        at,
        close: bar.close,
        from: trend,
      });
      trend = 'UP';
      breakHigh = null;
    }
    if (breakLow && bar.close < breakLow.price) {
      breaks.push({
        type: trend === 'UP' ? 'CHOCH' : 'BOS',
        direction: 'BEARISH',
        level: breakLow.price,
        swingTime: breakLow.time,
        at,
        close: bar.close,
        from: trend,
      });
      trend = 'DOWN';
      breakLow = null;
    }

    // 3. Fair value gaps: mitigation of earlier gaps, then a gap closing with this bar.
    for (const g of gaps) {
      if (g.status === 'FILLED') continue;
      if (g.direction === 'BULLISH' && bar.low < g.top) {
        g.mitigatedTo = Math.min(g.mitigatedTo ?? g.top, bar.low);
        if (bar.low <= g.bottom) {
          g.status = 'FILLED';
          g.filledAt = at;
        } else g.status = 'PARTIAL';
      } else if (g.direction === 'BEARISH' && bar.high > g.bottom) {
        g.mitigatedTo = Math.max(g.mitigatedTo ?? g.bottom, bar.high);
        if (bar.high >= g.top) {
          g.status = 'FILLED';
          g.filledAt = at;
        } else g.status = 'PARTIAL';
      }
    }
    if (i >= 2) {
      const a = bars[i - 2]!;
      if (inTicks(bar.low - a.high, tick) >= params.fvgMinTicks) {
        gaps.push({
          direction: 'BULLISH',
          bottom: a.high,
          top: bar.low,
          at,
          status: 'OPEN',
          mitigatedTo: null,
          filledAt: null,
        });
      } else if (inTicks(a.low - bar.high, tick) >= params.fvgMinTicks) {
        gaps.push({
          direction: 'BEARISH',
          bottom: bar.high,
          top: a.low,
          at,
          status: 'OPEN',
          mitigatedTo: null,
          filledAt: null,
        });
      }
    }

    // 4. Swings confirmed by this bar's close (the candidate is `swingStrength` bars back).
    const c = i - n;
    if (c >= n) {
      const cand = bars[c]!;
      let isHigh = true;
      let isLow = true;
      for (let j = c - n; j <= i; j++) {
        if (j === c) continue;
        const o = bars[j]!;
        if (j < c ? o.high >= cand.high : o.high > cand.high) isHigh = false;
        if (j < c ? o.low <= cand.low : o.low < cand.low) isLow = false;
      }
      if (isHigh) {
        const s: MutableSwing = {
          kind: 'HIGH',
          price: cand.high,
          time: cand.openTime,
          confirmedAt: at,
          label: label('HIGH', cand.high, lastHigh, tolTicks(), tick),
          status: 'INTACT',
          resolvedAt: null,
        };
        swings.push(s);
        intactHighs.push(s);
        lastHigh = s;
        breakHigh = s;
      }
      if (isLow) {
        const s: MutableSwing = {
          kind: 'LOW',
          price: cand.low,
          time: cand.openTime,
          confirmedAt: at,
          label: label('LOW', cand.low, lastLow, tolTicks(), tick),
          status: 'INTACT',
          resolvedAt: null,
        };
        swings.push(s);
        intactLows.push(s);
        lastLow = s;
        breakLow = s;
      }
    }
  }

  const last = bars.at(-1);
  const lastClose = last?.close ?? null;
  const tol = tolTicks();
  const poolList = [
    ...pools(intactHighs, 'BUY_SIDE', tol, tick),
    ...pools(intactLows, 'SELL_SIDE', tol, tick),
  ];
  const inPool = (s: MutableSwing) =>
    poolList.some(
      (p) =>
        p.side === (s.kind === 'HIGH' ? 'BUY_SIDE' : 'SELL_SIDE') && p.swingTimes.includes(s.time),
    );
  const target = (s: MutableSwing | undefined): LiquidityTarget | null =>
    s
      ? {
          side: s.kind === 'HIGH' ? 'BUY_SIDE' : 'SELL_SIDE',
          level: s.price,
          kind: inPool(s) ? 'EQUAL_LEVELS' : 'SWING',
          swingTime: s.time,
        }
      : null;
  const above =
    lastClose === null
      ? undefined
      : intactHighs.filter((s) => s.price >= lastClose).sort((a, b) => a.price - b.price)[0];
  const below =
    lastClose === null
      ? undefined
      : intactLows.filter((s) => s.price <= lastClose).sort((a, b) => b.price - a.price)[0];

  const recent = <T>(list: readonly T[]): T[] =>
    list.slice(-params.maxItems).map((x) => ({ ...x }));
  const frozen = (s: MutableSwing | undefined): Swing | null => (s ? { ...s } : null);

  return {
    symbol: input.symbol ?? last?.symbol ?? null,
    timeframe: input.timeframe ?? last?.timeframe ?? null,
    asOf: last?.closeTime ?? null,
    barsAnalysed: bars.length,
    sufficient: bars.length >= 2 * n + 1,
    params,
    equalTolerance: Math.round(tol * tick * 1e8) / 1e8,
    trend,
    lastClose,
    swings: recent(swings),
    lastSwingHigh: frozen(lastHigh),
    lastSwingLow: frozen(lastLow),
    breaks: recent(breaks),
    lastBreak: breaks.at(-1) ?? null,
    sweeps: recent(sweeps),
    pools: poolList,
    nearestAbove: target(above),
    nearestBelow: target(below),
    fvgs: recent(gaps.filter((g) => g.status !== 'FILLED')),
  };
}
