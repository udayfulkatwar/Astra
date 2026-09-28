/**
 * Learning report (spec §32): what the recorded trades say, broken down by the dimensions a
 * trader learns from — strategy, instrument, long/short, session, hour, weekday, setup, event
 * context, exit and mode — plus drawdown, losing streaks and execution quality.
 *
 * Honesty rules: statistics describe recorded trades only; every group shows its sample size and a
 * 95 % interval for its average R; groups below `minSample` are flagged; "observations" are only
 * raised when both sides have enough trades, and they are observations — ASTRA never changes risk
 * settings or strategy rules by itself.
 */
import { activeSessions, type SessionDefinition } from '@astra/core';
import { journalStats, type JournalEntry, type JournalStats } from '@astra/journal';
import { DateTime } from 'luxon';
import { mean, meanInterval, round, sampleSd, welchT } from './stats';

export const LEARNING_DIMENSIONS = [
  'strategy',
  'instrument',
  'direction',
  'session',
  'hour',
  'weekday',
  'setup',
  'eventDay',
  'heldThroughEvent',
  'exit',
  'mode',
] as const;
export type LearningDimension = (typeof LEARNING_DIMENSIONS)[number];

export interface LearningOptions {
  /** IANA zone for hour-of-day and weekday (default UTC). */
  readonly timeZone?: string;
  /** Session definitions for "session at entry" (config `sessions`). */
  readonly sessions?: readonly SessionDefinition[];
  /** Trades (with a known R) a group needs before it is more than a "small sample" (default 30). */
  readonly minSample?: number;
}

export interface GroupStats {
  readonly key: string;
  readonly trades: number;
  /** Trades with a known R (the R statistics use only these). */
  readonly rTrades: number;
  readonly winRatePct: number | null;
  readonly avgR: number | null;
  /** 95 % confidence interval of the average R (t-based); null below two R trades. */
  readonly avgRLow: number | null;
  readonly avgRHigh: number | null;
  readonly totalR: number | null;
  readonly profitFactor: number | null;
  readonly netPnl: number | null;
  readonly grossPnl: number;
  readonly smallSample: boolean;
}

export interface LearningOverall extends GroupStats {
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  /** Standard deviation of R per trade. */
  readonly rSd: number | null;
  /** Mean R ÷ SD of R, per trade (not annualised). */
  readonly sharpeLike: number | null;
  readonly maxConsecutiveLosses: number;
  readonly avgDurationSec: number | null;
}

export interface DimensionReport {
  readonly dimension: LearningDimension;
  readonly label: string;
  readonly groups: GroupStats[];
}

export interface CurvePoint {
  /** Trade number (1-based, by exit time). */
  readonly n: number;
  readonly t: string;
  readonly cumR: number;
  readonly cumPnl: number;
}

export interface ExecutionQuality {
  /** Entry slippage in ticks (+ = worse than planned). */
  readonly entrySlippage: {
    readonly trades: number;
    readonly avgTicks: number | null;
    readonly adversePct: number | null;
  };
  /** Stop exits: ticks worse than the stop. */
  readonly stopSlippage: { readonly trades: number; readonly avgTicks: number | null };
  readonly exitedAsPlannedPct: number | null;
  readonly protectiveExits: number;
  /** Excursions (fully observed trades with a known R). */
  readonly excursion: {
    readonly trades: number;
    readonly avgMfeR: number | null;
    readonly avgMaeR: number | null;
    /** Winners' realised R as a share of their best R while open. */
    readonly winnersCapturePct: number | null;
    /** Losing trades that had been at least +1 R in profit first. */
    readonly losersAfterPlusOneR: number;
    readonly losers: number;
  };
}

export interface Observation {
  readonly dimension: LearningDimension;
  readonly dimensionLabel: string;
  readonly group: string;
  readonly rTrades: number;
  readonly avgR: number;
  readonly restRTrades: number;
  readonly restAvgR: number;
  /** Welch t statistic of the difference. */
  readonly t: number;
  readonly strength: 'STRONG' | 'MODERATE';
  readonly direction: 'BETTER' | 'WORSE';
  readonly text: string;
}

export interface LearningReport {
  readonly trades: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly timeZone: string;
  readonly minSample: number;
  readonly overall: LearningOverall;
  /** Cumulative R and P&L by exit time (at most 500 points; drawdown uses every trade). */
  readonly curve: CurvePoint[];
  readonly drawdown: {
    readonly maxR: number;
    readonly maxMoney: number;
    readonly maxMoneyAt: string | null;
    /** How many losing streaks of each length occurred. */
    readonly losingStreaks: { readonly length: number; readonly count: number }[];
  };
  readonly dimensions: DimensionReport[];
  readonly execution: ExecutionQuality;
  readonly observations: Observation[];
  readonly notes: string[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TRISTATE: Record<string, string> = {
  YES: 'yes',
  NO: 'no',
  UNKNOWN: 'unknown (not covered)',
};
const pnlOf = (e: JournalEntry) => e.result.netPnl ?? e.result.grossPnl;

function groupStats(key: string, entries: readonly JournalEntry[], minSample: number): GroupStats {
  const s: JournalStats = journalStats(entries);
  const rs = entries.flatMap((e) => (e.result.rMultiple === null ? [] : [e.result.rMultiple]));
  const ci = meanInterval(rs);
  return {
    key,
    trades: s.trades,
    rTrades: s.rTrades,
    winRatePct: s.winRatePct,
    avgR: s.avgR,
    avgRLow: ci ? round(ci.lo) : null,
    avgRHigh: ci ? round(ci.hi) : null,
    totalR: s.totalR,
    profitFactor: s.profitFactor,
    netPnl: s.netPnl,
    grossPnl: s.grossPnl,
    smallSample: s.rTrades < minSample,
  };
}

export function learningReport(
  entries: readonly JournalEntry[],
  opts: LearningOptions = {},
): LearningReport {
  const timeZone = opts.timeZone ?? 'UTC';
  const minSample = opts.minSample ?? 30;
  const sessions = opts.sessions ?? [];
  const ordered = [...entries].sort(
    (a, b) => a.exit.at.localeCompare(b.exit.at) || a.tradeId.localeCompare(b.tradeId),
  );
  const local = (iso: string) => DateTime.fromISO(iso, { zone: timeZone });

  const keyOf: Record<LearningDimension, (e: JournalEntry) => string> = {
    strategy: (e) => e.strategyId ?? '(external)',
    instrument: (e) => e.symbol,
    direction: (e) => e.direction,
    session: (e) =>
      sessions.length === 0
        ? '(no sessions configured)'
        : activeSessions(new Date(e.entry.at), sessions).join(' + ') || '(outside sessions)',
    hour: (e) => `${String(local(e.entry.at).hour).padStart(2, '0')}:00`,
    weekday: (e) => WEEKDAYS[local(e.entry.at).weekday - 1]!,
    setup: (e) => e.context?.setup ?? '(not labelled)',
    eventDay: (e) => TRISTATE[e.context?.eventDay ?? 'UNKNOWN']!,
    heldThroughEvent: (e) => TRISTATE[e.context?.heldThroughEvent ?? 'UNKNOWN']!,
    exit: (e) => e.exit.reason,
    mode: (e) => e.mode ?? '(unknown)',
  };
  const labels: Record<LearningDimension, string> = {
    strategy: 'Strategy',
    instrument: 'Instrument',
    direction: 'Long vs short',
    session: 'Session at entry',
    hour: `Hour of entry (${timeZone})`,
    weekday: `Day of entry (${timeZone})`,
    setup: 'Setup',
    eventDay: 'High-impact event that day',
    heldThroughEvent: 'Held through a high-impact event',
    exit: 'Exit reason',
    mode: 'Mode',
  };
  const naturalOrder: Partial<Record<LearningDimension, (a: string, b: string) => number>> = {
    hour: (a, b) => a.localeCompare(b),
    weekday: (a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b),
  };

  const dimensions: DimensionReport[] = LEARNING_DIMENSIONS.map((dimension) => {
    const groups = new Map<string, JournalEntry[]>();
    for (const e of ordered) {
      const k = keyOf[dimension](e);
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    const order = naturalOrder[dimension];
    return {
      dimension,
      label: labels[dimension],
      groups: [...groups.entries()]
        .map(([k, list]) => groupStats(k, list, minSample))
        .sort((a, b) =>
          order ? order(a.key, b.key) : b.trades - a.trades || a.key.localeCompare(b.key),
        ),
    };
  });

  // Overall, curve and drawdown.
  const base = journalStats(ordered);
  const rs = ordered.flatMap((e) => (e.result.rMultiple === null ? [] : [e.result.rMultiple]));
  const rSd = sampleSd(rs);
  const rMean = mean(rs);
  let cumR = 0;
  let cumPnl = 0;
  let peakR = 0;
  let peakPnl = 0;
  let maxR = 0;
  let maxMoney = 0;
  let maxMoneyAt: string | null = null;
  const full: CurvePoint[] = ordered.map((e, i) => {
    cumR += e.result.rMultiple ?? 0;
    cumPnl += pnlOf(e);
    peakR = Math.max(peakR, cumR);
    peakPnl = Math.max(peakPnl, cumPnl);
    maxR = Math.max(maxR, peakR - cumR);
    if (peakPnl - cumPnl > maxMoney) {
      maxMoney = peakPnl - cumPnl;
      maxMoneyAt = e.exit.at;
    }
    return { n: i + 1, t: e.exit.at, cumR: round(cumR), cumPnl: round(cumPnl) };
  });
  const stride = Math.ceil(full.length / 500);
  const curve = full.filter((_, i) => i % stride === stride - 1 || i === full.length - 1);

  const streaks = new Map<number, number>();
  let run = 0;
  for (const e of ordered) {
    if (e.result.outcome === 'LOSS') run++;
    else if (e.result.outcome === 'WIN') {
      if (run > 0) streaks.set(run, (streaks.get(run) ?? 0) + 1);
      run = 0;
    }
  }
  if (run > 0) streaks.set(run, (streaks.get(run) ?? 0) + 1);

  const overall: LearningOverall = {
    ...groupStats('all trades', ordered, minSample),
    wins: base.wins,
    losses: base.losses,
    breakeven: base.breakeven,
    rSd: rSd === null ? null : round(rSd),
    sharpeLike: rSd && rMean !== null && rSd > 0 ? round(rMean / rSd) : null,
    maxConsecutiveLosses: base.maxConsecutiveLosses,
    avgDurationSec: base.avgDurationSec,
  };

  // Observations: a group vs the rest of its dimension, only with enough trades on both sides.
  const observations: Observation[] = [];
  let comparisons = 0;
  for (const d of dimensions) {
    if (d.groups.length < 2) continue;
    for (const g of d.groups) {
      const inGroup: number[] = [];
      const rest: number[] = [];
      for (const e of ordered) {
        if (e.result.rMultiple === null) continue;
        (keyOf[d.dimension](e) === g.key ? inGroup : rest).push(e.result.rMultiple);
      }
      if (inGroup.length < minSample || rest.length < minSample) continue;
      comparisons++;
      const t = welchT(inGroup, rest);
      if (t === null || Math.abs(t) < 2) continue;
      const avgR = round(mean(inGroup)!);
      const restAvgR = round(mean(rest)!);
      const strength = Math.abs(t) >= 3 ? 'STRONG' : 'MODERATE';
      observations.push({
        dimension: d.dimension,
        dimensionLabel: d.label,
        group: g.key,
        rTrades: inGroup.length,
        avgR,
        restRTrades: rest.length,
        restAvgR,
        t: round(t),
        strength,
        direction: t > 0 ? 'BETTER' : 'WORSE',
        text: `${d.label}: ${g.key} averaged ${avgR} R over ${inGroup.length} trades vs ${restAvgR} R for the other ${rest.length} (${strength.toLowerCase()} difference, t = ${round(t)}).`,
      });
    }
  }
  observations.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));

  // Execution quality.
  const astra = ordered.filter((e) => e.source === 'ASTRA');
  const entrySlips = ordered.flatMap((e) =>
    e.entry.slippageTicks === null ? [] : [e.entry.slippageTicks],
  );
  const stopSlips = ordered.flatMap((e) =>
    e.exit.reason === 'STOP' && e.exit.slippageTicks !== null ? [e.exit.slippageTicks] : [],
  );
  const observedR = ordered.filter(
    (e) =>
      e.excursion?.coverage === 'FULL' &&
      e.excursion.mfe.r !== null &&
      e.excursion.mae.r !== null &&
      e.result.rMultiple !== null,
  );
  const winners = observedR.filter((e) => e.result.outcome === 'WIN');
  const losers = observedR.filter((e) => e.result.outcome === 'LOSS');
  const winnersMfe = winners.reduce((s, e) => s + e.excursion!.mfe.r!, 0);
  const winnersR = winners.reduce((s, e) => s + e.result.rMultiple!, 0);
  const avg = (xs: number[]) => (xs.length ? round(mean(xs)!) : null);
  const execution: ExecutionQuality = {
    entrySlippage: {
      trades: entrySlips.length,
      avgTicks: avg(entrySlips),
      adversePct: entrySlips.length
        ? round((entrySlips.filter((x) => x > 0).length / entrySlips.length) * 100, 1)
        : null,
    },
    stopSlippage: { trades: stopSlips.length, avgTicks: avg(stopSlips) },
    exitedAsPlannedPct: astra.length
      ? round((astra.filter((e) => e.exitedAsPlanned).length / astra.length) * 100, 1)
      : null,
    protectiveExits: ordered.filter((e) => e.exit.reason === 'PROTECTIVE').length,
    excursion: {
      trades: observedR.length,
      avgMfeR: avg(observedR.map((e) => e.excursion!.mfe.r!)),
      avgMaeR: avg(observedR.map((e) => e.excursion!.mae.r!)),
      winnersCapturePct: winnersMfe > 0 ? round((winnersR / winnersMfe) * 100, 1) : null,
      losersAfterPlusOneR: losers.filter((e) => e.excursion!.mfe.r! >= 1).length,
      losers: losers.length,
    },
  };

  // Notes: what the numbers can and cannot say.
  const notes: string[] = [];
  if (rs.length < minSample)
    notes.push(
      `Only ${rs.length} trade${rs.length === 1 ? '' : 's'} with a known R — too few to judge; observations need at least ${minSample} trades on each side of a comparison.`,
    );
  const noContext = ordered.filter((e) => !e.context).length;
  if (noContext > 0)
    notes.push(
      `${noContext} trade(s) were recorded before trade context existed: their setup and event facts show as not labelled / unknown.`,
    );
  const simulatedEvents = ordered.filter((e) => e.context?.calendarSource === 'SIMULATED').length;
  if (simulatedEvents > 0)
    notes.push(
      `Event facts for ${simulatedEvents} trade(s) come from the SIMULATED placeholder calendar, not real economic events.`,
    );
  const modes = new Set(ordered.map((e) => e.mode ?? '(unknown)'));
  if (modes.size > 1)
    notes.push(
      `Trades from different modes are pooled (${[...modes].sort().join(', ')}); filter by mode to compare like with like.`,
    );
  if (comparisons > 0)
    notes.push(
      `${comparisons} group comparisons were tested; by chance alone about 1 in 20 can show a "moderate" difference — confirm on new data before acting.`,
    );
  notes.push(
    'Observations only: ASTRA never changes risk settings or strategy rules by itself; any change goes through configuration review.',
  );

  return {
    trades: ordered.length,
    from: ordered[0]?.entry.at ?? null,
    to: ordered.at(-1)?.exit.at ?? null,
    timeZone,
    minSample,
    overall,
    curve,
    drawdown: {
      maxR: round(maxR),
      maxMoney: round(maxMoney),
      maxMoneyAt,
      losingStreaks: [...streaks.entries()]
        .map(([length, count]) => ({ length, count }))
        .sort((a, b) => a.length - b.length),
    },
    dimensions,
    execution,
    observations: observations.slice(0, 12),
    notes,
  };
}
