import { describe, expect, it } from 'vitest';
import { classifyAccountHealth } from '../src/health';
import { evaluateRiskPolicy, rewardToRisk } from '../src/policy-checks';
import { calculatePositionSize } from '../src/position-sizing';
import {
  NQ,
  makePolicy,
  makeSnapshot,
  makeTracking,
  noHeadroomLimit,
  stateFor,
  strategy,
} from './fixtures';

const activity = { tradingDayKey: '2026-09-28', tradesToday: 0, consecutiveLosses: 0 };
const classify = (state = stateFor(), a = activity, policy = makePolicy()) =>
  classifyAccountHealth({ state, policy, activity: a, accountStatus: 'ACTIVE' });

describe('classifyAccountHealth', () => {
  it('is SAFE with low usage', () => {
    expect(classify().health).toBe('SAFE');
  });

  it('is CAUTION above the caution threshold with a reduced size multiplier', () => {
    const h = classify(stateFor(makeSnapshot({ equity: 49_550, balance: 49_550 })));
    expect(h.health).toBe('CAUTION');
    expect(h.sizeMultiplier).toBe(0.5);
    expect(h.allowsNewTrades).toBe(true);
  });

  it('is RESTRICTED above the restricted threshold or when activity limits are hit', () => {
    expect(classify(stateFor(makeSnapshot({ equity: 49_250, balance: 49_250 }))).health).toBe(
      'RESTRICTED',
    );
    expect(classify(stateFor(), { ...activity, tradesToday: 4 }).health).toBe('RESTRICTED');
    expect(classify(stateFor(), { ...activity, consecutiveLosses: 3 }).health).toBe('RESTRICTED');
  });

  it('counts risk committed at open stops toward usage (RESTRICTED at 83.6% worst case)', () => {
    const pos = {
      positionId: 'p',
      symbol: 'NQ',
      direction: 'LONG' as const,
      quantity: 4,
      entryPrice: 20_000,
      currentPrice: 20_000,
      stopPrice: 19_990,
      targetPrice: null,
      unrealizedPnl: 0,
      openedAt: '2026-09-28T13:00:00.000Z',
    };
    const h = classify(stateFor(makeSnapshot({ openPositions: [pos] })));
    expect(h.usagePct).toBe(0);
    expect(h.worstCaseUsagePct).toBe(83.6);
    expect(h.health).toBe('RESTRICTED');
  });

  it('is BREACH_RISK when the worst case approaches a hard limit', () => {
    const pos = {
      positionId: 'p',
      symbol: 'NQ',
      direction: 'LONG' as const,
      quantity: 5,
      entryPrice: 20_000,
      currentPrice: 20_000,
      stopPrice: 19_990,
      targetPrice: null,
      unrealizedPnl: 0,
      openedAt: '2026-09-28T13:00:00.000Z',
    };
    const h = classify(stateFor(makeSnapshot({ openPositions: [pos] })));
    expect(h.health).toBe('BREACH_RISK');
    expect(h.allowsNewTrades).toBe(false);
  });

  it('is HALTED when breached or not active, UNKNOWN when open risk is unknown', () => {
    expect(
      classify(
        stateFor(
          makeSnapshot({ equity: 47_400, balance: 47_400 }),
          makeTracking({ dayStartBalance: 47_400 }),
        ),
      ).health,
    ).toBe('HALTED');
    expect(
      classifyAccountHealth({
        state: stateFor(),
        policy: makePolicy(),
        activity,
        accountStatus: 'DISABLED',
      }).health,
    ).toBe('HALTED');
    const pos = {
      positionId: 'p',
      symbol: 'NQ',
      direction: 'LONG' as const,
      quantity: 1,
      entryPrice: 20_000,
      currentPrice: 20_000,
      stopPrice: null,
      targetPrice: null,
      unrealizedPnl: 0,
      openedAt: '2026-09-28T13:00:00.000Z',
    };
    expect(classify(stateFor(makeSnapshot({ openPositions: [pos] }))).health).toBe('UNKNOWN');
  });
});

describe('rewardToRisk', () => {
  it('computes R:R and rejects inverted levels', () => {
    expect(rewardToRisk('LONG', 100, 95, 110)).toBe(2);
    expect(rewardToRisk('SHORT', 100, 105, 90)).toBe(2);
    expect(rewardToRisk('LONG', 100, 105, 110)).toBeNull();
    expect(rewardToRisk('LONG', 100, 95, 99)).toBeNull();
  });
});

describe('evaluateRiskPolicy', () => {
  const run = (
    overrides: {
      target?: number;
      tradesToday?: number;
      snapshot?: ReturnType<typeof makeSnapshot>;
    } = {},
  ) => {
    const snapshot = overrides.snapshot ?? makeSnapshot();
    const state = stateFor(snapshot);
    const policy = makePolicy();
    const act = { ...activity, tradesToday: overrides.tradesToday ?? 0 };
    const health = classifyAccountHealth({ state, policy, activity: act, accountStatus: 'ACTIVE' });
    const sizing = calculatePositionSize({
      instrument: NQ,
      accountCurrency: 'USD',
      direction: 'LONG',
      entry: 20_000,
      stop: 19_990,
      state,
      policy,
      strategyMaxRiskPercent: null,
      healthMultiplier: health.sizeMultiplier,
      firmMaxRiskPerTrade: null,
      firmHeadroom: noHeadroomLimit,
    });
    return evaluateRiskPolicy({
      policy,
      strategy,
      health,
      sizing,
      state,
      snapshot,
      activity: act,
      symbol: 'NQ',
      direction: 'LONG',
      entry: 20_000,
      stop: 19_990,
      target: overrides.target ?? 20_030,
    });
  };

  it('approves a clean trade', () => {
    const v = run();
    expect(v.reasons).toEqual([]);
    expect(v.approved).toBe(true);
  });

  it('rejects R:R below the stricter of policy and strategy minimum', () => {
    const v = run({ target: 20_015 }); // 1.5R < strategy 2R
    expect(v.approved).toBe(false);
    expect(v.reasons.join()).toMatch(/R:R 1.5 below configured minimum 2/);
  });

  it('rejects after max trades per day', () => {
    expect(run({ tradesToday: 4 }).approved).toBe(false);
  });

  it('rejects pyramiding and per-instrument limits', () => {
    const pos = {
      positionId: 'p',
      symbol: 'NQ',
      direction: 'LONG' as const,
      quantity: 1,
      entryPrice: 20_000,
      currentPrice: 20_000,
      stopPrice: 19_999,
      targetPrice: null,
      unrealizedPnl: 0,
      openedAt: '2026-09-28T13:00:00.000Z',
    };
    const v = run({ snapshot: makeSnapshot({ openPositions: [pos] }) });
    const failed = v.checks.filter((c) => c.verdict === 'FAIL').map((c) => c.check);
    expect(failed).toEqual(expect.arrayContaining(['pyramiding', 'positions-per-instrument']));
  });
});
