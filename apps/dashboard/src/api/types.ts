/**
 * API response types. Domain types are imported type-only from the ASTRA packages, so the
 * contract is checked by the compiler while nothing from those packages enters the bundle.
 */
import type {
  AccountActivity,
  AccountDefinition,
  AccountSnapshot,
  CalendarWindow,
  ComponentHealth,
  EventImpact,
  HealthStatus,
  InstrumentSpec,
  Observed,
  Quote,
  StrategyDefinition,
  TradingMode,
} from '@astra/core';
import type { EventRiskView, InstrumentEventRisk } from '@astra/calendar';
import type { DecisionInputs, DecisionPolicy, TradeDecision } from '@astra/decision';
import type { ExecutionResult, OrderRecord } from '@astra/execution';
import type { Bar, MarketSnapshot, Timeframe } from '@astra/market-data';
import type { MarketStructure } from '@astra/market-structure';
import type { AccountState, AccountTracking, PropFirmRuleProfile } from '@astra/prop-firm';
import type {
  AccountHealthAssessment,
  AccountMonitorView,
  MonitorAlert,
  MonitorPolicy,
  PositionView,
  RiskPolicy,
} from '@astra/risk';
import type { KillSwitchState } from '@astra/safety';

export type {
  AccountState,
  CalendarWindow,
  EventImpact,
  ComponentHealth,
  HealthStatus,
  KillSwitchState,
  OrderRecord,
  TradeDecision,
  TradingMode,
};

export interface StatusBar {
  now: string;
  system: HealthStatus;
  initialized: boolean;
  mode: TradingMode;
  trading: { enabled: boolean; reasons: string[] };
  risk: string;
  news: { status: HealthStatus; detail: string };
  calendar: { status: HealthStatus; highImpactNext4h: number | null; source: string | null };
  ai: { status: HealthStatus; detail: string };
  automation: { status: HealthStatus; detail: string };
  data: { status: HealthStatus; detail: string };
  killSwitchesActive: number;
  simulation: boolean;
  configHash: string;
  configWarnings: string[];
}

export interface ModeInfo {
  mode: TradingMode;
  loaded: boolean;
  state: {
    mode: TradingMode;
    version: number;
    changedAt: string;
    changedBy: string;
    reason: string;
  } | null;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  realizedPnl: number;
  openedAt: string;
  closedAt: string;
}

export interface AccountView {
  account: Omit<AccountDefinition, 'broker'> & {
    broker: { adapterId: string; accountRef: string };
  };
  snapshot: Observed<AccountSnapshot>;
  tracking: AccountTracking | null;
  state: AccountState | null;
  health: AccountHealthAssessment | null;
  activity: AccountActivity | null;
  error: string | null;
  syncedAt: string | null;
}

export interface AccountDetail extends AccountView {
  closedTrades: ClosedTrade[];
  orders: OrderRecord[];
}

export interface DecisionSummary {
  decisionId: string;
  decidedAt: string;
  accountId: string;
  strategyId: string;
  signalId: string;
  symbol: string;
  direction: string;
  mode: string;
  status: 'APPROVED' | 'REJECTED';
  reasons: string[];
  approvalId: string | null;
  approvalState: string | null;
  approvalExpiresAt: string | null;
  configHash: string;
}

export interface DecisionDetail extends DecisionSummary {
  decision: TradeDecision;
  inputs: DecisionInputs;
}

export interface SystemEvent {
  seq: number;
  id: string;
  at: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  component: string;
  type: string;
  message: string;
  accountId: string | null;
  data: Record<string, unknown>;
}

export interface AuditEntry {
  seq: number;
  id: string;
  at: string;
  actorType: string;
  actorId: string;
  category: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface ConfigSummary {
  hash: string;
  warnings: string[];
  decisionPolicy: DecisionPolicy;
  profiles: PropFirmRuleProfile[];
  riskPolicies: RiskPolicy[];
  instruments: InstrumentSpec[];
  strategies: StrategyDefinition[];
}

export type { ExecutionResult, Observed, Quote };

/** Market scanner snapshot, bars, bar timeframes and market structure (GET /api/v1/market/…). */
export type { Bar, MarketSnapshot, MarketStructure, Timeframe };

/** Event risk per instrument (GET /api/v1/calendar/risk). */
export type { EventRiskView, InstrumentEventRisk };

/** Position monitor (GET /api/v1/monitor/positions). */
export type { AccountMonitorView, MonitorAlert, MonitorPolicy, PositionView };
export interface PositionMonitor {
  asOf: string | null;
  policy: MonitorPolicy;
  accounts: AccountMonitorView[];
  alerts: MonitorAlert[];
}
