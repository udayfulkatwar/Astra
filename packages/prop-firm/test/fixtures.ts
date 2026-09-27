/**
 * Test fixtures. The profile below is a synthetic TEST profile — not any real firm's rules.
 */
import type { AccountDefinition, AccountSnapshot, InstrumentSpec, OpenPosition } from '@astra/core';
import { PropFirmRuleProfileSchema, type PropFirmRuleProfile } from '../src/profile';
import type { AccountTracking } from '../src/tracking';

const unverified = { status: 'UNVERIFIED' as const, note: 'test fixture' };

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

export const MNQ: InstrumentSpec = {
  ...NQ,
  symbol: 'MNQ',
  displayName: 'Test MNQ',
  tickValue: 0.5,
  costs: { commissionPerUnitRoundTurn: 1, slippageAllowanceTicks: 1 },
};

export const XAU: InstrumentSpec = {
  symbol: 'XAUUSD',
  displayName: 'Test Gold CFD',
  assetClass: 'CFD_METAL',
  quantityUnit: 'LOTS',
  quoteCurrency: 'USD',
  tickSize: 0.01,
  tickValue: 1,
  quantityStep: 0.01,
  minQuantity: 0.01,
  maxSpreadTicks: 50,
  costs: { commissionPerUnitRoundTurn: 7, slippageAllowanceTicks: 10 },
  verification: unverified,
};

const INSTRUMENTS: Record<string, InstrumentSpec> = { NQ, MNQ, XAUUSD: XAU };
export const lookup = (s: string): InstrumentSpec | undefined => INSTRUMENTS[s];

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> | T[K] : T[K] };

export function makeProfile(overrides: DeepPartial<PropFirmRuleProfile> = {}): PropFirmRuleProfile {
  const base = {
    id: 'test-50k',
    name: 'Test 50K',
    firm: 'TEST FIRM',
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
      quantityWeights: { MNQ: 0.1 },
      maxOpenPositions: null,
      perInstrumentMaxQuantity: {},
      maxLeverage: null,
    },
    scaling: null,
    consistency: null,
    news: null,
    holding: { overnight: 'ALLOWED', weekend: 'ALLOWED', flatBy: null, weeklyClose: null },
    trading: { stopLossRequired: true, maxRiskPerTrade: null, hedgingAllowed: false },
    objectives: { profitTarget: { kind: 'AMOUNT', value: 3_000 }, minTradingDays: 5 },
    payout: null,
  };
  return PropFirmRuleProfileSchema.parse({ ...base, ...overrides });
}

export const ACCOUNT: AccountDefinition = {
  id: 'acct-a',
  name: 'Account A',
  firm: 'TEST FIRM',
  propFirmProfileId: 'test-50k',
  riskPolicyId: 'test-policy',
  currency: 'USD',
  status: 'ACTIVE',
  broker: { adapterId: 'paper', accountRef: 'PAPER-A' },
  strategies: ['test-strategy'],
  instruments: ['NQ', 'MNQ', 'XAUUSD'],
  liveTradingAuthorized: false,
};

export const NOW = '2026-09-28T14:00:00.000Z'; // Monday 10:00 New York

export function makeSnapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    accountId: 'acct-a',
    asOf: NOW,
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

export function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    positionId: 'pos-1',
    symbol: 'NQ',
    direction: 'LONG',
    quantity: 1,
    entryPrice: 20_000,
    currentPrice: 20_000,
    stopPrice: 19_990,
    targetPrice: 20_030,
    unrealizedPnl: 0,
    openedAt: '2026-09-28T13:30:00.000Z',
    ...overrides,
  };
}
