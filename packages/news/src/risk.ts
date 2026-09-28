/**
 * News risk per instrument (the CONTEXT the gate's `news.risk` check consumes) and the sentiment
 * summary (spec §19). Both are computed only from items that were actually received; neither can
 * approve a trade. Sentiment uses provider-given sentiment only — with none, it is UNKNOWN.
 */
import type { NewsRiskLevel } from '@astra/core';
import type { ClassifiedNews } from './classify';
import type { SentimentLabel } from './item';

export interface NewsRiskRule {
  /** A HIGH-impact item for the instrument makes its news risk HIGH for this long. */
  readonly highImpactMinutes: number;
  /** A MEDIUM-impact item makes it ELEVATED for this long. */
  readonly mediumImpactMinutes: number;
}

/** DEFAULTS (config `news.risk`), to review against the owner's rules. */
export const DEFAULT_NEWS_RISK_RULE: NewsRiskRule = {
  highImpactMinutes: 30,
  mediumImpactMinutes: 15,
};

export interface NewsRiskResult {
  readonly level: NewsRiskLevel;
  readonly reasons: string[];
  /** Keys of the items that set the level. */
  readonly items: string[];
  /** When the current level lapses if nothing new arrives; null at NORMAL. */
  readonly clearsAt: string | null;
}

const affects = (n: ClassifiedNews, symbol: string) => n.affected.some((a) => a.symbol === symbol);

export function assessNewsRisk(
  items: readonly ClassifiedNews[],
  symbol: string,
  now: Date,
  rule: NewsRiskRule,
): NewsRiskResult {
  const t = now.getTime();
  const within = (n: ClassifiedNews, minutes: number) => {
    const at = Date.parse(n.item.publishedAt);
    return at <= t && t - at < minutes * 60_000;
  };
  const relevant = items.filter((n) => affects(n, symbol));
  const high = relevant.filter((n) => n.impact === 'HIGH' && within(n, rule.highImpactMinutes));
  const medium = relevant.filter(
    (n) => n.impact === 'MEDIUM' && within(n, rule.mediumImpactMinutes),
  );
  const [level, set, minutes]: [NewsRiskLevel, ClassifiedNews[], number] = high.length
    ? ['HIGH', high, rule.highImpactMinutes]
    : medium.length
      ? ['ELEVATED', medium, rule.mediumImpactMinutes]
      : ['NORMAL', [], 0];
  const ordered = [...set].sort((a, b) => b.item.publishedAt.localeCompare(a.item.publishedAt));
  const lapse = ordered.length
    ? Math.max(...ordered.map((n) => Date.parse(n.item.publishedAt))) + minutes * 60_000
    : null;
  return {
    level,
    reasons: ordered.map(
      (n) =>
        `${n.impact}-impact ${n.category.toLowerCase().replace('_', ' ')} news ${Math.max(0, Math.round((t - Date.parse(n.item.publishedAt)) / 60_000))} min ago: "${n.item.headline}" (${n.source})`,
    ),
    items: ordered.map((n) => n.key),
    clearsAt: lapse === null ? null : new Date(lapse).toISOString(),
  };
}

export type SentimentOrUnknown = SentimentLabel | 'UNKNOWN';

export interface SentimentView {
  readonly label: SentimentOrUnknown;
  /** −2 (very bearish) … +2 (very bullish); null without sentiment-bearing items. */
  readonly score: number | null;
  /** Average provider confidence, reduced when fewer than 5 items contribute; null without items. */
  readonly confidence: number | null;
  /** Last hour vs the rest of the window. */
  readonly momentum: 'RISING' | 'FALLING' | 'STEADY' | 'UNKNOWN';
  readonly items: number;
  /** Any contributing item came from SIMULATED data. */
  readonly simulated: boolean;
}

const VALUE: Record<SentimentLabel, number> = {
  VERY_BULLISH: 2,
  BULLISH: 1,
  NEUTRAL: 0,
  BEARISH: -1,
  VERY_BEARISH: -2,
};
const IMPACT_WEIGHT = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;

export function labelOf(score: number): SentimentLabel {
  if (score >= 1.25) return 'VERY_BULLISH';
  if (score >= 0.4) return 'BULLISH';
  if (score > -0.4) return 'NEUTRAL';
  if (score > -1.25) return 'BEARISH';
  return 'VERY_BEARISH';
}

/** Recency-weighted provider sentiment for one instrument over `windowHours` (CONTEXT only). */
export function sentimentFor(
  items: readonly ClassifiedNews[],
  symbol: string,
  now: Date,
  opts: { windowHours?: number; halfLifeMinutes?: number } = {},
): SentimentView {
  const t = now.getTime();
  const windowMs = (opts.windowHours ?? 6) * 3_600_000;
  const halfLife = (opts.halfLifeMinutes ?? 120) * 60_000;
  const use = items.filter((n) => {
    const at = Date.parse(n.item.publishedAt);
    return n.sentiment !== null && affects(n, symbol) && at <= t && t - at < windowMs;
  });
  const score = (list: readonly ClassifiedNews[]) => {
    let sw = 0;
    let sv = 0;
    for (const n of list) {
      const age = t - Date.parse(n.item.publishedAt);
      const wgt = IMPACT_WEIGHT[n.impact] * n.sentiment!.confidence * 0.5 ** (age / halfLife);
      sw += wgt;
      sv += wgt * VALUE[n.sentiment!.label];
    }
    return sw > 0 ? sv / sw : null;
  };
  const all = score(use);
  if (all === null)
    return {
      label: 'UNKNOWN',
      score: null,
      confidence: null,
      momentum: 'UNKNOWN',
      items: 0,
      simulated: false,
    };
  const recent = use.filter((n) => t - Date.parse(n.item.publishedAt) < 3_600_000);
  const earlier = use.filter((n) => t - Date.parse(n.item.publishedAt) >= 3_600_000);
  const r = score(recent);
  const e = score(earlier);
  const momentum =
    r === null || e === null
      ? 'UNKNOWN'
      : r - e > 0.5
        ? 'RISING'
        : e - r > 0.5
          ? 'FALLING'
          : 'STEADY';
  const avgConfidence = use.reduce((s, n) => s + n.sentiment!.confidence, 0) / use.length;
  return {
    label: labelOf(all),
    score: Math.round(all * 100) / 100,
    confidence: Math.round(avgConfidence * Math.min(1, use.length / 5) * 100) / 100,
    momentum,
    items: use.length,
    simulated: use.some((n) => n.sourceKind === 'SIMULATED'),
  };
}

/** Spec §19 "combined context", e.g. "Bullish but high event risk". Context, never a signal. */
export function combinedContext(
  sentiment: SentimentOrUnknown,
  newsRisk: NewsRiskLevel | 'UNKNOWN',
  calendar: 'CLEAR' | 'BLACKOUT' | 'UNKNOWN',
): string {
  const mood =
    sentiment === 'UNKNOWN'
      ? 'Sentiment unknown'
      : sentiment.charAt(0) + sentiment.slice(1).toLowerCase().replace('_', ' ');
  const risks: string[] = [];
  if (newsRisk === 'HIGH') risks.push('high news risk');
  else if (newsRisk === 'ELEVATED') risks.push('elevated news risk');
  else if (newsRisk === 'UNKNOWN') risks.push('news risk unknown');
  if (calendar === 'BLACKOUT') risks.push('inside an event blackout');
  else if (calendar === 'UNKNOWN') risks.push('calendar unknown');
  return risks.length ? `${mood} — ${risks.join(', ')}` : `${mood}, no elevated event risk`;
}
