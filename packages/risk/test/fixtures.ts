/** Synthetic TEST fixtures — not real firm rules or broker specs. */
import type { AccountSnapshot, InstrumentSpec, StrategyDefinition } from '@astra/core';
import {
  PropFirmRuleProfileSchema,
  computeAccountState,
  type AccountState,
  type AccountTracking,
  type PropFirmRuleProfile,
  type QuantityHeadroom,
} from '@astra/prop-firm';
import { RiskPolicySchema, type RiskPolicy } from '../src/policy';

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

export const XAU: InstrumentSpec = {
  symbol: 'XAUUSD',
  displayName: 'Test Gold',
  assetClass: 'CFD_METAL',
  quantityUnit: 'LOTS',
  quoteCurrency: 'USD',
  tickSize: 0.01,
  tickValue: 1,
  quantityStep: 0.01,
  minQuantity: 0.01,
  maxQuantity: 50,
  maxSpreadTicks: 50,
  costs: { commissionPerUnitRoundTurn: 7, slippageAllowanceTicks: 10 },
  verification: unverified,
};

export const lookup = (s: string) => ({ NQ, XAUUSD: XAU })[s];

export const profile: PropFirmRuleProfile = PropFirmRuleProfileSchema.parse({
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
  objectives: { profitTarget: { kind: 'AMOUNT', value: 3_000 }, minTradingDays: null },
  payout: null,
});

export function makePolicy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return RiskPolicySchema.parse({
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
    ...overrides,
  });
}

export const strategy: StrategyDefinition = {
  id: 'test-strategy',
  name: 'Test',
  version: 1,
  ownership: 'TEMPLATE',
  status: 'ACTIVE',
  description: '',
  instruments: ['NQ', 'XAUUSD'],
  timeframes: [],
  direction: 'BOTH',
  minRewardToRisk: 2,
  signalTtlSeconds: 120,
  requiresAiAnalysis: false,
  rules: {},
};

export function makeSnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    accountId: 'acct-a',
    asOf: '2026-09-28T14:00:00.000Z',
    currency: 'USD',
    balance: 50_000,
    equity: 50_000,
    openPositions: [],
    pendingOrders: 0,
    ...overrides,
  };
}

export function makeTracking(overrides: Partial<AccountTracking> = {}): AccountTracking {
  return {
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
    updatedAt: '2026-09-28T13:00:00.000Z',
    ...overrides,
  };
}

export function stateFor(
  snapshot = makeSnapshot(),
  tracking = makeTracking(),
  p = profile,
): AccountState {
  return computeAccountState({ profile: p, snapshot, tracking, instruments: lookup });
}

export const noHeadroomLimit: QuantityHeadroom = {
  maxQuantity: null,
  bindingRule: null,
  complete: true,
};
