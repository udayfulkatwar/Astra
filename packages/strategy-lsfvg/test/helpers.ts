import type { Candle } from '../src';

export interface Ohlc {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

const r = (x: number) => Math.round(x * 1e5) / 1e5;

/**
 * Splits one candle of `n` M5 periods into n M5 candles tracing o → l → h → c (up candle) or
 * o → h → l → c (down candle), so the aggregate is exactly the given OHLC.
 */
export function split(start: number, x: Ohlc, n: number): Candle[] {
  const up = x.c >= x.o;
  const path = up ? [x.o, x.l, x.h, x.c] : [x.o, x.h, x.l, x.c];
  // n + 1 points along the path (piecewise linear over its three legs), extremes included.
  const pts: number[] = [];
  for (let k = 0; k <= n; k++) {
    const f = (k / n) * 3;
    const leg = Math.min(2, Math.floor(f));
    const a = path[leg]!;
    const b = path[leg + 1]!;
    pts.push(r(a + (b - a) * (f - leg)));
  }
  // Make sure the extremes are visited exactly.
  const hiIdx = up ? Math.round((2 / 3) * n) : Math.round((1 / 3) * n);
  const loIdx = up ? Math.round((1 / 3) * n) : Math.round((2 / 3) * n);
  pts[hiIdx] = x.h;
  pts[loIdx] = x.l;
  const out: Candle[] = [];
  for (let k = 0; k < n; k++) {
    const o = pts[k]!;
    const c = pts[k + 1]!;
    const openMs = start + k * 300_000;
    out.push({
      openTime: new Date(openMs).toISOString(),
      closeTime: new Date(openMs + 300_000).toISOString(),
      open: o,
      high: Math.max(o, c),
      low: Math.min(o, c),
      close: c,
    });
  }
  return out;
}

/** H1 candles through waypoints (index → price), with an extra wick on turning points. */
export function h1Path(points: readonly [number, number][], wick = 0.0002, extra = 0.0005): Ohlc[] {
  const last = points.at(-1)![0];
  const price = (i: number) => {
    for (let k = 0; k < points.length - 1; k++) {
      const [i0, p0] = points[k]!;
      const [i1, p1] = points[k + 1]!;
      if (i >= i0 && i <= i1) return r(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
    }
    return points.at(-1)![1];
  };
  const turns = new Map(
    points.slice(1, -1).map(([i, p], k) => [i, p > points[k]![1] ? 'PEAK' : 'TROUGH']),
  );
  const out: Ohlc[] = [];
  for (let i = 0; i < last; i++) {
    const o = price(i);
    const c = price(i + 1);
    let h = r(Math.max(o, c) + wick);
    let l = r(Math.min(o, c) - wick);
    if (turns.get(i) === 'PEAK') h = r(h + extra);
    if (turns.get(i) === 'TROUGH') l = r(l - extra);
    out.push({ o, h, l, c });
  }
  return out;
}

export const HOUR = 3_600_000;
export const M15 = 900_000;
