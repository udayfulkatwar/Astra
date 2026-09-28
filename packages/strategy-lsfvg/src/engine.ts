/**
 * LSFVG v1.0 engine for ONE pair, fed closed M5 candles in time order. It builds M15 and H1 from
 * them and follows the SPEC's core sequence:
 *
 *   STRUCTURE (H1 bias) → LIQUIDITY → SWEEP → DISPLACEMENT → CHoCH/BOS → FVG → (RETRACEMENT)
 *
 * LONG (SHORT is the mirror image):
 * 1. Sell-side liquidity below price — previous day's low, Asian low, unswept M15 swing lows,
 *    equal lows (|l1 − l2| ≤ 0.10 × M15 ATR, ≥ 2 swings) — is traded through (low < level).
 * 2. A close back above the level on the sweep candle or within the next 2 M15 candles.
 * 3. A bullish displacement candle (body ≥ 0.60 × range and ≥ 0.80 × M15 ATR) that CLOSES above
 *    the most recent M15 swing high confirmed before the sweep (CHoCH if that high was a lower
 *    high, BOS otherwise), within 6 M15 candles of the sweep. A new low under the sweep kills it.
 * 4. A bullish FVG around that displacement: high[c1] < low[c3], c2 = the displacement.
 * 5. At the close of c3, with the H1 bias BULLISH: entry = the FVG midpoint (LIMIT, waits at most
 *    12 M5 candles), stop = sweep low − 0.10 × M5 ATR, target = 2R (Model A) or the nearest
 *    buy-side liquidity giving ≥ 2R (Model B; none → no trade).
 *
 * The engine never sees the future: every level, swing, ATR and bias it uses was known when the
 * candle being evaluated opened (or, for the candle itself, when it closed). It decides nothing:
 * a SETUP is a signal for ASTRA's gate, which sizes, checks and may refuse it.
 */
import { ceilToStep, dec, floorToStep, toNum, tradingDayWindow } from '@astra/core';
import { assessBias, type BiasAssessment } from './bias';
import {
  LsfvgParamsSchema,
  MAX_SCORE,
  SCORE,
  type LsfvgParams,
  type LsfvgParamsInput,
} from './params';
import {
  Aggregator,
  Atr,
  SwingDetector,
  body,
  isDown,
  isUp,
  range,
  type Candle,
  type Swing,
} from './series';

export type Direction = 'LONG' | 'SHORT';
export type LiquidityType = 'PREVIOUS_DAY' | 'ASIAN' | 'EQUAL' | 'SWING';
export type Side = 'SELL_SIDE' | 'BUY_SIDE';

export interface LiquidityLevel {
  readonly type: LiquidityType;
  /** SELL_SIDE: lows (taken by a LONG setup's sweep); BUY_SIDE: highs. */
  readonly side: Side;
  readonly price: number;
  /** When the level became known. */
  readonly formedAt: string;
}

/** PDL / PDH, ASIAN_LOW / ASIAN_HIGH, EQUAL_LOWS / EQUAL_HIGHS, SWING_LOW / SWING_HIGH. */
export function liquidityName(l: Pick<LiquidityLevel, 'type' | 'side'>): string {
  const low = l.side === 'SELL_SIDE';
  switch (l.type) {
    case 'PREVIOUS_DAY':
      return low ? 'PDL' : 'PDH';
    case 'ASIAN':
      return low ? 'ASIAN_LOW' : 'ASIAN_HIGH';
    case 'EQUAL':
      return low ? 'EQUAL_LOWS' : 'EQUAL_HIGHS';
    case 'SWING':
      return low ? 'SWING_LOW' : 'SWING_HIGH';
  }
}

const PRIORITY: Record<LiquidityType, number> = { PREVIOUS_DAY: 0, ASIAN: 1, EQUAL: 2, SWING: 3 };
/** "Strong PD / session liquidity" in the SPEC's score. */
const STRONG: ReadonlySet<LiquidityType> = new Set(['PREVIOUS_DAY', 'ASIAN']);

export interface LsfvgSetup {
  readonly id: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly model: 'A' | 'B';
  /** Close of the FVG's third candle: the moment the setup became complete. */
  readonly detectedAt: string;
  /** The LIMIT entry is cancelled at this time if not filled (a missed setup is no trade). */
  readonly expiresAt: string;
  readonly h1Bias: BiasAssessment;
  /** The level whose sweep started the setup (and every level the sweep took). */
  readonly liquidity: LiquidityLevel & { readonly name: string; readonly strong: boolean };
  readonly sweptLevels: readonly (LiquidityLevel & { readonly name: string })[];
  readonly sweep: {
    readonly candleTime: string;
    /** Sweep low (LONG) / high (SHORT) — also the invalidation level. */
    readonly extreme: number;
    readonly reclaimedAt: string;
  };
  readonly structure: {
    readonly kind: 'CHOCH' | 'BOS';
    readonly swingPrice: number;
    readonly swingTime: string;
    readonly brokenAt: string;
  };
  readonly displacement: {
    readonly candleTime: string;
    readonly body: number;
    readonly range: number;
    readonly atrM15: number;
    readonly bodyToRange: number;
    readonly bodyToAtr: number;
  };
  readonly fvg: {
    readonly low: number;
    readonly high: number;
    readonly c1Time: string;
    readonly c3Time: string;
  };
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  /** FIXED_RR (Model A) or the liquidity level targeted (Model B). */
  readonly targetSource: string;
  readonly rewardToRisk: number;
  readonly atrM5: number;
  readonly score: {
    readonly total: number;
    readonly max: number;
    /** The retracement (+2) is scored when the LIMIT fills. */
    readonly retracePending: true;
    readonly components: Readonly<Record<keyof typeof SCORE, number>>;
  };
  readonly rationale: readonly string[];
}

/** The structure of a complete sequence (a setup, or a rejected one). */
export type LsfvgStructure = Pick<
  LsfvgSetup,
  | 'symbol'
  | 'direction'
  | 'model'
  | 'detectedAt'
  | 'h1Bias'
  | 'liquidity'
  | 'sweptLevels'
  | 'sweep'
  | 'structure'
  | 'displacement'
  | 'fvg'
>;

export type LsfvgRejectStage = 'BIAS' | 'TARGET' | 'REWARD_TO_RISK' | 'DATA';

export interface LsfvgRejection {
  readonly symbol: string;
  readonly direction: Direction;
  readonly at: string;
  readonly stage: LsfvgRejectStage;
  readonly reason: string;
  /** The complete structure that was rejected (for the §26 record). */
  readonly partial: LsfvgStructure;
}

export type LsfvgEvent =
  | { readonly kind: 'SETUP'; readonly setup: LsfvgSetup }
  | { readonly kind: 'REJECTED'; readonly rejection: LsfvgRejection }
  /** An M5 candle closed beyond the sweep extreme before the entry window ended: cancel. */
  | {
      readonly kind: 'INVALIDATED';
      readonly setupId: string;
      readonly at: string;
      readonly reason: string;
    };

/** How many candidates reached each step (the strategy's funnel, for research). */
export interface LsfvgCounters {
  m5Candles: number;
  m15Candles: number;
  sweeps: number;
  reclaims: number;
  displacements: number;
  fvgs: number;
  noFvg: number;
  setups: number;
  rejectedBias: number;
  rejectedTarget: number;
  rejectedRewardToRisk: number;
  rejectedData: number;
  invalidated: number;
}

interface MutableLevel extends LiquidityLevel {
  swept: boolean;
}

interface Indexed extends Candle {
  readonly i: number;
}

interface Pattern {
  readonly direction: Direction;
  level: MutableLevel;
  levels: MutableLevel[];
  readonly sweepIndex: number;
  readonly sweepTime: string;
  extreme: number;
  reclaimIndex: number | null;
  reclaimTime: string | null;
  readonly ref: { price: number; time: string; kind: 'CHOCH' | 'BOS' };
  displacement: { index: number; candle: Candle; atr: number } | null;
}

interface Active {
  readonly id: string;
  readonly direction: Direction;
  readonly invalidation: number;
  readonly detectedAtMs: number;
  seen: number;
}

const HOUR = 3_600_000;
const M15 = 900_000;
const M5 = 300_000;

export class LsfvgEngine {
  readonly params: LsfvgParams;
  readonly counters: LsfvgCounters = {
    m5Candles: 0,
    m15Candles: 0,
    sweeps: 0,
    reclaims: 0,
    displacements: 0,
    fvgs: 0,
    noFvg: 0,
    setups: 0,
    rejectedBias: 0,
    rejectedTarget: 0,
    rejectedRewardToRisk: 0,
    rejectedData: 0,
    invalidated: 0,
  };

  private readonly tick;
  private readonly m15 = new Aggregator(M15);
  private readonly h1 = new Aggregator(HOUR);
  private readonly atrM5: Atr;
  private readonly atrM15: Atr;
  private readonly h1Swings = new SwingDetector();
  private readonly m15Swings = new SwingDetector();
  private readonly h1Highs: Swing[] = [];
  private readonly h1Lows: Swing[] = [];
  private lastH1Close: number | null = null;
  private readonly m15Highs: Swing[] = [];
  private readonly m15Lows: Swing[] = [];
  private readonly history: Indexed[] = [];
  private m15Index = 0;
  private swingLevels: MutableLevel[] = [];
  private day: { key: string; end: string; high: number; low: number } | null = null;
  private prevDay: { high: MutableLevel; low: MutableLevel } | null = null;
  private asian: {
    date: string;
    high: number;
    low: number;
    count: number;
    levels: { high: MutableLevel; low: MutableLevel } | null;
  } | null = null;
  private readonly patterns: Record<Direction, Pattern | null> = { LONG: null, SHORT: null };
  private active: Active[] = [];
  private lastOpenMs = -Infinity;

  constructor(
    readonly symbol: string,
    tickSize: number,
    params: LsfvgParamsInput,
  ) {
    this.params = LsfvgParamsSchema.parse(params);
    if (!(tickSize > 0)) throw new Error('tickSize must be positive');
    this.tick = dec(tickSize);
    this.atrM5 = new Atr(this.params.atrPeriod);
    this.atrM15 = new Atr(this.params.atrPeriod);
  }

  /** Feed one CLOSED M5 candle (strictly after the previous one). */
  onM5(m5: Candle): LsfvgEvent[] {
    const openMs = Date.parse(m5.openTime);
    if (!(openMs > this.lastOpenMs)) throw new Error(`M5 candles out of order at ${m5.openTime}`);
    if (Date.parse(m5.closeTime) - openMs !== M5)
      throw new Error(`not an M5 candle: ${m5.openTime}`);
    this.lastOpenMs = openMs;
    this.counters.m5Candles++;
    this.atrM5.push(m5);
    const events: LsfvgEvent[] = [];

    // Open setups: an M5 close beyond the sweep extreme invalidates; the window ends after N candles.
    const still: Active[] = [];
    for (const a of this.active) {
      if (openMs < a.detectedAtMs) {
        still.push(a);
        continue;
      }
      a.seen++;
      const beyond = a.direction === 'LONG' ? m5.close < a.invalidation : m5.close > a.invalidation;
      if (beyond) {
        this.counters.invalidated++;
        events.push({
          kind: 'INVALIDATED',
          setupId: a.id,
          at: m5.closeTime,
          reason: `M5 closed ${a.direction === 'LONG' ? 'below' : 'above'} the sweep ${a.direction === 'LONG' ? 'low' : 'high'} ${a.invalidation} before the entry`,
        });
      } else if (a.seen < this.params.entryWaitM5Candles) {
        still.push(a);
      }
    }
    this.active = still;

    for (const h of this.h1.push(m5)) this.onH1(h);
    for (const c of this.m15.push(m5)) events.push(...this.onM15(c));
    return events;
  }

  /** The current H1 bias (for monitoring). */
  bias(): BiasAssessment {
    return assessBias(this.h1Highs, this.h1Lows, this.lastH1Close);
  }

  private onH1(h: Candle): void {
    for (const s of this.h1Swings.push(h)) {
      const list = s.kind === 'HIGH' ? this.h1Highs : this.h1Lows;
      list.push(s);
      if (list.length > 20) list.shift();
    }
    this.lastH1Close = h.close;
  }

  private onM15(candle: Candle): LsfvgEvent[] {
    this.counters.m15Candles++;
    const i = ++this.m15Index;
    const c: Indexed = { ...candle, i };
    this.history.push(c);
    if (this.history.length > 10) this.history.shift();
    const atrPrev = this.atrM15.value;
    const events: LsfvgEvent[] = [];

    this.rollDay(c);
    this.rollAsian(c);

    for (const dir of ['LONG', 'SHORT'] as const) {
      const e = this.advance(dir, c, atrPrev);
      if (e) events.push(e);
    }

    // Liquidity taken by this candle (known before it opened, not yet swept).
    const sell = this.levels('SELL_SIDE', c.openTime, atrPrev).filter((l) => c.low < l.price);
    const buy = this.levels('BUY_SIDE', c.openTime, atrPrev).filter((l) => c.high > l.price);
    if (sell.length > 0) this.sweep('LONG', sell, c, atrPrev);
    if (buy.length > 0) this.sweep('SHORT', buy, c, atrPrev);
    for (const l of [...sell, ...buy]) l.swept = true;
    for (const l of this.swingLevels) {
      if (!l.swept && (l.side === 'SELL_SIDE' ? c.low < l.price : c.high > l.price)) l.swept = true;
    }

    this.accumulate(c);
    for (const s of this.m15Swings.push(c)) {
      const list = s.kind === 'HIGH' ? this.m15Highs : this.m15Lows;
      list.push(s);
      if (list.length > 50) list.shift();
      this.swingLevels.push({
        type: 'SWING',
        side: s.kind === 'HIGH' ? 'BUY_SIDE' : 'SELL_SIDE',
        price: s.price,
        formedAt: s.confirmedAt,
        swept: false,
      });
    }
    this.swingLevels = this.swingLevels.filter((l) => !l.swept).slice(-this.params.maxSwingLevels);
    this.atrM15.push(c);
    return events;
  }

  /** Unswept levels on one side, known at `asOf`; equal-level clusters derived from swing levels. */
  private levels(side: Side, asOf: string, atr: number | null): MutableLevel[] {
    const t = Date.parse(asOf);
    const known = (l: MutableLevel) => !l.swept && Date.parse(l.formedAt) <= t;
    const low = side === 'SELL_SIDE';
    const out: MutableLevel[] = [];
    if (this.prevDay) {
      const l = low ? this.prevDay.low : this.prevDay.high;
      if (known(l)) out.push(l);
    }
    const a = this.asian?.levels;
    if (a) {
      const l = low ? a.low : a.high;
      if (known(l)) out.push(l);
    }
    const swings = this.swingLevels.filter((l) => l.side === side && known(l));
    out.push(...swings);
    // Equal lows / highs: ≥ 2 swings within 0.10 × M15 ATR of each other (every pair).
    if (atr !== null && swings.length >= 2) {
      const tol = this.params.equalLevelAtrFraction * atr;
      const sorted = [...swings].sort((x, y) => x.price - y.price);
      let group: MutableLevel[] = [sorted[0]!];
      const flush = () => {
        if (group.length >= 2) {
          const prices = group.map((g) => g.price);
          out.push({
            type: 'EQUAL',
            side,
            price: low ? Math.min(...prices) : Math.max(...prices),
            formedAt: group
              .map((g) => g.formedAt)
              .sort()
              .at(-1)!,
            // A cluster is swept with its extreme member (the candle's check marks the swings).
            swept: false,
          });
        }
      };
      for (const s of sorted.slice(1)) {
        if (s.price - group[0]!.price <= tol) group.push(s);
        else {
          flush();
          group = [s];
        }
      }
      flush();
    }
    return out;
  }

  private sweep(dir: Direction, taken: MutableLevel[], c: Indexed, atrPrev: number | null): void {
    const existing = this.patterns[dir];
    // The same move taking more levels: still inside the sweep's close-back window, or the
    // displacement candle itself wicking through a level. Otherwise the newest sweep wins.
    if (
      existing &&
      (existing.displacement !== null ||
        (existing.reclaimIndex === null && c.i <= existing.sweepIndex + this.params.reclaimCandles))
    ) {
      existing.levels.push(...taken);
      return;
    }
    const long = dir === 'LONG';
    const ref = this.reference(dir, c.openTime);
    if (!ref) return;
    const primary = [...taken].sort(
      (a, b) =>
        PRIORITY[a.type] - PRIORITY[b.type] || (long ? a.price - b.price : b.price - a.price),
    )[0]!;
    this.counters.sweeps++;
    const p: Pattern = {
      direction: dir,
      level: primary,
      levels: [...taken],
      sweepIndex: c.i,
      sweepTime: c.openTime,
      extreme: long ? c.low : c.high,
      reclaimIndex: null,
      reclaimTime: null,
      ref,
      displacement: null,
    };
    this.patterns[dir] = p;
    this.step(p, c, atrPrev);
  }

  /** The most recent M15 swing confirmed before the sweep (DEFAULT) and whether breaking it is a CHoCH. */
  private reference(dir: Direction, before: string): Pattern['ref'] | null {
    const t = Date.parse(before);
    const list = (dir === 'LONG' ? this.m15Highs : this.m15Lows).filter(
      (s) => Date.parse(s.confirmedAt) <= t,
    );
    const last = list.at(-1);
    if (!last) return null;
    const prev = list.at(-2);
    // LONG: breaking a lower high changes the character of a falling structure (CHoCH).
    const choch =
      prev !== undefined && (dir === 'LONG' ? last.price < prev.price : last.price > prev.price);
    return { price: last.price, time: last.time, kind: choch ? 'CHOCH' : 'BOS' };
  }

  private isDisplacement(dir: Direction, c: Candle, atr: number | null): boolean {
    if (atr === null || !(range(c) > 0)) return false;
    const directional = dir === 'LONG' ? isUp(c) : isDown(c);
    return (
      directional &&
      body(c) >= this.params.displacementBodyToRange * range(c) &&
      body(c) >= this.params.displacementBodyToAtr * atr
    );
  }

  /** Reclaim, then displacement through the reference swing (both may happen on one candle). */
  private step(p: Pattern, c: Indexed, atrPrev: number | null): void {
    const long = p.direction === 'LONG';
    if (p.reclaimIndex === null) {
      p.extreme = long ? Math.min(p.extreme, c.low) : Math.max(p.extreme, c.high);
      if (long ? c.close > p.level.price : c.close < p.level.price) {
        p.reclaimIndex = c.i;
        p.reclaimTime = c.closeTime;
        this.counters.reclaims++;
      } else {
        if (c.i >= p.sweepIndex + this.params.reclaimCandles) this.patterns[p.direction] = null;
        return;
      }
    } else if (long ? c.low < p.extreme : c.high > p.extreme) {
      this.patterns[p.direction] = null; // a new extreme beyond the sweep: it was not a sweep
      return;
    }
    const broke = long ? c.close > p.ref.price : c.close < p.ref.price;
    if (this.isDisplacement(p.direction, c, atrPrev) && broke) {
      p.displacement = { index: c.i, candle: c, atr: atrPrev! };
      this.counters.displacements++;
      return;
    }
    if (c.i >= p.sweepIndex + this.params.displacementWindowCandles)
      this.patterns[p.direction] = null;
  }

  private advance(dir: Direction, c: Indexed, atrPrev: number | null): LsfvgEvent | null {
    const p = this.patterns[dir];
    if (!p) return null;
    if (p.displacement === null) {
      this.step(p, c, atrPrev);
      return null;
    }
    // c is the FVG's third candle.
    this.patterns[dir] = null;
    const c1 = this.history.find((h) => h.i === p.displacement!.index - 1);
    if (!c1 || c.i !== p.displacement.index + 1) return null;
    const gap = dir === 'LONG' ? c1.high < c.low : c1.low > c.high;
    if (!gap) {
      this.counters.noFvg++;
      return null;
    }
    this.counters.fvgs++;
    return this.complete(p, c1, c);
  }

  private complete(p: Pattern, c1: Candle, c3: Candle): LsfvgEvent {
    const long = p.direction === 'LONG';
    const d = p.displacement!;
    const fvg = {
      low: long ? c1.high : c3.high,
      high: long ? c3.low : c1.low,
      c1Time: c1.openTime,
      c3Time: c3.openTime,
    };
    const bias = this.bias();
    const liquidity = {
      ...strip(p.level),
      name: liquidityName(p.level),
      strong: STRONG.has(p.level.type),
    };
    const partial: LsfvgStructure = {
      symbol: this.symbol,
      direction: p.direction,
      model: this.params.model,
      detectedAt: c3.closeTime,
      h1Bias: bias,
      liquidity,
      sweptLevels: p.levels.map((l) => ({ ...strip(l), name: liquidityName(l) })),
      sweep: { candleTime: p.sweepTime, extreme: p.extreme, reclaimedAt: p.reclaimTime ?? '' },
      structure: {
        kind: p.ref.kind,
        swingPrice: p.ref.price,
        swingTime: p.ref.time,
        brokenAt: d.candle.closeTime,
      },
      displacement: {
        candleTime: d.candle.openTime,
        body: body(d.candle),
        range: range(d.candle),
        atrM15: d.atr,
        bodyToRange: round(body(d.candle) / range(d.candle), 4),
        bodyToAtr: round(body(d.candle) / d.atr, 4),
      },
      fvg,
    };
    const reject = (stage: LsfvgRejectStage, reason: string): LsfvgEvent => {
      const key = {
        BIAS: 'rejectedBias',
        TARGET: 'rejectedTarget',
        REWARD_TO_RISK: 'rejectedRewardToRisk',
        DATA: 'rejectedData',
      } as const;
      this.counters[key[stage]]++;
      return {
        kind: 'REJECTED',
        rejection: {
          symbol: this.symbol,
          direction: p.direction,
          at: c3.closeTime,
          stage,
          reason,
          partial,
        },
      };
    };

    const wanted = long ? 'BULLISH' : 'BEARISH';
    if (bias.bias !== wanted)
      return reject('BIAS', `H1 bias ${bias.bias}, not ${wanted}: ${bias.reason}`);
    const atr5 = this.atrM5.value;
    if (atr5 === null) return reject('DATA', 'M5 ATR not available yet');

    const tick = this.tick;
    const entry = dec(fvg.low).plus(fvg.high).div(2).div(tick).toDecimalPlaces(0).mul(tick);
    const buffer = dec(atr5).mul(this.params.stopAtrFraction);
    const stop = long
      ? floorToStep(dec(p.extreme).minus(buffer), tick)
      : ceilToStep(dec(p.extreme).plus(buffer), tick);
    const risk = long ? entry.minus(stop) : stop.minus(entry);
    if (risk.lte(0)) return reject('DATA', 'entry is not beyond the stop');
    const minRr = this.params.minRewardToRisk;

    let target;
    let targetSource: string;
    if (this.params.model === 'A') {
      const raw = long ? entry.plus(risk.mul(minRr)) : entry.minus(risk.mul(minRr));
      target = long ? ceilToStep(raw, tick) : floorToStep(raw, tick);
      targetSource = `FIXED_${minRr}R`;
    } else {
      // Opposing liquidity still untouched after the setup candle (beyond its high / low).
      const opposite = this.levels(long ? 'BUY_SIDE' : 'SELL_SIDE', c3.closeTime, this.atrM15.value)
        .filter((l) => (long ? l.price > c3.high : l.price < c3.low))
        .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
      const rrOf = (price: number) => dec(price).minus(entry).abs().div(risk);
      const pick =
        this.params.modelBTarget === 'NEAREST_ONLY'
          ? opposite[0]
          : opposite.find((l) => rrOf(l.price).gte(minRr));
      if (!pick) {
        return reject(
          'TARGET',
          opposite.length === 0
            ? `no ${long ? 'buy' : 'sell'}-side liquidity ${long ? 'above' : 'below'} the entry`
            : `no opposing liquidity gives ${minRr}R (nearest ${liquidityName(opposite[0]!)} ${opposite[0]!.price} = ${toNum(rrOf(opposite[0]!.price), 2)}R)`,
        );
      }
      target = long ? floorToStep(dec(pick.price), tick) : ceilToStep(dec(pick.price), tick);
      targetSource = `${liquidityName(pick)} ${pick.price}`;
    }
    const rr = target.minus(entry).abs().div(risk);
    if (rr.lt(minRr))
      return reject('REWARD_TO_RISK', `reward : risk ${toNum(rr, 2)} is below ${minRr}`);

    const components = {
      h1Bias: SCORE.h1Bias,
      strongLiquidity: liquidity.strong ? SCORE.strongLiquidity : 0,
      sweep: SCORE.sweep,
      structure: SCORE.structure,
      displacement: SCORE.displacement,
      fvg: SCORE.fvg,
      retrace: 0,
      rewardToRisk: SCORE.rewardToRisk,
    };
    const id = `${this.symbol}-${p.direction}-${c3.closeTime}`;
    const detectedAtMs = Date.parse(c3.closeTime);
    const setup: LsfvgSetup = {
      ...partial,
      id,
      expiresAt: new Date(detectedAtMs + this.params.entryWaitM5Candles * M5).toISOString(),
      entry: toNum(entry, 10),
      stop: toNum(stop, 10),
      target: toNum(target, 10),
      targetSource,
      rewardToRisk: toNum(rr, 2),
      atrM5: round(atr5, 10),
      score: {
        total: Object.values(components).reduce((a, b) => a + b, 0),
        max: MAX_SCORE,
        retracePending: true,
        components,
      },
      rationale: [
        `H1 ${bias.bias.toLowerCase()} (${bias.reason})`,
        `${liquidity.name} ${liquidity.price} swept to ${p.extreme}, closed back ${long ? 'above' : 'below'}`,
        `${p.ref.kind} through the M15 swing ${long ? 'high' : 'low'} ${p.ref.price} by a displacement candle (body ${round(body(d.candle) / range(d.candle), 2)} of range, ${round(body(d.candle) / d.atr, 2)} × ATR)`,
        `${long ? 'bullish' : 'bearish'} FVG ${fvg.low}–${fvg.high}; LIMIT at its midpoint`,
        `target ${targetSource} (${toNum(rr, 2)}R)`,
      ],
    };
    this.counters.setups++;
    this.active.push({
      id,
      direction: p.direction,
      invalidation: p.extreme,
      detectedAtMs,
      seen: 0,
    });
    return { kind: 'SETUP', setup };
  }

  private rollDay(c: Candle): void {
    const w = tradingDayWindow(new Date(c.openTime), this.params.tradingDay);
    if (this.day && this.day.key !== w.key) {
      this.prevDay = {
        high: {
          type: 'PREVIOUS_DAY',
          side: 'BUY_SIDE',
          price: this.day.high,
          formedAt: this.day.end,
          swept: false,
        },
        low: {
          type: 'PREVIOUS_DAY',
          side: 'SELL_SIDE',
          price: this.day.low,
          formedAt: this.day.end,
          swept: false,
        },
      };
      this.day = null;
    }
    if (!this.day) this.day = { key: w.key, end: w.end.toISOString(), high: c.high, low: c.low };
  }

  private rollAsian(c: Candle): void {
    const date = c.openTime.slice(0, 10);
    if (!this.asian || this.asian.date !== date) {
      this.asian = { date, high: -Infinity, low: Infinity, count: 0, levels: null };
    }
    const end = `${date}T${this.params.asianSession.endUtc}:00.000Z`;
    const a = this.asian;
    if (a.levels === null && a.count > 0 && Date.parse(c.openTime) >= Date.parse(end)) {
      a.levels = {
        high: { type: 'ASIAN', side: 'BUY_SIDE', price: a.high, formedAt: end, swept: false },
        low: { type: 'ASIAN', side: 'SELL_SIDE', price: a.low, formedAt: end, swept: false },
      };
    }
  }

  private accumulate(c: Candle): void {
    if (this.day) {
      this.day.high = Math.max(this.day.high, c.high);
      this.day.low = Math.min(this.day.low, c.low);
    }
    const a = this.asian!;
    const date = a.date;
    const start = Date.parse(`${date}T${this.params.asianSession.startUtc}:00.000Z`);
    const end = Date.parse(`${date}T${this.params.asianSession.endUtc}:00.000Z`);
    const t = Date.parse(c.openTime);
    if (t >= start && t < end && a.levels === null) {
      a.high = Math.max(a.high, c.high);
      a.low = Math.min(a.low, c.low);
      a.count++;
    }
  }
}

function strip(l: MutableLevel): LiquidityLevel {
  return { type: l.type, side: l.side, price: l.price, formedAt: l.formedAt };
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
