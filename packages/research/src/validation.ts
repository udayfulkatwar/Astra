/**
 * SPEC §21 / §22 / §24 validation. The rules are frozen before any of this runs: these tools
 * only measure how stable the results are — they never pick parameters.
 *
 * - Split: the same trades reported before and after a cut date (in-sample vs untouched
 *   out-of-sample).
 * - Walk-forward: consecutive windows, each reported on its own; stability = share of windows
 *   with a positive expectancy.
 * - Monte Carlo: bootstrap resampling of the trades' R (seeded, reproducible): distributions of
 *   total R and max drawdown, and the chance the drawdown reaches a given depth.
 * - Robustness: how much the result depends on the best year, the best pair, the best session
 *   and the few largest winners.
 */
import { breakdown, bySession, byPair, byYear, metrics, type Metrics } from './metrics';
import type { ResearchTrade } from './simulate';

export function split(trades: readonly ResearchTrade[], cut: string) {
  const c = Date.parse(cut);
  const inSample = trades.filter((t) => Date.parse(t.closedAt) < c);
  const outOfSample = trades.filter((t) => Date.parse(t.closedAt) >= c);
  return { cut, inSample: metrics(inSample), outOfSample: metrics(outOfSample) };
}

export function walkForward(
  trades: readonly ResearchTrade[],
  from: string,
  to: string,
  windowMonths: number,
): { from: string; to: string; metrics: Metrics }[] {
  const out: { from: string; to: string; metrics: Metrics }[] = [];
  let start = new Date(from);
  const end = Date.parse(to);
  while (start.getTime() < end) {
    const next = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + windowMonths, start.getUTCDate()),
    );
    const w = trades.filter(
      (t) => Date.parse(t.closedAt) >= start.getTime() && Date.parse(t.closedAt) < next.getTime(),
    );
    out.push({
      from: start.toISOString().slice(0, 10),
      to: new Date(Math.min(next.getTime(), end)).toISOString().slice(0, 10),
      metrics: metrics(w),
    });
    start = next;
  }
  return out;
}

/** mulberry32: a small, seeded, reproducible generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (sorted: readonly number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export interface MonteCarlo {
  readonly runs: number;
  readonly seed: number;
  readonly tradesPerRun: number;
  readonly totalR: { readonly p5: number; readonly p50: number; readonly p95: number };
  readonly maxDrawdownR: { readonly p50: number; readonly p95: number; readonly p99: number };
  /** Expectancy per trade, 5th–95th percentile of the bootstrap. */
  readonly expectancyR: { readonly p5: number; readonly p95: number };
  /** Share of runs whose drawdown reached each depth (R). */
  readonly drawdownAtLeast: readonly { readonly r: number; readonly probability: number }[];
}

export function monteCarlo(
  trades: readonly ResearchTrade[],
  opts: { runs?: number; seed?: number; depthsR?: readonly number[] } = {},
): MonteCarlo | null {
  const rs = trades.map((t) => t.r).filter((r): r is number => r !== null);
  if (rs.length === 0) return null;
  const runs = opts.runs ?? 5_000;
  const seed = opts.seed ?? 20_260_928;
  const depths = opts.depthsR ?? [4, 8, 12, 20];
  const next = rng(seed);
  const totals: number[] = [];
  const dds: number[] = [];
  for (let k = 0; k < runs; k++) {
    let cum = 0;
    let peak = 0;
    let dd = 0;
    for (let i = 0; i < rs.length; i++) {
      cum += rs[Math.floor(next() * rs.length)]!;
      peak = Math.max(peak, cum);
      dd = Math.max(dd, peak - cum);
    }
    totals.push(cum);
    dds.push(dd);
  }
  totals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    runs,
    seed,
    tradesPerRun: rs.length,
    totalR: { p5: r2(pct(totals, 0.05)), p50: r2(pct(totals, 0.5)), p95: r2(pct(totals, 0.95)) },
    maxDrawdownR: { p50: r2(pct(dds, 0.5)), p95: r2(pct(dds, 0.95)), p99: r2(pct(dds, 0.99)) },
    expectancyR: {
      p5: Math.round((pct(totals, 0.05) / rs.length) * 1000) / 1000,
      p95: Math.round((pct(totals, 0.95) / rs.length) * 1000) / 1000,
    },
    drawdownAtLeast: depths.map((r) => ({
      r,
      probability: Math.round((dds.filter((d) => d >= r).length / runs) * 1000) / 1000,
    })),
  };
}

export interface Robustness {
  readonly all: Metrics;
  readonly withoutBestYear: { readonly year: string | null; readonly metrics: Metrics };
  readonly withoutBestPair: { readonly pair: string | null; readonly metrics: Metrics };
  readonly withoutBestSession: { readonly session: string | null; readonly metrics: Metrics };
  /** Without the 5 largest winners (by R). */
  readonly withoutTop5Winners: Metrics;
}

export function robustness(trades: readonly ResearchTrade[]): Robustness {
  const best = (key: (t: ResearchTrade) => string) => {
    const b = breakdown(trades, key).sort((x, y) => y.metrics.totalR - x.metrics.totalR)[0];
    return b ? b.key : null;
  };
  const year = best(byYear);
  const pair = best(byPair);
  const session = best(bySession);
  const top = new Set(
    [...trades]
      .sort((a, b) => (b.r ?? 0) - (a.r ?? 0))
      .slice(0, 5)
      .map((t) => t.id),
  );
  return {
    all: metrics(trades),
    withoutBestYear: { year, metrics: metrics(trades.filter((t) => byYear(t) !== year)) },
    withoutBestPair: { pair, metrics: metrics(trades.filter((t) => byPair(t) !== pair)) },
    withoutBestSession: {
      session,
      metrics: metrics(trades.filter((t) => bySession(t) !== session)),
    },
    withoutTop5Winners: metrics(trades.filter((t) => !top.has(t.id))),
  };
}

/** Too little to measure: fewer trades than this is reported as INSUFFICIENT DATA. */
export const MIN_TRADES_FOR_STATISTICS = 30;
