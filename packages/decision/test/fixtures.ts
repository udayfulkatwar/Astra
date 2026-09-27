/** Synthetic TEST fixtures — not real firm rules, broker specs or the owner's strategy. */
import {
  COMPONENT_IDS,
  observed,
  type AccountDefinition,
  type ComponentHealth,
  type DataSourceKind,
  type InstrumentSpec,
  type StrategyDefinition,
} from '@astra/core';
import { PropFirmRuleProfileSchema, type AccountTracking } from '@astra/prop-firm';
import { RiskPolicySchema } from '@astra/risk';
import { KillSwitchRegistry } from '@astra/safety';
import { ManualClock } from '@astra/core';
import type { DecisionPolicy } from '../src/policy';
import type { DecisionInputs } from '../src/types';

export const NOW = '2026-09-28T14:00:00.000Z';
const unverified = { status: 'UNVERIFIED' as const };

export const NQ: InstrumentSpec = {
  symbol: 'NQ',
  displayName: 'Test NQ',
  assetClass: 'FUTURES',
  quantityUnit: 'CONTRACTS',
  quoteCurrency: 'USD',
  tickSize: 0.25,
  tickValue: 5,
  quantityStep: 1,
  minQuantity: 1,
  maxSpreadTicks: 4,
  costs: { commissionPerUnitRoundTurn: 4, slippageAllowanceTicks: 1 },
  verification: unverified,
};

export const profile = PropFirmRuleProfileSchema.parse({
  id: 'test-50k',
  name: 'Test 50K',
  firm: 'TEST',
  program: 'test',
  phase: 'EVALUATION',
  version: 1,
  currency: 'USD',
  accountSize: 50_000,
  verification: unverified,
  tradingDayReset: { timeZone: 'America/New_York', time: '17:00' },
  dailyLoss: {
    limit: { kind: 'AMOUNT', value: 1_000 },
    reference: 'DAY_START_BALANCE',
    measure: 'EQUITY',
    breachConsequence: 'ACCOUNT_FAILED',
  },
  maxDrawdown: {
    type: 'STATIC',
    limit: { kind: 'AMOUNT', value: 2_500 },
    measure: 'EQUITY',
    trailingStopsAt: { kind: 'NEVER' },
  },
  positionLimits: {
    maxContracts: 5,
    maxLots: null,
    quantityWeights: {},
    maxOpenPositions: null,
    perInstrumentMaxQuantity: {},
    maxLeverage: null,
  },
  scaling: null,
  consistency: null,
  news: null,
  holding: { overnight: 'ALLOWED', weekend: 'ALLOWED', flatBy: null, weeklyClose: null },
  trading: { stopLossRequired: true, maxRiskPerTrade: null, hedgingAllowed: false },
  objectives: { profitTarget: null, minTradingDays: null },
  payout: null,
});

export const riskPolicy = RiskPolicySchema.parse({
  id: 'test-policy',
  name: 'Test policy',
  version: 1,
  ownership: 'TEMPLATE',
  perTrade: { riskPercentOfEquity: 0.5, maxRiskAmount: null, minRewardToRisk: 1.5 },
  buffers: { maxDailyBufferUsePct: 50, maxDrawdownBufferUsePct: 25, survivalBufferAmount: 100 },
  exposure: {
    maxOpenRiskPercentOfEquity: 2,
    maxOpenPositions: 3,
    maxPositionsPerInstrument: 1,
    allowPyramiding: false,
  },
  activity: { maxTradesPerDay: 4, maxConsecutiveLosses: 3 },
  health: {
    cautionUsagePct: 40,
    restrictedUsagePct: 70,
    breachRiskUsagePct: 90,
    cautionSizeMultiplier: 0.5,
  },
  timing: { noNewTradesMinutesBeforeFlat: 15 },
  targets: { stopTradingWhenProfitTargetReached: false },
});

export const strategy: StrategyDefinition = {
  id: 'test-strategy',
  name: 'Test',
  version: 1,
  ownership: 'TEMPLATE',
  status: 'ACTIVE',
  description: '',
  instruments: ['NQ'],
  timeframes: ['M5'],
  direction: 'BOTH',
  minRewardToRisk: 2,
  signalTtlSeconds: 120,
  requiresAiAnalysis: false,
  rules: {},
};

export const account: AccountDefinition = {
  id: 'acct-a',
  name: 'Account A',
  firm: 'TEST',
  propFirmProfileId: 'test-50k',
  riskPolicyId: 'test-policy',
  currency: 'USD',
  status: 'ACTIVE',
  broker: { adapterId: 'paper', accountRef: 'PAPER-A' },
  strategies: ['test-strategy'],
  instruments: ['NQ'],
  liveTradingAuthorized: false,
};

export const policy: DecisionPolicy = {
  approvalTtlSeconds: 30,
  freshness: {
    quoteMaxAgeMs: 5_000,
    accountSnapshotMaxAgeMs: 10_000,
    calendarMaxAgeMs: 3_600_000,
    newsMaxAgeMs: 600_000,
    aiAnalysisMaxAgeMs: 300_000,
    maxFutureSkewMs: 2_000,
  },
  maxEntryDeviationTicks: 8,
  requiredComponents: ['DATABASE', 'MARKET_DATA', 'CALENDAR', 'EXECUTION', 'AUTOMATION'],
  allowDegradedComponents: false,
  eventBlackout: { impactLevels: ['HIGH'], minutesBefore: 15, minutesAfter: 15 },
  news: { required: false, blockLevels: ['HIGH'] },
  ai: { minConfidence: 0.6 },
};

export const tracking: AccountTracking = {
  accountId: 'acct-a',
  initialBalance: 50_000,
  tradingDayKey: '2026-09-28',
  dayStartBalance: 50_000,
  dayStartEquity: 50_000,
  dayStartSource: 'OBSERVED_AT_RESET',
  equityPeak: 50_000,
  balancePeak: 50_000,
  endOfDayBalancePeak: 50_000,
  lastBalance: 50_000,
  completedDays: [],
  tradingDaysCount: 0,
  currentDayCounted: false,
  updatedAt: '2026-09-28T13:59:59.000Z',
};

export function healthyComponents(at = NOW): ComponentHealth[] {
  return COMPONENT_IDS.map((component) => ({
    component,
    status: 'ONLINE' as const,
    detail: 'ok',
    checkedAt: at,
  }));
}

export function loadedKillSwitches(): KillSwitchRegistry {
  const r = new KillSwitchRegistry(new ManualClock(NOW));
  r.load([]);
  return r;
}

export function makeInputs(
  overrides: Partial<DecisionInputs> = {},
  sourceKind: DataSourceKind = 'SIMULATED',
): DecisionInputs {
  const meta = { source: 'test', sourceKind, asOf: '2026-09-28T13:59:59.000Z' };
  return {
    decisionId: 'dec_test',
    now: NOW,
    mode: 'PAPER',
    configHash: 'sha256:test',
    policy,
    candidate: {
      accountId: 'acct-a',
      submittedAt: NOW,
      signal: {
        id: 'sig-1',
        strategyId: 'test-strategy',
        symbol: 'NQ',
        direction: 'LONG',
        setupState: 'QUALIFIED',
        entryType: 'MARKET',
        entry: 20_000,
        stop: 19_990,
        target: 20_030,
        timeframe: 'M5',
        detectedAt: '2026-09-28T13:59:30.000Z',
        rationale: ['test setup'],
        features: {},
      },
    },
    account,
    profile,
    riskPolicy,
    strategy,
    instrument: NQ,
    instruments: { NQ },
    quote: observed({ symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf: meta.asOf }, meta),
    accountSnapshot: observed(
      {
        accountId: 'acct-a',
        asOf: meta.asOf,
        currency: 'USD',
        balance: 50_000,
        equity: 50_000,
        openPositions: [],
        pendingOrders: 0,
      },
      meta,
    ),
    tracking: observed(tracking, { ...meta, sourceKind: 'LIVE', source: 'astra-db' }),
    activity: observed(
      { tradingDayKey: '2026-09-28', tradesToday: 0, consecutiveLosses: 0 },
      { ...meta, source: 'astra-db' },
    ),
    calendar: observed(
      { from: '2026-09-28T13:00:00.000Z', to: '2026-09-29T13:00:00.000Z', events: [] },
      meta,
    ),
    newsRisk: { status: 'UNAVAILABLE', reason: 'not requested', source: 'assembler' },
    aiAnalysis: { status: 'UNAVAILABLE', reason: 'not requested', source: 'assembler' },
    duplicates: observed(
      { priorApprovedDecisionId: null, workingOrderForSymbol: false },
      { ...meta, source: 'astra-db' },
    ),
    killSwitches: loadedKillSwitches().evaluate({
      accountId: 'acct-a',
      strategyId: 'test-strategy',
      symbol: 'NQ',
    }),
    componentHealth: healthyComponents(),
    execution: {
      adapterId: 'paper',
      adapterKind: 'PAPER',
      health: 'ONLINE',
      reconciled: true,
      supportedEntryTypes: ['MARKET'],
    },
    liveTradingEnvironmentAuthorized: false,
    ...overrides,
  };
}
