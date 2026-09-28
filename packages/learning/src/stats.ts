/** Small, dependency-free statistics used by the learning report (sample statistics only). */

export function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Sample standard deviation (n − 1); null below two values. */
export function sampleSd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

const T95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];
const T95_TAIL: readonly [number, number][] = [
  [30, 2.042],
  [40, 2.021],
  [60, 2.0],
  [120, 1.98],
  [Infinity, 1.96],
];

/** Two-sided 95 % Student-t critical value (table; interpolated in 1/df beyond 30). */
export function tCritical95(df: number): number {
  if (df < 1) return Infinity;
  if (df <= 30) return T95[Math.floor(df) - 1]!;
  for (let i = 1; i < T95_TAIL.length; i++) {
    const [d1, t1] = T95_TAIL[i - 1]!;
    const [d2, t2] = T95_TAIL[i]!;
    if (df <= d2) {
      const x = (1 / df - 1 / d1) / (1 / d2 - 1 / d1);
      return t1 + (t2 - t1) * x;
    }
  }
  return 1.96;
}

/** Mean with a 95 % confidence interval (t-based); null below two values. */
export function meanInterval(xs: readonly number[]): { lo: number; hi: number } | null {
  const sd = sampleSd(xs);
  if (sd === null) return null;
  const m = mean(xs)!;
  const half = (tCritical95(xs.length - 1) * sd) / Math.sqrt(xs.length);
  return { lo: m - half, hi: m + half };
}

/** Welch's t statistic for a difference in means; null when it cannot be computed. */
export function welchT(a: readonly number[], b: readonly number[]): number | null {
  const sa = sampleSd(a);
  const sb = sampleSd(b);
  if (sa === null || sb === null) return null;
  const se = Math.sqrt(sa ** 2 / a.length + sb ** 2 / b.length);
  if (!(se > 0)) return null;
  return (mean(a)! - mean(b)!) / se;
}

export const round = (v: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f + 0;
};
