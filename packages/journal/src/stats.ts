/**
 * Journal statistics — descriptive only, over the recorded trades (n is always reported; nothing
 * is extrapolated). R statistics use only trades whose R is known.
 */
import type { JournalEntry } from './entry';

export interface JournalStats {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  /** Wins / (wins + losses); null without decided trades. */
  readonly winRatePct: number | null;
  /** Trades with a known R. */
  readonly rTrades: number;
  /** Mean R = expectancy per trade in R; null without R trades. */
  readonly avgR: number | null;
  readonly totalR: number | null;
  readonly netPnl: number | null;
  readonly grossPnl: number;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
  /** Gross profit of winners / |gross loss of losers|; null without losers. */
  readonly profitFactor: number | null;
  readonly maxConsecutiveLosses: number;
  readonly avgDurationSec: number | null;
  readonly exitedAsPlannedPct: number | null;
  readonly byExitReason: Record<string, number>;
}

const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
const pnlOf = (e: JournalEntry) => e.result.netPnl ?? e.result.grossPnl;

export function journalStats(entries: readonly JournalEntry[]): JournalStats {
  const n = entries.length;
  const wins = entries.filter((e) => e.result.outcome === 'WIN');
  const losses = entries.filter((e) => e.result.outcome === 'LOSS');
  const withR = entries.filter((e) => e.result.rMultiple !== null);
  const totalR = withR.reduce((s, e) => s + e.result.rMultiple!, 0);
  const grossWin = wins.reduce((s, e) => s + pnlOf(e), 0);
  const grossLoss = losses.reduce((s, e) => s + pnlOf(e), 0);
  const nets = entries.map((e) => e.result.netPnl);
  // Chronological for streaks.
  const ordered = [...entries].sort((a, b) => a.exit.at.localeCompare(b.exit.at));
  let streak = 0;
  let maxStreak = 0;
  for (const e of ordered) {
    streak = e.result.outcome === 'LOSS' ? streak + 1 : e.result.outcome === 'WIN' ? 0 : streak;
    maxStreak = Math.max(maxStreak, streak);
  }
  const byExitReason: Record<string, number> = {};
  for (const e of entries) byExitReason[e.exit.reason] = (byExitReason[e.exit.reason] ?? 0) + 1;
  const planned = entries.filter((e) => e.source === 'ASTRA');
  const decided = wins.length + losses.length;
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: n - decided,
    winRatePct: decided ? round((wins.length / decided) * 100, 1) : null,
    rTrades: withR.length,
    avgR: withR.length ? round(totalR / withR.length) : null,
    totalR: withR.length ? round(totalR) : null,
    netPnl: nets.every((v) => v !== null) && n ? round(nets.reduce((s, v) => s + v, 0)) : null,
    grossPnl: round(entries.reduce((s, e) => s + e.result.grossPnl, 0)),
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(grossLoss / losses.length) : null,
    profitFactor: losses.length && grossLoss !== 0 ? round(grossWin / Math.abs(grossLoss)) : null,
    maxConsecutiveLosses: maxStreak,
    avgDurationSec: n ? Math.round(entries.reduce((s, e) => s + e.durationSec, 0) / n) : null,
    exitedAsPlannedPct: planned.length
      ? round((planned.filter((e) => e.exitedAsPlanned).length / planned.length) * 100, 1)
      : null,
    byExitReason,
  };
}

/** Statistics per group (strategy, instrument, exit reason…), largest group first. */
export function groupedStats(
  entries: readonly JournalEntry[],
  key: (e: JournalEntry) => string,
): { key: string; stats: JournalStats }[] {
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const k = key(e);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.entries()]
    .map(([k, list]) => ({ key: k, stats: journalStats(list) }))
    .sort((a, b) => b.stats.trades - a.stats.trades || a.key.localeCompare(b.key));
}

export interface JournalSummary {
  readonly overall: JournalStats;
  readonly byStrategy: { key: string; stats: JournalStats }[];
  readonly bySymbol: { key: string; stats: JournalStats }[];
  readonly byExitReason: { key: string; stats: JournalStats }[];
}

export function journalSummary(entries: readonly JournalEntry[]): JournalSummary {
  return {
    overall: journalStats(entries),
    byStrategy: groupedStats(entries, (e) => e.strategyId ?? '(external)'),
    bySymbol: groupedStats(entries, (e) => e.symbol),
    byExitReason: groupedStats(entries, (e) => e.exit.reason),
  };
}
