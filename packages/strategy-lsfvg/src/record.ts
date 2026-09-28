/**
 * The SPEC §26 decision output: one record per complete sequence, whether it traded or not.
 * Structural fields come from the engine; RISK %, NEWS FILTER, CORRELATION CHECK and the final
 * DECISION come from ASTRA's gate — without a gate result they say so (never assumed).
 */
import type { LsfvgRejection, LsfvgSetup } from './engine';

/** What the gate decided, reduced to what §26 needs. */
export interface GateOutcome {
  readonly status: 'APPROVED' | 'REJECTED';
  readonly reasons: readonly string[];
  /** Worst-case risk of the sized trade, % of equity (null when not sized). */
  readonly riskPercent: number | null;
  /** Verdicts of the calendar blackout and news-risk checks. */
  readonly newsFilter: string;
  /** Verdict of the strategy limits (correlated exposure). */
  readonly correlation: string;
}

export const RECORD_FIELDS = [
  'PAIR',
  'TIMESTAMP',
  'DIRECTION',
  'H1 BIAS',
  'LIQUIDITY TYPE',
  'LIQUIDITY LEVEL',
  'SWEEP CONFIRMED',
  'CHoCH/BOS',
  'DISPLACEMENT',
  'FVG RANGE',
  'ENTRY',
  'STOP LOSS',
  'TARGET',
  'RISK %',
  'EXPECTED RR',
  'SETUP SCORE',
  'NEWS FILTER',
  'CORRELATION CHECK',
  'DECISION',
  'REJECTION REASON',
] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];
export type DecisionRecord = Readonly<Record<RecordField, string>>;

const NOT_EVALUATED = 'not evaluated (no gate decision)';

export function decisionRecord(
  item: { setup: LsfvgSetup } | { rejection: LsfvgRejection },
  gate?: GateOutcome,
): DecisionRecord {
  const s = 'setup' in item ? item.setup : null;
  const r = 'rejection' in item ? item.rejection : null;
  const x = s ?? r!.partial;
  const decision = s
    ? gate
      ? gate.status === 'APPROVED'
        ? 'TRADE'
        : 'REJECT'
      : 'PENDING GATE'
    : 'REJECT';
  const reason = r
    ? `${r.stage}: ${r.reason}`
    : gate && gate.status === 'REJECTED'
      ? gate.reasons.join('; ')
      : '';
  return {
    PAIR: x.symbol,
    TIMESTAMP: x.detectedAt,
    DIRECTION: x.direction,
    'H1 BIAS': `${x.h1Bias.bias} (${x.h1Bias.reason})`,
    'LIQUIDITY TYPE': x.liquidity.name,
    'LIQUIDITY LEVEL': String(x.liquidity.price),
    'SWEEP CONFIRMED': `YES — extreme ${x.sweep.extreme}, closed back at ${x.sweep.reclaimedAt}`,
    'CHoCH/BOS': `${x.structure.kind} through ${x.structure.swingPrice}`,
    DISPLACEMENT: `body ${x.displacement.bodyToRange} of range, ${x.displacement.bodyToAtr} × M15 ATR`,
    'FVG RANGE': `${x.fvg.low} – ${x.fvg.high}`,
    ENTRY: s ? `${s.entry} (LIMIT, until ${s.expiresAt})` : '—',
    'STOP LOSS': s ? String(s.stop) : '—',
    TARGET: s ? `${s.target} (${s.targetSource})` : '—',
    'RISK %': gate
      ? gate.riskPercent === null
        ? 'not sized'
        : `${gate.riskPercent}%`
      : NOT_EVALUATED,
    'EXPECTED RR': s ? String(s.rewardToRisk) : '—',
    'SETUP SCORE': s ? `${s.score.total}/${s.score.max} (+2 on retrace)` : '—',
    'NEWS FILTER': gate ? gate.newsFilter : NOT_EVALUATED,
    'CORRELATION CHECK': gate ? gate.correlation : NOT_EVALUATED,
    DECISION: decision,
    'REJECTION REASON': reason,
  };
}

/** The parts of an ASTRA gate decision the record needs (structurally a TradeDecision). */
export interface GateDecisionLike {
  readonly status: 'APPROVED' | 'REJECTED';
  readonly reasons: readonly string[];
  readonly sizing: { readonly riskPctOfEquity: number } | null;
  readonly checks: readonly {
    readonly checkId: string;
    readonly verdict: string;
    readonly reasons: readonly string[];
  }[];
}

export function gateOutcome(d: GateDecisionLike): GateOutcome {
  const verdict = (id: string) => {
    const c = d.checks.find((x) => x.checkId === id);
    return c ? `${c.verdict}${c.verdict === 'PASS' ? '' : `: ${c.reasons.join('; ')}`}` : 'not run';
  };
  return {
    status: d.status,
    reasons: d.reasons,
    riskPercent: d.sizing?.riskPctOfEquity ?? null,
    newsFilter: `calendar ${verdict('calendar.event-blackout')} · news ${verdict('news.risk')}`,
    correlation: verdict('strategy.limits'),
  };
}

export const renderRecord = (rec: DecisionRecord): string =>
  RECORD_FIELDS.map((f) => `${f}: ${rec[f]}`).join('\n');
