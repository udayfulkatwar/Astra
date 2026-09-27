import { dec } from '@astra/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeAccountState } from '../src/account-state';
import { evaluatePropFirmRules, type ProposedTrade } from '../src/rules';
import {
  maxQuantityWithinTrailingPath,
  trailingConsumption,
  trailingExposure,
} from '../src/trailing';
import {
  ACCOUNT,
  NOW,
  lookup,
  makePosition,
  makeProfile,
  makeSnapshot,
  makeTracking,
} from './fixtures';

const trailing = (trailingStopsAt: Record<string, unknown> = { kind: 'INITIAL_BALANCE' }) =>
  makeProfile({
    maxDrawdown: {
      type: 'TRAILING_INTRADAY_EQUITY',
      limit: { kind: 'AMOUNT', value: 2_500 },
      measure: 'EQUITY',
      trailingStopsAt: trailingStopsAt as never,
    },
  });

function setup(opts: {
  profile?: ReturnType<typeof makeProfile>;
  equity?: number;
  peak?: number;
  positions?: ReturnType<typeof makePosition>[];
}) {
  const profile = opts.profile ?? trailing();
  const snapshot = makeSnapshot({
    equity: opts.equity ?? 50_000,
    balance: opts.equity ?? 50_000,
    openPositions: opts.positions ?? [],
  });
  const tracking = makeTracking({ equityPeak: opts.peak ?? opts.equity ?? 50_000 });
  const state = computeAccountState({ profile, snapshot, tracking, instruments: lookup });
  return { profile, snapshot, state };
}

// 1 NQ: stop 10 pt → $209 incl. costs; target 30 pt → $600 run-up.
const trade = (quantity: number): ProposedTrade => ({
  symbol: 'NQ',
  direction: 'LONG',
  quantity,
  entry: 20_000,
  stop: 19_990,
  target: 20_030,
  worstCaseLoss: 209 * quantity,
});

function drawdownCheck(s: ReturnType<typeof setup>, quantity: number) {
  const v = evaluatePropFirmRules({
    profile: s.profile,
    account: ACCOUNT,
    state: s.state,
    snapshot: s.snapshot,
    proposal: trade(quantity),
    instruments: lookup,
    calendar: {
      status: 'OK',
      value: { from: '2026-09-28T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z', events: [] },
      source: 'test',
      sourceKind: 'SIMULATED',
      asOf: NOW,
    },
    now: new Date(NOW),
    flatBufferMinutes: 15,
  });
  return v.checks.find((c) => c.rule === 'drawdown-worst-case')!;
}

describe('trailingExposure', () => {
  it('is null for other drawdown types and plain once the threshold is locked', () => {
    const s = setup({ profile: makeProfile() });
    expect(trailingExposure(s.profile.maxDrawdown, s.state, [], lookup)).toBeNull();
    const locked = setup({ equity: 52_600 });
    expect(trailingExposure(locked.profile.maxDrawdown, locked.state, [], lookup)).toMatchObject({
      applies: false,
      locked: true,
      threshold: 50_000,
      riseCapRemaining: 0,
    });
  });

  it('adds the open positions’ run-up to their targets, capped at the lock level', () => {
    const s = setup({ positions: [makePosition({ quantity: 2, currentPrice: 20_010 })] });
    // Equity 50,000; run-up (20,030 − 20,010) × $20 × 2 = 800 → peak 50,800 → threshold 48,300.
    expect(
      trailingExposure(s.profile.maxDrawdown, s.state, s.snapshot.openPositions, lookup),
    ).toMatchObject({
      applies: true,
      runUp: 800,
      pathThreshold: 48_300,
      riseCapRemaining: 1_700, // to the 50,000 lock
    });
  });

  it('without a target: bounded by the lock level, or unknown when the threshold never locks', () => {
    const noTarget = [makePosition({ targetPrice: null })];
    const capped = setup({ positions: noTarget });
    expect(
      trailingExposure(capped.profile.maxDrawdown, capped.state, noTarget, lookup),
    ).toMatchObject({
      runUp: null,
      pathThreshold: 50_000,
      riseCapRemaining: 0,
    });
    const never = setup({ profile: trailing({ kind: 'NEVER' }), positions: noTarget });
    expect(
      trailingExposure(never.profile.maxDrawdown, never.state, noTarget, lookup),
    ).toMatchObject({
      runUp: null,
      pathThreshold: null,
      pathRemaining: null,
      riseCapRemaining: null,
    });
  });

  it('consumption adds the capped threshold rise to the stop loss', () => {
    const s = setup({ equity: 52_000, peak: 52_300 }); // threshold 49,800; 200 left to the lock
    const ex = trailingExposure(s.profile.maxDrawdown, s.state, [], lookup)!;
    expect(ex.riseCapRemaining).toBe(200);
    expect(trailingConsumption(ex, dec(836), dec(2_400)).toNumber()).toBe(1_036);
  });
});

describe('maxQuantityWithinTrailingPath', () => {
  it('solves q·risk + min(q·runUp, cap) ≤ budget', () => {
    expect(
      maxQuantityWithinTrailingPath(dec(1_000), dec(209), dec(600), null).toNumber(),
    ).toBeCloseTo(1000 / 809, 10);
    // With a 200 cap the run-up saturates at q = 1/3; beyond that only the stop loss grows.
    expect(
      maxQuantityWithinTrailingPath(dec(1_000), dec(209), dec(600), dec(200)).toNumber(),
    ).toBeCloseTo(800 / 209, 10);
    expect(maxQuantityWithinTrailingPath(dec(0), dec(209), dec(600), null).toNumber()).toBe(0);
  });

  it('is the largest feasible quantity (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: null }),
        (budget, risk, runUp, cap) => {
          const q = maxQuantityWithinTrailingPath(
            dec(budget),
            dec(risk),
            dec(runUp),
            cap === null ? null : dec(cap),
          );
          const cost = (x: ReturnType<typeof dec>) =>
            x
              .mul(risk)
              .plus(cap === null ? x.mul(runUp) : x.mul(runUp).lt(cap) ? x.mul(runUp) : dec(cap));
          expect(cost(q).lte(dec(budget).plus('1e-9'))).toBe(true);
          expect(cost(q.plus('1e-6')).gt(budget)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('evaluatePropFirmRules — trailing drawdown path', () => {
  it('passes 1 contract but rejects 4, which the plain worst case would have allowed', () => {
    const s = setup({}); // threshold 47,500; 2,500 left to the lock
    expect(drawdownCheck(s, 1)).toMatchObject({
      verdict: 'PASS',
      details: { mode: 'TRAILING_PATH', remainingAfterWorstPath: 1_691, tradeRunUp: 600 },
    });
    // 4 × 209 = 836 stop loss (2,500 − 836 > 0 in the plain view) + 2,400 threshold rise.
    expect(drawdownCheck(s, 4)).toMatchObject({
      verdict: 'FAIL',
      details: { mode: 'TRAILING_PATH', remainingAfterWorstPath: -736 },
    });
  });

  it('near the lock level only the remaining rise counts', () => {
    const s = setup({ equity: 52_000, peak: 52_300 });
    expect(drawdownCheck(s, 4)).toMatchObject({
      verdict: 'PASS',
      details: { remainingAfterWorstPath: 1_164 }, // 2,200 − (836 + 200)
    });
  });

  it('is UNKNOWN when an open position without a target makes the path unbounded', () => {
    const s = setup({
      profile: trailing({ kind: 'NEVER' }),
      positions: [makePosition({ targetPrice: null })],
    });
    expect(drawdownCheck(s, 1)).toMatchObject({
      verdict: 'UNKNOWN',
      message: expect.stringMatching(/unbounded/),
    });
  });

  it('a locked threshold falls back to the plain worst case', () => {
    const s = setup({ equity: 52_600 });
    expect(drawdownCheck(s, 1)).toMatchObject({
      verdict: 'PASS',
      message: 'drawdown threshold holds if all stops are hit',
    });
  });
});
