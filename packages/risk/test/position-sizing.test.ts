import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calculatePositionSize,
  riskPerUnit,
  type PositionSizingInput,
} from '../src/position-sizing';
import {
  NQ,
  XAU,
  makePolicy,
  makeSnapshot,
  makeTracking,
  noHeadroomLimit,
  stateFor,
} from './fixtures';

const base = (overrides: Partial<PositionSizingInput> = {}): PositionSizingInput => ({
  instrument: NQ,
  accountCurrency: 'USD',
  direction: 'LONG',
  entry: 20_000,
  stop: 19_990,
  state: stateFor(),
  policy: makePolicy(),
  strategyMaxRiskPercent: null,
  healthMultiplier: 1,
  firmMaxRiskPerTrade: null,
  firmHeadroom: noHeadroomLimit,
  ...overrides,
});

describe('riskPerUnit', () => {
  it('rounds partial ticks up and adds cost allowances', () => {
    // 10.1 pts → 40.4 ticks → 41 ticks; +1 slippage tick = 42 × $5 = 210; + $4 commission
    expect(riskPerUnit(NQ, 20_000, 19_989.9).perUnit.toNumber()).toBe(214);
  });
});

describe('calculatePositionSize', () => {
  it('sizes by risk % of equity when that is the smallest limit', () => {
    // allowed: 0.5% × 50k = 250; per unit = 40 ticks + 1 = 41 × 5 + 4 = 209 → 1 contract
    const r = calculatePositionSize(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quantity).toBe(1);
    expect(r.dollarRisk).toBe(209);
    expect(r.bindingConstraint).toBe('risk-percent-of-equity');
    expect(r.allowedRisk).toBe(250);
  });

  it('uses the daily-loss buffer when it is tighter', () => {
    const state = stateFor(makeSnapshot({ equity: 49_300, balance: 49_300 }));
    // daily remaining 300 − survival 100 = 200 × 50% = 100 < 209 → size 0 → rejected
    const r = calculatePositionSize(base({ state }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/below minimum tradable quantity.*daily-loss-buffer/);
  });

  it('applies the strategy cap when smaller than policy', () => {
    const r = calculatePositionSize(
      base({ strategyMaxRiskPercent: 0.1, instrument: XAU, entry: 2_650, stop: 2_645 }),
    );
    expect(r.ok && r.bindingConstraint).toBe('risk-percent-of-equity');
    // 0.1% × 50k = 50; per lot = (500 + 10) × 1 + 7 = 517 → 0.09 lots
    expect(r.ok && r.quantity).toBe(0.09);
  });

  it('clamps to firm quantity headroom and reports it as binding', () => {
    const r = calculatePositionSize(
      base({
        instrument: XAU,
        entry: 2_650,
        stop: 2_649,
        firmHeadroom: { maxQuantity: 0.2, bindingRule: 'max-lots', complete: true },
      }),
    );
    expect(r.ok && r.quantity).toBe(0.2);
    expect(r.ok && r.bindingConstraint).toBe('firm-max-lots');
  });

  it('halves size in CAUTION via the health multiplier', () => {
    const full = calculatePositionSize(base({ instrument: XAU, entry: 2_650, stop: 2_645 }));
    const half = calculatePositionSize(
      base({ instrument: XAU, entry: 2_650, stop: 2_645, healthMultiplier: 0.5 }),
    );
    expect(full.ok && half.ok).toBe(true);
    if (full.ok && half.ok) expect(half.allowedRisk).toBe(full.allowedRisk / 2);
  });

  it('rejects when health forbids risk, open risk is unknown, or the stop is wrong', () => {
    expect(calculatePositionSize(base({ healthMultiplier: 0 })).ok).toBe(false);
    expect(calculatePositionSize(base({ stop: 20_010 })).ok).toBe(false);
    const unknownRisk = stateFor(
      makeSnapshot({
        openPositions: [
          {
            positionId: 'p',
            symbol: 'NQ',
            direction: 'LONG',
            quantity: 1,
            entryPrice: 20_000,
            currentPrice: 20_000,
            stopPrice: null,
            targetPrice: null,
            unrealizedPnl: 0,
            openedAt: '2026-09-28T13:00:00.000Z',
          },
        ],
      }),
    );
    expect(calculatePositionSize(base({ state: unknownRisk })).ok).toBe(false);
  });

  it('rejects cross-currency instruments instead of guessing a conversion rate', () => {
    const r = calculatePositionSize(base({ instrument: { ...XAU, quoteCurrency: 'JPY' } }));
    expect(r.ok).toBe(false);
  });

  it('property: never exceeds any risk budget or quantity cap, and never rounds up', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 48_500, max: 53_000 }), // equity
        fc.integer({ min: 49_000, max: 51_000 }), // day start
        fc.double({ min: 0.5, max: 60, noNaN: true }), // stop distance (points)
        fc.double({ min: 0.05, max: 2, noNaN: true }), // risk %
        fc.option(fc.integer({ min: 0, max: 8 }), { nil: null }), // firm headroom
        fc.constantFrom('LONG' as const, 'SHORT' as const),
        (equity, dayStart, dist, riskPct, headroom, direction) => {
          const policy = makePolicy({
            perTrade: { riskPercentOfEquity: riskPct, maxRiskAmount: null, minRewardToRisk: 1 },
          });
          const state = stateFor(
            makeSnapshot({ equity, balance: equity }),
            makeTracking({ dayStartBalance: dayStart }),
          );
          const entry = 20_000;
          const stop = direction === 'LONG' ? entry - dist : entry + dist;
          const r = calculatePositionSize(
            base({
              policy,
              state,
              direction,
              entry,
              stop,
              firmHeadroom:
                headroom === null
                  ? noHeadroomLimit
                  : { maxQuantity: headroom, bindingRule: 'max-contracts', complete: true },
            }),
          );
          if (!r.ok) return;
          expect(r.dollarRisk).toBeLessThanOrEqual(r.allowedRisk + 1e-9);
          expect(r.quantity).toBeGreaterThanOrEqual(NQ.minQuantity);
          expect(Number.isInteger(r.quantity)).toBe(true);
          if (headroom !== null) expect(r.quantity).toBeLessThanOrEqual(headroom);
          for (const c of r.constraints)
            if (c.kind === 'RISK_AMOUNT') expect(r.dollarRisk).toBeLessThanOrEqual(c.value + 0.01);
          // Worst case after the trade stays above both hard limits by the survival buffer.
          expect(state.dailyLoss!.worstCaseRemaining! - r.dollarRisk).toBeGreaterThanOrEqual(
            policy.buffers.survivalBufferAmount - 1e-6,
          );
          expect(state.drawdown.worstCaseRemaining! - r.dollarRisk).toBeGreaterThanOrEqual(
            policy.buffers.survivalBufferAmount - 1e-6,
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});
