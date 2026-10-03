/**
 * SPEC §21 / §22 / §24 validation. The rules are frozen before any of this runs: these tools
 * only measure how stable the results are — they never pick parameters.
 *
 * - Split: the same trades reported before and after a cut date (in-sample vs untouched
 *   out-of-sample).
 * - Walk-forward: consecutive windows, each reported on its own; stability = share of windows
 *   with a positive expectancy.
 * - Monte Carlo: bootstrap resampling of the trades' R (seeded, reproducible): distributions of
 *   total R and max drawdown, and the chance the drawdown reaches a given depth. It assumes the
 *   trades are independent and identically distributed: it resamples the sample's own outcomes,
 *   so it cannot show a regime change, loss clustering or an edge the sample did not contain.
 *   Trades without an R (zero risk) are left out of the resampling.
 * - Robustness: how much the result depends on the best year, the best pair, the best session
 *   and the few largest winners.
 */
import { breakdown, bySession, byPair, byYear, metrics, type Metrics } from './metrics';
import type { ResearchTrade } from './simulate';

function instant(label: string, iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`${label} is not a valid date: ${JSON.stringify(iso)}`);
  return t;
}

/** Trades with an unreadable close time cannot be ordered, split or windowed: refuse, never drop. */
function assertDated(trades: readonly ResearchTrade[]): void {
  for (const t of trades) instant(`closedAt of trade ${t.id}`, t.closedAt);
}

export function split(trades: readonly ResearchTrade[], cut: string) {
  const c = instant('cut', cut);
  assertDated(trades);
  const inSample = trades.filter((t) => Date.parse(t.closedAt) < c);
  const outOfSample = trades.filter((t) => Date.parse(t.closedAt) >= c);
  // Assignment is by close time (the frozen definition). Trades opened before the cut but
  // closed after it are counted out-of-sample although their entry was decided in-sample;
  // the count stays visible so the held-out sample is not read as fully independent.
  const straddling = outOfSample.filter((t) => Date.parse(t.openedAt) < c).length;
  return { cut, inSample: metrics(inSample), outOfSample: metrics(outOfSample), straddling };
}

/** `months` after `from` in UTC, the day clamped to the month's length (31 Jan + 1 → 28/29 Feb). */
function addMonths(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(from.getUTCDate(), last),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * Consecutive windows of `windowMonths` over [from, to). The last window is cut at `to`: no
 * trade closed at or after `to` is counted. Each window is anchored to `from` (no day drift).
 */
export function walkForward(
  trades: readonly ResearchTrade[],
  from: string,
  to: string,
  windowMonths: number,
): { from: string; to: string; metrics: Metrics }[] {
  const start0 = instant('from', from);
  const end = instant('to', to);
  if (!Number.isInteger(windowMonths) || windowMonths < 1)
    throw new Error(`windowMonths must be a positive whole number, got ${windowMonths}`);
  if (start0 >= end) throw new Error('walk-forward needs from < to');
  assertDated(trades);
  const origin = new Date(start0);
  const out: { from: string; to: string; metrics: Metrics }[] = [];
  for (let k = 0; ; k++) {
    const lo = addMonths(origin, k * windowMonths).getTime();
    if (lo >= end) break;
    const hi = Math.min(addMonths(origin, (k + 1) * windowMonths).getTime(), end);
    const w = trades.filter((t) => {
      const c = Date.parse(t.closedAt);
      return c >= lo && c < hi;
    });
    out.push({
      from: new Date(lo).toISOString().slice(0, 10),
      to: new Date(hi).toISOString().slice(0, 10),
      metrics: metrics(w),
    });
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
  if (rs.some((r) => !Number.isFinite(r))) throw new Error('Monte Carlo needs finite R values');
  if (rs.length === 0) return null;
  const runs = opts.runs ?? 5_000;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive whole number`);
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
