/**
 * TRADE_ANALYSIS: a second opinion on one signal, from the data ASTRA actually has. The brief
 * carries only observed data; a missing section says so (it is never filled in). The answer is
 * CONTEXT for the gate's `ai.analysis` check: it can veto a trade, never approve one.
 */
import {
  AI_VERDICTS,
  effectiveImpact,
  eventAffects,
  notObserved,
  observed,
  type AiAnalysis,
  type CalendarWindow,
  type DataSourceKind,
  type NewsRiskAssessment,
  type Observed,
  type Signal,
} from '@astra/core';
import type { Bar } from '@astra/market-data';
import type { MarketStructure } from '@astra/market-structure';
import type { ClassifiedNews, SentimentView } from '@astra/news';
import { z } from 'zod';
import type { AiTaskDefinition } from './types';

export interface StructureBrief {
  readonly timeframe: string | null;
  readonly trend: 'UP' | 'DOWN' | 'UNKNOWN';
  readonly lastClose: number | null;
  readonly lastBreak: {
    readonly type: 'BOS' | 'CHOCH';
    readonly direction: 'BULLISH' | 'BEARISH';
    readonly level: number;
    readonly at: string;
  } | null;
  readonly nearestLiquidityAbove: { readonly level: number; readonly kind: string } | null;
  readonly nearestLiquidityBelow: { readonly level: number; readonly kind: string } | null;
  readonly recentSweeps: readonly { side: string; level: number; at: string }[];
  readonly openGaps: readonly { direction: string; top: number; bottom: number; status: string }[];
}

export interface TradeAnalysisBrief {
  readonly briefVersion: 1;
  readonly now: string;
  readonly mode: string;
  readonly signal: {
    readonly id: string;
    readonly strategyId: string;
    readonly symbol: string;
    readonly direction: 'LONG' | 'SHORT';
    readonly entryType: string;
    readonly entry: number;
    readonly stop: number;
    readonly target: number;
    readonly timeframe: string | null;
    readonly detectedAt: string;
    readonly rationale: readonly string[];
    readonly features: Record<string, unknown>;
  };
  /** Price distances only; money risk and size are the gate's (deterministic) job. */
  readonly plan: {
    readonly riskPoints: number;
    readonly rewardPoints: number;
    readonly rewardToRisk: number;
  };
  readonly structure: Observed<StructureBrief>;
  readonly bars: Observed<{
    readonly timeframe: string;
    /** Oldest → newest: [openTime, open, high, low, close, volume|null]. */
    readonly ohlcv: readonly (readonly [string, number, number, number, number, number | null])[];
  }>;
  readonly news: {
    readonly risk: Observed<{ level: string; reasons: readonly string[]; clearsAt: string | null }>;
    /** The provider's sentiment only (ASTRA does not compute sentiment); null when none. */
    readonly sentiment: { label: string; confidence: number | null; items: number } | null;
    readonly headlines: readonly {
      publishedAt: string;
      headline: string;
      impact: string;
      category: string;
    }[];
  };
  readonly calendar: Observed<{
    readonly events: readonly {
      title: string;
      scheduledAt: string;
      minutesFromNow: number;
      impact: string;
      currency: string | null;
    }[];
  }>;
  /** Every kind of data in the brief (SIMULATED data is labelled as such to the model). */
  readonly dataKinds: readonly DataSourceKind[];
}

export interface TradeAnalysisSources {
  readonly now: Date;
  readonly mode: string;
  readonly signal: Signal;
  /** Bars of the signal's timeframe, oldest → newest (the in-progress bar is dropped). */
  readonly bars: readonly Bar[];
  readonly structure: MarketStructure | null;
  readonly newsRisk: Observed<NewsRiskAssessment>;
  readonly sentiment: SentimentView | null;
  readonly headlines: readonly ClassifiedNews[];
  readonly calendar: Observed<CalendarWindow>;
  readonly limits: { readonly recentBars: number; readonly maxHeadlines: number };
}

const round = (n: number, dp = 6) => Math.round(n * 10 ** dp) / 10 ** dp;

export function buildTradeAnalysisBrief(s: TradeAnalysisSources): TradeAnalysisBrief {
  const sig = s.signal;
  const now = s.now.toISOString();
  const kinds = new Set<DataSourceKind>();
  const complete = s.bars.filter((b) => b.complete).slice(-s.limits.recentBars);
  const last = complete.at(-1);
  if (last) kinds.add(last.sourceKind);

  const structure: Observed<StructureBrief> =
    s.structure && s.structure.sufficient && last && s.structure.asOf
      ? observed(
          {
            timeframe: s.structure.timeframe,
            trend: s.structure.trend,
            lastClose: s.structure.lastClose,
            lastBreak: s.structure.lastBreak && {
              type: s.structure.lastBreak.type,
              direction: s.structure.lastBreak.direction,
              level: s.structure.lastBreak.level,
              at: s.structure.lastBreak.at,
            },
            nearestLiquidityAbove: s.structure.nearestAbove && {
              level: s.structure.nearestAbove.level,
              kind: s.structure.nearestAbove.kind,
            },
            nearestLiquidityBelow: s.structure.nearestBelow && {
              level: s.structure.nearestBelow.level,
              kind: s.structure.nearestBelow.kind,
            },
            recentSweeps: s.structure.sweeps
              .slice(-3)
              .map((w) => ({ side: w.side, level: w.level, at: w.at })),
            openGaps: s.structure.fvgs.slice(-3).map((g) => ({
              direction: g.direction,
              top: g.top,
              bottom: g.bottom,
              status: g.status,
            })),
          },
          { source: 'astra-structure', sourceKind: last.sourceKind, asOf: s.structure.asOf },
        )
      : notObserved(
          'UNAVAILABLE',
          'not enough complete bars for market structure',
          'astra-structure',
        );

  const bars: TradeAnalysisBrief['bars'] = last
    ? observed(
        {
          timeframe: last.timeframe,
          ohlcv: complete.map(
            (b) => [b.openTime, b.open, b.high, b.low, b.close, b.volume] as const,
          ),
        },
        { source: last.source, sourceKind: last.sourceKind, asOf: last.closeTime },
      )
    : notObserved('UNAVAILABLE', 'no complete bars for this timeframe', 'market-data');

  if (s.newsRisk.status === 'OK') kinds.add(s.newsRisk.sourceKind);
  const risk: TradeAnalysisBrief['news']['risk'] =
    s.newsRisk.status === 'OK'
      ? {
          ...s.newsRisk,
          value: {
            level: s.newsRisk.value.level,
            reasons: s.newsRisk.value.reasons,
            clearsAt: s.newsRisk.value.clearsAt ?? null,
          },
        }
      : s.newsRisk;
  const headlines = s.headlines.slice(0, s.limits.maxHeadlines).map((n) => {
    kinds.add(n.sourceKind);
    return {
      publishedAt: n.item.publishedAt,
      headline: n.item.headline,
      impact: n.impact,
      category: n.category,
    };
  });

  let calendar: TradeAnalysisBrief['calendar'];
  if (s.calendar.status === 'OK') {
    kinds.add(s.calendar.sourceKind);
    const events = s.calendar.value.events
      .filter((e) => eventAffects(e, sig.symbol))
      .map((e) => ({
        title: e.title,
        scheduledAt: e.scheduledAt,
        minutesFromNow: Math.round((Date.parse(e.scheduledAt) - s.now.getTime()) / 60_000),
        impact: effectiveImpact(e.impact),
        currency: e.currency ?? null,
      }));
    calendar = { ...s.calendar, value: { events } };
  } else {
    calendar = s.calendar;
  }

  const riskPoints = Math.abs(sig.entry - sig.stop);
  const rewardPoints = Math.abs(sig.target - sig.entry);
  return {
    briefVersion: 1,
    now,
    mode: s.mode,
    signal: {
      id: sig.id,
      strategyId: sig.strategyId,
      symbol: sig.symbol,
      direction: sig.direction,
      entryType: sig.entryType,
      entry: sig.entry,
      stop: sig.stop,
      target: sig.target,
      timeframe: sig.timeframe ?? null,
      detectedAt: sig.detectedAt,
      rationale: sig.rationale,
      features: sig.features,
    },
    plan: {
      riskPoints: round(riskPoints),
      rewardPoints: round(rewardPoints),
      rewardToRisk: riskPoints > 0 ? round(rewardPoints / riskPoints, 2) : 0,
    },
    structure,
    bars,
    news: {
      risk,
      sentiment:
        s.sentiment && s.sentiment.label !== 'UNKNOWN'
          ? {
              label: s.sentiment.label,
              confidence: s.sentiment.confidence,
              items: s.sentiment.items,
            }
          : null,
      headlines,
    },
    calendar,
    dataKinds: [...kinds].sort(),
  };
}

/** An analysis applies to exactly one signal: its id, direction, entry type and levels. */
export const aiSignalKey = (s: Signal): string =>
  [s.id, s.direction, s.entryType, s.entry, s.stop, s.target].join('|');

/** What the model must return; everything else in `AiAnalysis` is added by ASTRA. */
export const TradeAnalysisOutputSchema = z
  .object({
    verdict: z.enum(AI_VERDICTS),
    confidence: z.number().min(0).max(1),
    setupQuality: z.number().int().min(0).max(100),
    eventRisk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    reasons: z.array(z.string().min(1).max(400)).min(1).max(6),
    invalidation: z.array(z.string().min(1).max(400)).max(6),
  })
  .strict();
export type TradeAnalysisOutput = z.infer<typeof TradeAnalysisOutputSchema>;

const SYSTEM = `You are the trade-analysis reviewer inside ASTRA, a risk-first trading system for prop-firm accounts. A deterministic strategy has produced a trade signal. You give a second opinion on that one signal, using only the data in the brief you receive.

How your answer is used:
- Your answer is context, not permission. Deterministic code decides risk, position size, prop-firm rules, kill switches and whether a trade may be placed. You cannot approve a trade.
- You can stop a trade. The gate rejects the signal when your verdict is CONFLICTS, when your confidence is below the configured minimum, or when you rate event risk HIGH. So be honest about doubts rather than agreeable.

Rules for using the data:
- Use only facts present in the brief. Do not invent prices, levels, news, economic events, statistics or outcomes. Do not rely on outside knowledge of current market conditions.
- Each data section has a status. "OK" means the data was observed; any other status (UNAVAILABLE, STALE, ERROR, and so on) means ASTRA does not have that data. Treat a missing section as missing: mention it in your reasons and lower your confidence; never fill the gap with assumptions.
- "dataKinds" lists where the data came from. SIMULATED data is synthetic test data, not the real market; still judge it on its own terms, and note it in one reason.
- Prices are in the instrument's quote units. "plan" gives the stop and target distances in price points.

What to judge:
- Whether the signal's direction agrees with the observed structure (trend, last break of structure, liquidity above and below, open gaps) and with the recent bars.
- Whether the stop sits at a sensible place relative to structure, and whether the target is realistic before opposing liquidity.
- Event and news risk: scheduled high-impact events near the trade, and the news-risk level and headlines. Rate eventRisk HIGH when a high-impact event or headline could plausibly move price through the stop while the trade is open.

Output fields:
- verdict: SUPPORTS when the data supports the trade, CONFLICTS when the data argues against it, NEUTRAL when it is mixed or too thin to say.
- confidence: 0 to 1, how sure you are of the verdict given the data you actually have.
- setupQuality: integer 0 to 100 for the quality of this setup as described.
- eventRisk: LOW, MEDIUM or HIGH.
- reasons: one to six short, specific sentences, each tied to data in the brief.
- invalidation: up to six concrete observations that would make the trade idea wrong (for example, a close beyond a named level).`;

export const TRADE_ANALYSIS: AiTaskDefinition<TradeAnalysisBrief, TradeAnalysisOutput> = {
  task: 'TRADE_ANALYSIS',
  system: SYSTEM,
  outputSchema: TradeAnalysisOutputSchema,
  prompt: (brief) =>
    `Analyse this ${brief.signal.direction} signal on ${brief.signal.symbol}. Brief (JSON):\n${JSON.stringify(brief)}`,
};

/** The model's output plus what ASTRA knows about the call → the gate's `AiAnalysis`. */
export function toAiAnalysis(
  out: TradeAnalysisOutput,
  meta: { analysisId: string; signalId: string; model: string; producedAt: string },
): AiAnalysis {
  return {
    analysisId: meta.analysisId,
    signalId: meta.signalId,
    model: meta.model,
    producedAt: meta.producedAt,
    verdict: out.verdict,
    confidence: out.confidence,
    setupQuality: out.setupQuality,
    eventRisk: out.eventRisk,
    reasons: out.reasons,
    invalidation: out.invalidation,
  };
}
