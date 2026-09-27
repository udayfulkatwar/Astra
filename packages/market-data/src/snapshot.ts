/**
 * Market snapshot: everything the scanner shows for one instrument, derived purely from the
 * latest quote and REAL bars. Anything that cannot be derived from observed data is null (or
 * omitted from a list) — never estimated, interpolated or carried forward.
 */
import {
  activeSessions,
  applyFreshness,
  dec,
  marketStatus,
  pct,
  toNum,
  tradingDayWindow,
  type FreshnessPolicy,
  type InstrumentSpec,
  type MarketStatus,
  type Observed,
  type Quote,
  type SessionDefinition,
} from '@astra/core';
import type { Bar } from './bar';
import { averageTrueRange } from './indicators';
import { quoteMid, spreadTicks } from './price';
import { TIMEFRAMES, dailyWindow, type Timeframe } from './timeframe';

export type MarketQualityStatus = 'OK' | 'STALE' | 'SUSPECT' | 'NO_DATA';

export interface MarketSnapshot {
  symbol: string;
  /** Computation time (ISO). */
  asOf: string;
  /** Latest quote with freshness and quality applied. */
  quote: Observed<Quote>;
  mid: number | null;
  spreadTicks: number | null;
  /** Scheduled market status; null when trading hours are not configured. */
  market: MarketStatus | null;
  /** Ids of the sessions active now. */
  activeSessions: string[];
  /** Current D1 bar. */
  today: { open: number; high: number; low: number; close: number } | null;
  /** Last complete D1 bar. */
  previousDay: { high: number; low: number; close: number } | null;
  changeFromPrevClosePct: number | null;
  /** Per ACTIVE session, from M1 bars since that session's start (omitted when not derivable). */
  sessions: { id: string; high: number; low: number }[];
  /** ATR(14), Wilder smoothing, complete bars only; null with fewer than 15 bars. */
  atr: { H1: number | null; D1: number | null };
  quality: { status: MarketQualityStatus; reason: string | null; lastJumpAt: string | null };
  /** Complete bars available per timeframe. */
  barsAvailable: Record<Timeframe, number>;
}

export interface MarketSnapshotInputs {
  readonly symbol: string;
  readonly now: Date;
  /** Instrument facts; undefined when the instrument is not configured. */
  readonly instrument: Pick<InstrumentSpec, 'tickSize' | 'tradingHours'> | undefined;
  readonly sessions: readonly SessionDefinition[];
  /** Latest quote with the quality monitor applied (INVALID while suspect); unfreshened. */
  readonly quote: Observed<Quote>;
  readonly freshness: FreshnessPolicy;
  /** Source time of the last abnormal price jump. */
  readonly lastJumpAt: string | null;
  /** Bars per timeframe, oldest → newest; may end with the in-progress bar (complete: false). */
  readonly bars: Readonly<Record<Timeframe, readonly Bar[]>>;
  /**
   * M1 bars hold every observed minute from this instant on (observation start, or later after
   * window eviction). Null → unknown, so no session range is derived.
   */
  readonly m1CoverageFrom: string | null;
}

function qualityStatus(q: Observed<Quote>): MarketQualityStatus {
  switch (q.status) {
    case 'OK':
      return 'OK';
    case 'STALE':
      return 'STALE';
    case 'INVALID':
      return 'SUSPECT';
    case 'UNKNOWN':
    case 'UNAVAILABLE':
    case 'ERROR':
    case 'TIMEOUT':
      return 'NO_DATA';
  }
}

/** High/low per active session from the M1 bars that opened since the session's start. */
function sessionRanges(i: MarketSnapshotInputs, active: readonly string[]) {
  const coverage = i.m1CoverageFrom === null ? null : Date.parse(i.m1CoverageFrom);
  const nowMs = i.now.getTime();
  const out: { id: string; high: number; low: number }[] = [];
  for (const id of active) {
    const def = i.sessions.find((s) => s.id === id);
    if (!def) continue;
    // The session is active, so its latest start at or before now is the current occurrence.
    const startMs = tradingDayWindow(i.now, {
      timeZone: def.timeZone,
      time: def.start,
    }).start.getTime();
    // Observation began after the session started: its true range is unknown.
    if (coverage === null || coverage > startMs) continue;
    const bars = i.bars.M1.filter((b) => {
      const open = Date.parse(b.openTime);
      return open >= startMs && open <= nowMs;
    });
    if (bars.length === 0) continue;
    out.push({
      id,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
    });
  }
  return out;
}

export function computeMarketSnapshot(i: MarketSnapshotInputs): MarketSnapshot {
  const nowMs = i.now.getTime();
  const quote = applyFreshness(i.quote, i.now, i.freshness);
  const fresh = quote.status === 'OK' ? quote.value : null;
  const hours = i.instrument?.tradingHours;

  const day = dailyWindow(nowMs, hours);
  const todayBar = i.bars.D1.find((b) => Date.parse(b.openTime) === day.openMs) ?? null;
  const previousBar =
    i.bars.D1.filter((b) => b.complete && Date.parse(b.closeTime) <= day.openMs).at(-1) ?? null;
  const change =
    todayBar && previousBar
      ? pct(dec(todayBar.close).minus(previousBar.close), dec(previousBar.close))
      : null;

  const active = activeSessions(i.now, i.sessions);
  const barsAvailable = Object.fromEntries(
    TIMEFRAMES.map((tf) => [tf, i.bars[tf].filter((b) => b.complete).length]),
  ) as Record<Timeframe, number>;

  return {
    symbol: i.symbol,
    asOf: i.now.toISOString(),
    quote,
    mid: fresh ? quoteMid(fresh) : null,
    spreadTicks: fresh && i.instrument ? spreadTicks(fresh, i.instrument.tickSize) : null,
    market: hours ? marketStatus(i.now, hours) : null,
    activeSessions: active,
    today: todayBar
      ? { open: todayBar.open, high: todayBar.high, low: todayBar.low, close: todayBar.close }
      : null,
    previousDay: previousBar
      ? { high: previousBar.high, low: previousBar.low, close: previousBar.close }
      : null,
    changeFromPrevClosePct: change ? toNum(change, 4) : null,
    sessions: sessionRanges(i, active),
    atr: { H1: averageTrueRange(i.bars.H1), D1: averageTrueRange(i.bars.D1) },
    quality: {
      status: qualityStatus(quote),
      reason: quote.status === 'OK' ? null : quote.reason,
      lastJumpAt: i.lastJumpAt,
    },
    barsAvailable,
  };
}
