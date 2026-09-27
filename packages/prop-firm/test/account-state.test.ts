import { describe, expect, it } from 'vitest';
import { computeAccountState, positionRiskToStop } from '../src/account-state';
import { NQ, lookup, makePosition, makeProfile, makeSnapshot, makeTracking } from './fixtures';

const compute = (profile = makeProfile(), snapshot = makeSnapshot(), tracking = makeTracking()) =>
  computeAccountState({ profile, snapshot, tracking, instruments: lookup });

describe('drawdown', () => {
  it('STATIC: threshold is initial minus limit', () => {
    const s = compute(makeProfile(), makeSnapshot({ balance: 49_000, equity: 49_000 }));
    expect(s.drawdown.threshold).toBe(47_500);
    expect(s.drawdown.remaining).toBe(1_500);
    expect(s.drawdown.usedPct).toBe(40);
    expect(s.drawdown.breached).toBe(false);
  });

  it('TRAILING_INTRADAY_EQUITY trails the equity peak until the lock level', () => {
    const profile = makeProfile({
      maxDrawdown: {
        type: 'TRAILING_INTRADAY_EQUITY',
        limit: { kind: 'AMOUNT', value: 2_000 },
        measure: 'EQUITY',
        trailingStopsAt: { kind: 'INITIAL_BALANCE' },
      },
    });
    const trailing = compute(
      profile,
      makeSnapshot({ equity: 50_800, balance: 50_000 }),
      makeTracking({ equityPeak: 51_000 }),
    );
    expect(trailing.drawdown.peak).toBe(51_000);
    expect(trailing.drawdown.threshold).toBe(49_000);
    expect(trailing.drawdown.thresholdLocked).toBe(false);

    const locked = compute(
      profile,
      makeSnapshot({ equity: 52_000, balance: 52_000 }),
      makeTracking({ equityPeak: 52_500 }),
    );
    expect(locked.drawdown.threshold).toBe(50_000);
    expect(locked.drawdown.thresholdLocked).toBe(true);
  });

  it('TRAILING_INTRADAY_EQUITY includes the current equity in the peak', () => {
    const profile = makeProfile({
      maxDrawdown: {
        type: 'TRAILING_INTRADAY_EQUITY',
        limit: { kind: 'AMOUNT', value: 2_000 },
        measure: 'EQUITY',
        trailingStopsAt: { kind: 'NEVER' },
      },
    });
    const s = compute(
      profile,
      makeSnapshot({ equity: 51_500 }),
      makeTracking({ equityPeak: 51_000 }),
    );
    expect(s.drawdown.threshold).toBe(49_500);
  });

  it('TRAILING_END_OF_DAY ignores intraday peaks', () => {
    const profile = makeProfile({
      maxDrawdown: {
        type: 'TRAILING_END_OF_DAY',
        limit: { kind: 'AMOUNT', value: 2_000 },
        measure: 'EQUITY',
        trailingStopsAt: { kind: 'NEVER' },
      },
    });
    const s = compute(
      profile,
      makeSnapshot({ equity: 52_000, balance: 51_000 }),
      makeTracking({ equityPeak: 53_000, endOfDayBalancePeak: 50_600 }),
    );
    expect(s.drawdown.threshold).toBe(48_600);
  });

  it('INITIAL_BALANCE_PLUS locks the threshold above the initial balance', () => {
    const profile = makeProfile({
      maxDrawdown: {
        type: 'TRAILING_BALANCE',
        limit: { kind: 'AMOUNT', value: 2_500 },
        measure: 'EQUITY',
        trailingStopsAt: { kind: 'INITIAL_BALANCE_PLUS', amount: 100 },
      },
    });
    const s = compute(
      profile,
      makeSnapshot({ equity: 53_000, balance: 53_000 }),
      makeTracking({ balancePeak: 53_000 }),
    );
    expect(s.drawdown.threshold).toBe(50_100);
  });

  it('PERCENT_OF_INITIAL limits scale with the initial balance', () => {
    const profile = makeProfile({
      maxDrawdown: {
        type: 'STATIC',
        limit: { kind: 'PERCENT_OF_INITIAL', value: 10 },
        measure: 'EQUITY',
        trailingStopsAt: { kind: 'NEVER' },
      },
    });
    expect(compute(profile).drawdown.threshold).toBe(45_000);
  });

  it('uses the firm-reported threshold when it is more conservative', () => {
    const s = compute(makeProfile(), makeSnapshot({ reported: { drawdownThreshold: 48_000 } }));
    expect(s.drawdown.threshold).toBe(48_000);
    expect(s.drawdown.thresholdSource).toBe('REPORTED');
    const s2 = compute(makeProfile(), makeSnapshot({ reported: { drawdownThreshold: 40_000 } }));
    expect(s2.drawdown.threshold).toBe(47_500);
    expect(s2.drawdown.thresholdSource).toBe('COMPUTED');
  });

  it('flags a breach when equity reaches the threshold', () => {
    const s = compute(
      makeProfile(),
      makeSnapshot({ equity: 47_500, balance: 47_500 }),
      makeTracking({ dayStartBalance: 47_600 }),
    );
    expect(s.drawdown.breached).toBe(true);
    expect(s.breached).toBe(true);
  });
});

describe('daily loss', () => {
  it('computes floor, remaining and usage from day-start balance', () => {
    const s = compute(
      makeProfile(),
      makeSnapshot({ balance: 50_500, equity: 49_800 }),
      makeTracking({ dayStartBalance: 50_500 }),
    );
    expect(s.dailyLoss!.floor).toBe(49_500);
    expect(s.dailyLoss!.remaining).toBe(300);
    expect(s.dailyLoss!.used).toBe(700);
    expect(s.dailyLoss!.usedPct).toBe(70);
  });

  it('supports PERCENT_OF_DAY_START with the higher of balance and equity', () => {
    const profile = makeProfile({
      dailyLoss: {
        limit: { kind: 'PERCENT_OF_DAY_START', value: 5 },
        reference: 'DAY_START_HIGHER_OF_BALANCE_EQUITY',
        measure: 'EQUITY',
        breachConsequence: 'ACCOUNT_FAILED',
      },
    });
    const s = compute(
      profile,
      makeSnapshot(),
      makeTracking({ dayStartBalance: 50_000, dayStartEquity: 52_000 }),
    );
    expect(s.dailyLoss!.reference).toBe(52_000);
    expect(s.dailyLoss!.limit).toBe(2_600);
    expect(s.dailyLoss!.floor).toBe(49_400);
  });

  it('BALANCE measure ignores floating losses at the current mark', () => {
    const profile = makeProfile({
      dailyLoss: {
        limit: { kind: 'AMOUNT', value: 1_000 },
        reference: 'DAY_START_BALANCE',
        measure: 'BALANCE',
        breachConsequence: 'ACCOUNT_FAILED',
      },
    });
    const s = compute(profile, makeSnapshot({ balance: 50_000, equity: 49_200 }));
    expect(s.dailyLoss!.remaining).toBe(1_000);
  });

  it('DAY_LOCKED consequence locks the day without failing the account', () => {
    const profile = makeProfile({
      dailyLoss: {
        limit: { kind: 'AMOUNT', value: 1_000 },
        reference: 'DAY_START_BALANCE',
        measure: 'EQUITY',
        breachConsequence: 'DAY_LOCKED',
      },
    });
    const s = compute(profile, makeSnapshot({ balance: 49_000, equity: 49_000 }));
    expect(s.dayLocked).toBe(true);
    expect(s.breached).toBe(false);
  });

  it('profile without daily loss reports null and drawdown binds', () => {
    const s = compute(makeProfile({ dailyLoss: null }));
    expect(s.dailyLoss).toBeNull();
    expect(s.bindingLimit).toBe('MAX_DRAWDOWN');
  });
});

describe('open risk and worst case', () => {
  it('computes risk to stop from the current price with cost allowances', () => {
    const r = positionRiskToStop(
      makePosition({ quantity: 2, currentPrice: 20_000, stopPrice: 19_990 }),
      NQ,
    );
    // 10 pts × $20/pt × 2 = 400; slippage 1 tick × $5 × 2 = 10; commission 4 × 2 = 8
    expect(r.riskToStop).toBe(418);
  });

  it('counts a short position symmetrically', () => {
    const r = positionRiskToStop(
      makePosition({ direction: 'SHORT', currentPrice: 20_000, stopPrice: 20_005 }),
      NQ,
    );
    expect(r.riskToStop).toBe(100 + 5 + 4);
  });

  it('never counts a profit-locking stop as negative risk', () => {
    const r = positionRiskToStop(makePosition({ currentPrice: 20_000, stopPrice: 20_010 }), NQ);
    expect(r.riskToStop).toBe(9);
  });

  it('marks open risk incomplete for a position without a stop', () => {
    const s = compute(
      makeProfile(),
      makeSnapshot({ openPositions: [makePosition({ stopPrice: null })] }),
    );
    expect(s.openRisk.complete).toBe(false);
    expect(s.worstCaseEquity).toBeNull();
    expect(s.worstCaseDistanceToBreach).toBeNull();
  });

  it('computes worst-case equity and distance to breach', () => {
    const s = compute(makeProfile(), makeSnapshot({ openPositions: [makePosition()] }));
    expect(s.openRisk.amount).toBe(209);
    expect(s.worstCaseEquity).toBe(49_791);
    expect(s.dailyLoss!.worstCaseRemaining).toBe(791);
    expect(s.worstCaseDistanceToBreach).toBe(791);
    expect(s.bindingLimit).toBe('DAILY_LOSS');
  });
});

describe('objectives and consistency', () => {
  it('tracks profit target progress', () => {
    const s = compute(makeProfile(), makeSnapshot({ balance: 51_500, equity: 51_500 }));
    expect(s.profitTarget).toMatchObject({
      target: 3_000,
      progress: 1_500,
      remaining: 1_500,
      progressPct: 50,
      reached: false,
    });
  });

  it('computes consistency shares from completed days and today', () => {
    const profile = makeProfile({
      consistency: { maxDayProfitSharePct: 40, enforcement: 'BLOCK_NEW_TRADES' },
    });
    const s = compute(
      profile,
      makeSnapshot({ balance: 52_000, equity: 52_000 }),
      makeTracking({
        dayStartBalance: 51_000,
        completedDays: [
          { day: 'd1', pnl: 600 },
          { day: 'd2', pnl: 400 },
        ],
      }),
    );
    expect(s.consistency!.totalProfit).toBe(2_000);
    expect(s.consistency!.todaySharePct).toBe(50);
    expect(s.consistency!.todayAtOrAboveLimit).toBe(true);
  });

  it('rejects mismatched currency', () => {
    expect(() => compute(makeProfile(), makeSnapshot({ currency: 'EUR' }))).toThrow(/currency/);
  });
});
