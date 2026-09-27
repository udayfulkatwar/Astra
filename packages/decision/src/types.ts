/** DECISION types: gate results, inputs snapshot, and the trade decision record. */
import type {
  AccountActivity,
  AccountDefinition,
  AccountSnapshot,
  AiAnalysis,
  CalendarWindow,
  ComponentHealth,
  Direction,
  EntryType,
  HealthStatus,
  InstrumentSpec,
  NewsRiskAssessment,
  Observed,
  Quote,
  StrategyDefinition,
  TradeCandidate,
  TradingMode,
} from '@astra/core';
import type { AccountTracking, PropFirmRuleProfile } from '@astra/prop-firm';
import type { PositionSizingOk, RiskPolicy } from '@astra/risk';
import type { KillSwitchEvaluation } from '@astra/safety';
import type { DecisionPolicy } from './policy';

export const GATE_LAYERS = [
  'SYSTEM',
  'DATA',
  'MARKET',
  'STRATEGY',
  'NEWS',
  'CALENDAR',
  'AI',
  'RISK',
  'PROP_FIRM',
  'POSITION',
  'EXECUTION',
] as const;
export type GateLayer = (typeof GATE_LAYERS)[number];

export const CHECK_VERDICTS = ['PASS', 'FAIL', 'UNKNOWN', 'ERROR'] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export interface GateCheckResult {
  readonly checkId: string;
  readonly layer: GateLayer;
  readonly mandatory: boolean;
  readonly verdict: CheckVerdict;
  readonly reasons: readonly string[];
  readonly details?: Record<string, unknown>;
}

export interface ExecutionReadiness {
  readonly adapterId: string | null;
  readonly adapterKind: 'PAPER' | 'LIVE' | null;
  readonly health: HealthStatus;
  /** Open orders/positions were reconciled with the broker since startup. */
  readonly reconciled: boolean;
  readonly supportedEntryTypes: readonly EntryType[];
}

export interface DuplicateCheckData {
  /** An APPROVED decision already exists for this signal id (and account). */
  readonly priorApprovedDecisionId: string | null;
  /** An order is already working for this account + symbol. */
  readonly workingOrderForSymbol: boolean;
}

/**
 * The frozen snapshot every decision is made from. It is persisted with the decision so any
 * decision can be reproduced and explained later. Configuration entities are included in full.
 */
export interface DecisionInputs {
  readonly decisionId: string;
  readonly now: string;
  readonly mode: TradingMode;
  readonly configHash: string;
  readonly policy: DecisionPolicy;
  readonly candidate: TradeCandidate;
  readonly account: AccountDefinition | null;
  readonly profile: PropFirmRuleProfile | null;
  readonly riskPolicy: RiskPolicy | null;
  readonly strategy: StrategyDefinition | null;
  /** Spec of the candidate's instrument (null = unknown instrument). */
  readonly instrument: InstrumentSpec | null;
  /** Specs for every instrument the account may hold (open-risk and position-limit math). */
  readonly instruments: Readonly<Record<string, InstrumentSpec>>;
  readonly quote: Observed<Quote>;
  readonly accountSnapshot: Observed<AccountSnapshot>;
  readonly tracking: Observed<AccountTracking>;
  readonly activity: Observed<AccountActivity>;
  readonly calendar: Observed<CalendarWindow>;
  readonly newsRisk: Observed<NewsRiskAssessment>;
  readonly aiAnalysis: Observed<AiAnalysis>;
  readonly duplicates: Observed<DuplicateCheckData>;
  readonly killSwitches: KillSwitchEvaluation;
  readonly componentHealth: readonly ComponentHealth[];
  readonly execution: ExecutionReadiness;
  readonly liveTradingEnvironmentAuthorized: boolean;
}

export type DecisionStatus = 'APPROVED' | 'REJECTED';

export interface ApprovedOrderPlan {
  readonly symbol: string;
  readonly direction: Direction;
  readonly entryType: EntryType;
  /** Executable price at decision time (ask for LONG, bid for SHORT). */
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  readonly quantity: number;
}

export interface DecisionExplanation {
  readonly what: string;
  readonly why: readonly string[];
  readonly when: string;
  readonly risk: string;
  readonly invalidatedBy: readonly string[];
  readonly wouldStop: readonly string[];
}

export interface TradeDecision {
  readonly decisionId: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly signalId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly mode: TradingMode;
  readonly status: DecisionStatus;
  readonly reasons: readonly string[];
  readonly checks: readonly GateCheckResult[];
  readonly sizing: PositionSizingOk | null;
  readonly orderPlan: ApprovedOrderPlan | null;
  readonly approval: { readonly approvalId: string; readonly expiresAt: string } | null;
  readonly configHash: string;
  readonly decidedAt: string;
  readonly explanation: DecisionExplanation;
}
