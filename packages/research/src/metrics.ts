/**
 * SPEC §23 metrics from closed research trades. Plain arithmetic over what happened — no
 * annualised projections, no "profitability" verdicts. Money is the account currency; R is net
 * P&L over the risk to the stop at the fill.
 */
import type { ResearchTrade } from './simulate';

export interface Metrics {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  /** % of trades with net P&L > 0 (null without trades). */
  readonly winRate: number | null;
  readonly avgWinR: number | null;
  readonly avgLossR: number | null;
  /** Mean net R per trade. */
  readonly expectancyR: number | null;
  /** Gross profit / gross loss (net P&L); null without losses. */
  readonly profitFactor: number | null;
  readonly totalR: number;
  readonly netPnl: number;
  /** Largest peak-to-trough fall of the cumulative R of closed trades. */
  readonly maxDrawdownR: number;
  /** The same on closed-trade money (starting from 0). */
  readonly maxDrawdownMoney: number;
  readonly maxConsecutiveLosses: number;
  readonly avgDurationMinutes: number | null;
}

const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
const mean = (xs: readonly number[]) =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

export function metrics(trades: readonly ResearchTrade[]): Metrics {
  // An unreadable close time makes the order — and so every drawdown — meaningless.
  for (const t of trades)
    if (!Number.isFinite(Date.parse(t.closedAt)))
      throw new Error(`trade ${t.id} has an invalid closedAt: ${JSON.stringify(t.closedAt)}`);
  const sorted = [...trades].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  const rs = sorted.map((t) => t.r ?? 0);
  const wins = sorted.filter((t) => t.netPnl > 0);
  const losses = sorted.filter((t) => t.netPnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.netPnl, 0);
  let peakR = 0;
  let cumR = 0;
  let ddR = 0;
  let peakM = 0;
  let cumM = 0;
  let ddM = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of sorted) {
    cumR += t.r ?? 0;
    peakR = Math.max(peakR, cumR);
    ddR = Math.max(ddR, peakR - cumR);
    cumM += t.netPnl;
    peakM = Math.max(peakM, cumM);
    ddM = Math.max(ddM, peakM - cumM);
    streak = t.netPnl < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const winR = mean(wins.map((t) => t.r ?? 0));
  const lossR = mean(losses.map((t) => t.r ?? 0));
  const exp = mean(rs);
  const dur = mean(sorted.map((t) => t.durationMinutes));
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: sorted.length - wins.length - losses.length,
    winRate: sorted.length ? round((wins.length / sorted.length) * 100, 1) : null,
    avgWinR: winR === null ? null : round(winR),
    avgLossR: lossR === null ? null : round(lossR),
    expectancyR: exp === null ? null : round(exp, 3),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    totalR: round(cumR),
    netPnl: round(cumM),
    maxDrawdownR: round(ddR),
    maxDrawdownMoney: round(ddM),
    maxConsecutiveLosses: maxStreak,
    avgDurationMinutes: dur === null ? null : Math.round(dur),
  };
}

/** Metrics per group (pair, direction, year, month, session …), groups sorted by key. */
export function breakdown(
  trades: readonly ResearchTrade[],
  key: (t: ResearchTrade) => string,
): { key: string; metrics: Metrics }[] {
  const groups = new Map<string, ResearchTrade[]>();
  for (const t of trades) {
    const k = key(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, ts]) => ({ key: k, metrics: metrics(ts) }));
}

export const byYear = (t: ResearchTrade) => t.closedAt.slice(0, 4);
export const byMonth = (t: ResearchTrade) => t.closedAt.slice(0, 7);
export const byPair = (t: ResearchTrade) => t.symbol;
export const byDirection = (t: ResearchTrade) => t.direction;
/** UTC sessions: ASIA 00–07, LONDON 07–12, NEW_YORK 12–17, LATE 17–24. */
export const bySession = (t: ResearchTrade) =>
  t.entryHourUtc < 7
    ? 'ASIA'
    : t.entryHourUtc < 12
      ? 'LONDON'
      : t.entryHourUtc < 17
        ? 'NEW_YORK'
        : 'LATE';
