/** CALENDAR, NEWS and AI layers — CONTEXT can restrict a trade, never approve one. */
import { assessBlackout, describeNotOk, type EventImpact } from '@astra/core';
import { entryWindowEnd } from '../derive';
import { fail, pass, unknown, type GateCheck } from './check';

/** Most restrictive merge of the global default blackout and the strategy blackout. */
export function mergedBlackout(
  global: { impactLevels: readonly EventImpact[]; minutesBefore: number; minutesAfter: number },
  strategy?: { impactLevels: readonly EventImpact[]; minutesBefore: number; minutesAfter: number },
) {
  if (!strategy) return { ...global, impactLevels: [...global.impactLevels] };
  return {
    impactLevels: [...new Set([...global.impactLevels, ...strategy.impactLevels])],
    minutesBefore: Math.max(global.minutesBefore, strategy.minutesBefore),
    minutesAfter: Math.max(global.minutesAfter, strategy.minutesAfter),
  };
}

export const calendarEventBlackout: GateCheck = {
  id: 'calendar.event-blackout',
  layer: 'CALENDAR',
  mandatory: true,
  description:
    'Economic calendar is available, covers the blackout window, and no restricted event is near.',
  evaluate: (i, d) => {
    const c = d.fresh.calendar;
    if (c.status !== 'OK') return unknown(describeNotOk('economic calendar', c));
    const rule = mergedBlackout(i.policy.eventBlackout, i.strategy?.eventBlackout);
    const a = assessBlackout(
      c.value,
      i.candidate.signal.symbol,
      new Date(i.now),
      rule,
      entryWindowEnd(i.candidate.signal),
    );
    if (a.state === 'UNCOVERED') {
      return unknown('economic calendar does not cover the blackout window', {
        coverage: { from: c.value.from, to: c.value.to },
      });
    }
    if (a.state === 'BLACKOUT') {
      return fail(
        a.blocking.map(
          (e) =>
            `${e.impact}-impact event "${e.title}" at ${e.scheduledAt} is within the restricted window`,
        ),
        { blackout: rule, events: a.blocking.map((e) => e.id) },
      );
    }
    const until = entryWindowEnd(i.candidate.signal);
    return pass(
      until
        ? `no restricted events from −${rule.minutesAfter} min to ${rule.minutesBefore} min after the order expires`
        : `no restricted events within −${rule.minutesAfter}/+${rule.minutesBefore} min`,
      { blackout: rule },
    );
  },
};

export const newsRisk: GateCheck = {
  id: 'news.risk',
  layer: 'NEWS',
  mandatory: true,
  description: 'News risk for the instrument is known and acceptable.',
  evaluate: (i, d) => {
    if (!i.policy.news.required) {
      return pass('news assessment not required by policy (news engine not yet mandatory)');
    }
    const n = d.fresh.newsRisk;
    if (n.status !== 'OK') return unknown(describeNotOk('news risk', n));
    if (n.value.symbol !== i.candidate.signal.symbol)
      return fail('news assessment is for a different instrument');
    if (i.policy.news.blockLevels.includes(n.value.level)) {
      return fail(`news risk ${n.value.level}: ${n.value.reasons.join('; ') || 'no detail'}`);
    }
    return pass(`news risk ${n.value.level}`);
  },
};

export const aiAnalysis: GateCheck = {
  id: 'ai.analysis',
  layer: 'AI',
  mandatory: true,
  description: 'When the strategy requires AI analysis, it is valid, fresh and does not conflict.',
  evaluate: (i, d) => {
    if (!i.strategy) return unknown('strategy not found');
    if (!i.strategy.requiresAiAnalysis) return pass('AI analysis not required by strategy');
    const a = d.fresh.aiAnalysis;
    if (a.status !== 'OK') return unknown(describeNotOk('AI analysis', a));
    const v = a.value;
    const reasons: string[] = [];
    if (v.signalId !== i.candidate.signal.id) reasons.push('AI analysis is for a different signal');
    if (v.verdict === 'CONFLICTS') reasons.push(`AI analysis conflicts: ${v.reasons.join('; ')}`);
    if (v.confidence < i.policy.ai.minConfidence) {
      reasons.push(`AI confidence ${v.confidence} below minimum ${i.policy.ai.minConfidence}`);
    }
    if (v.eventRisk === 'HIGH') reasons.push('AI assesses event risk as HIGH');
    return reasons.length > 0
      ? fail(reasons, { model: v.model, analysisId: v.analysisId })
      : pass(`AI analysis ${v.verdict} (confidence ${v.confidence}, model ${v.model})`, {
          analysisId: v.analysisId,
        });
  },
};
