/**
 * SIMULATED stand-in for an AI model: a few fixed rules over the same brief a model would see.
 * It is NOT an AI model and NOT analysis — it exists so the whole AI path (routing, budget,
 * validation, call log, the gate's veto) runs in tests, simulation mode and the browser demo
 * without an API key. Its output is SIMULATED: the gate refuses it in SHADOW and LIVE.
 */
import type { PostTradeReviewBrief, PostTradeReviewOutput } from './post-trade-review';
import type { TradeAnalysisBrief, TradeAnalysisOutput } from './trade-analysis';
import type { AiProvider, AiProviderRequest, AiProviderResponse } from './types';

export const SIMULATED_MODEL = 'simulated-rules-v1';
const LABEL = 'SIMULATED stand-in (fixed rules, not an AI model)';
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function simulatedTradeAnalysis(b: TradeAnalysisBrief): TradeAnalysisOutput {
  const long = b.signal.direction === 'LONG';
  const reasons: string[] = [LABEL];
  let score = 0;

  if (b.structure.status === 'OK') {
    const s = b.structure.value;
    const want = long ? 'UP' : 'DOWN';
    if (s.trend === want) {
      score += 1;
      reasons.push(`Trend ${s.trend} agrees with the ${b.signal.direction} signal`);
    } else if (s.trend !== 'UNKNOWN') {
      score -= 2;
      reasons.push(`Trend ${s.trend} is against the ${b.signal.direction} signal`);
    } else {
      reasons.push('Trend is not established');
    }
    if (s.lastBreak) {
      const agrees = (s.lastBreak.direction === 'BULLISH') === long;
      score += agrees ? 1 : -1;
      reasons.push(
        `Last ${s.lastBreak.type} was ${s.lastBreak.direction.toLowerCase()} at ${s.lastBreak.level}`,
      );
    }
  } else {
    reasons.push(`Market structure unavailable: ${b.structure.reason}`);
  }

  const rr = b.plan.rewardToRisk;
  if (rr >= 2) score += 1;
  else if (rr < 1) score -= 1;
  reasons.push(`Reward-to-risk ${rr}`);

  let eventRisk: TradeAnalysisOutput['eventRisk'] = 'LOW';
  if (b.calendar.status === 'OK') {
    const near = b.calendar.value.events.filter(
      (e) => e.minutesFromNow >= -15 && e.minutesFromNow <= 60,
    );
    if (near.some((e) => e.impact === 'HIGH')) eventRisk = 'HIGH';
    else if (near.some((e) => e.impact === 'MEDIUM')) eventRisk = 'MEDIUM';
    if (near[0]) reasons.push(`Event within the hour: ${near[0].title}`);
  } else {
    eventRisk = 'MEDIUM';
    reasons.push('Calendar unavailable, event risk unknown');
  }
  if (b.news.risk.status === 'OK') {
    if (b.news.risk.value.level === 'HIGH') eventRisk = 'HIGH';
    else if (b.news.risk.value.level === 'ELEVATED' && eventRisk === 'LOW') eventRisk = 'MEDIUM';
  } else if (eventRisk === 'LOW') {
    eventRisk = 'MEDIUM';
  }

  const verdict = score >= 2 ? 'SUPPORTS' : score <= -1 ? 'CONFLICTS' : 'NEUTRAL';
  const structureKnown = b.structure.status === 'OK';
  const confidence = r2(clamp(0.5 + 0.1 * Math.abs(score) - (structureKnown ? 0 : 0.2), 0, 0.85));
  const invalidation = [
    `A close beyond the stop at ${b.signal.stop}.`,
    `A ${long ? 'bearish' : 'bullish'} break of structure before entry.`,
  ];
  return {
    verdict,
    confidence,
    setupQuality: clamp(Math.round(50 + 12 * score), 0, 100),
    eventRisk,
    reasons: reasons.slice(0, 6),
    invalidation,
  };
}

export function simulatedTradeReview(b: PostTradeReviewBrief): PostTradeReviewOutput {
  const t = b.trade;
  const slip = t.entry.slippageTicks ?? 0;
  const protective = t.exit.reason === 'PROTECTIVE';
  const ruleViolations = t.source === 'EXTERNAL' ? ['Placed outside ASTRA: no gate decision.'] : [];
  const executionIssues = slip > 2 ? [`Entry slipped ${slip} ticks from plan.`] : [];
  const poor = t.source === 'EXTERNAL' || slip > 4 || (!t.exitedAsPlanned && !protective);
  const rr = t.plan?.rewardToRisk ?? null;
  const process = poor ? 'POOR' : 'GOOD';
  const outcome = t.result.outcome.toLowerCase();
  return {
    process,
    setupQuality: rr === null ? 30 : rr >= 2 ? 70 : rr >= 1 ? 55 : 40,
    entryQuality: clamp(90 - 10 * Math.max(0, slip), 0, 100),
    exitQuality: t.exitedAsPlanned ? 80 : protective ? 60 : 40,
    ruleViolations,
    executionIssues,
    lessons: [
      poor
        ? 'The plan was not followed end to end; review the step that deviated.'
        : `The plan was followed; a ${outcome} on a valid plan needs no change from this trade alone.`,
    ],
    proposals:
      slip > 4
        ? [
            {
              parameter: `strategy ${t.strategyId ?? 'unknown'} entry type`,
              suggestion: 'Consider LIMIT entries for this setup.',
              rationale: `Entry slipped ${slip} ticks.`,
            },
          ]
        : [],
    summary: `${LABEL}: ${process === 'GOOD' ? 'good' : 'poor'} process, ${outcome} (${t.result.rMultiple ?? 'unknown'} R), exit by ${t.exit.reason.toLowerCase()}.`,
  };
}

/** Provider wrapper: returns JSON text so the orchestrator validates it like a model's answer. */
export class SimulatedAiProvider implements AiProvider {
  readonly id = 'simulated';
  readonly kind = 'SIMULATED' as const;

  complete(req: AiProviderRequest, signal: AbortSignal): Promise<AiProviderResponse> {
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    const out =
      req.task === 'TRADE_ANALYSIS'
        ? simulatedTradeAnalysis(req.input as TradeAnalysisBrief)
        : simulatedTradeReview(req.input as PostTradeReviewBrief);
    return Promise.resolve({
      text: JSON.stringify(out),
      stop: 'COMPLETE',
      servedModel: SIMULATED_MODEL,
      fallbackUsed: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  }
}
