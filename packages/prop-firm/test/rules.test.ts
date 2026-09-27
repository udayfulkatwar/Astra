import { notObserved, observed, type CalendarWindow, type Observed } from '@astra/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeAccountState } from '../src/account-state';
import { evaluatePropFirmRules, firmQuantityHeadroom, type ProposedTrade } from '../src/rules';
import type { PropFirmRuleProfile } from '../src/profile';
import {
  ACCOUNT,
  NOW,
  NQ,
  lookup,
  makePosition,
  makeProfile,
  makeSnapshot,
  makeTracking,
} from './fixtures';

const calendarOk = (events: CalendarWindow['events'] = []): Observed<CalendarWindow> =>
  observed(
    { from: '2026-09-28T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z', events },
    { source: 'test-calendar', sourceKind: 'SIMULATED', asOf: NOW },
  );

const proposal = (overrides: Partial<ProposedTrade> = {}): ProposedTrade => ({
  symbol: 'NQ',
  direction: 'LONG',
  quantity: 1,
  entry: 20_000,
  stop: 19_990,
  target: 20_030,
  worstCaseLoss: 209,
  ...overrides,
});

function evaluate(opts: {
  profile?: PropFirmRuleProfile;
  snapshot?: ReturnType<typeof makeSnapshot>;
  tracking?: ReturnType<typeof makeTracking>;
  trade?: ProposedTrade;
  calendar?: Observed<CalendarWindow>;
  now?: string;
  account?: typeof ACCOUNT;
}) {
  const profile = opts.profile ?? makeProfile();
  const snapshot = opts.snapshot ?? makeSnapshot();
  const tracking = opts.tracking ?? makeTracking();
  const state = computeAccountState({ profile, snapshot, tracking, instruments: lookup });
  return evaluatePropFirmRules({
    profile,
    account: opts.account ?? ACCOUNT,
    state,
    snapshot,
    proposal: opts.trade ?? proposal(),
    instruments: lookup,
    calendar: opts.calendar ?? calendarOk(),
    now: new Date(opts.now ?? NOW),
    flatBufferMinutes: 15,
  });
}

const check = (v: ReturnType<typeof evaluate>, rule: string) =>
  v.checks.find((c) => c.rule === rule);

describe('evaluatePropFirmRules', () => {
  it('approves a trade within all limits', () => {
    const v = evaluate({});
    expect(v.status).toBe('APPROVED');
    expect(v.approved).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('rejects when the worst case would breach the daily loss floor', () => {
    const v = evaluate({
      snapshot: makeSnapshot({ equity: 49_300, balance: 49_300 }),
      tracking: makeTracking({ dayStartBalance: 50_000 }),
      trade: proposal({ worstCaseLoss: 300 }),
    });
    expect(v.status).toBe('REJECTED');
    expect(check(v, 'daily-loss-worst-case')!.verdict).toBe('FAIL');
    expect(v.reasons.join(' ')).toMatch(/daily loss/);
  });

  it('treats landing exactly on the floor as a breach', () => {
    const v = evaluate({ trade: proposal({ worstCaseLoss: 1_000 }) });
    expect(check(v, 'daily-loss-worst-case')!.verdict).toBe('FAIL');
  });

  it('rejects when the worst case would breach the drawdown threshold', () => {
    const v = evaluate({
      profile: makeProfile({ dailyLoss: null }),
      snapshot: makeSnapshot({ equity: 47_700, balance: 47_700 }),
      trade: proposal({ worstCaseLoss: 250 }),
    });
    expect(check(v, 'drawdown-worst-case')!.verdict).toBe('FAIL');
  });

  it('includes existing open risk in the worst case', () => {
    const snapshot = makeSnapshot({
      openPositions: [makePosition({ quantity: 4, stopPrice: 19_990 })],
    });
    // open risk = 4 × (200 + 5 + 4) = 836 → daily remaining worst case 164
    const v = evaluate({ snapshot, trade: proposal({ worstCaseLoss: 200 }) });
    expect(check(v, 'daily-loss-worst-case')!.verdict).toBe('FAIL');
  });

  it('is UNKNOWN (not approved) when open risk cannot be computed', () => {
    const v = evaluate({
      snapshot: makeSnapshot({ openPositions: [makePosition({ stopPrice: null })] }),
    });
    expect(v.status).toBe('UNKNOWN');
    expect(v.approved).toBe(false);
  });

  it('rejects an inactive account and a locked day', () => {
    expect(evaluate({ account: { ...ACCOUNT, status: 'DISABLED' } }).status).toBe('REJECTED');
    const locked = evaluate({
      profile: makeProfile({
        dailyLoss: {
          limit: { kind: 'AMOUNT', value: 1_000 },
          reference: 'DAY_START_BALANCE',
          measure: 'EQUITY',
          breachConsequence: 'DAY_LOCKED',
        },
      }),
      snapshot: makeSnapshot({ equity: 49_000, balance: 49_000 }),
    });
    expect(check(locked, 'breach-state')!.verdict).toBe('FAIL');
  });

  it('rejects a stop on the wrong side of entry', () => {
    const v = evaluate({ trade: proposal({ stop: 20_010 }) });
    expect(check(v, 'stop-loss')!.verdict).toBe('FAIL');
  });

  describe('position limits', () => {
    it('counts weighted contracts (micros count 0.1)', () => {
      const snapshot = makeSnapshot({
        openPositions: [
          makePosition({ quantity: 4, stopPrice: 19_999 }),
          makePosition({ positionId: 'p2', symbol: 'MNQ', quantity: 5, stopPrice: 19_999 }),
        ],
      });
      // 4 + 0.5 = 4.5 of 5 → 0.5 NQ headroom → 1 NQ exceeds
      const v = evaluate({ snapshot, trade: proposal({ worstCaseLoss: 10 }) });
      expect(check(v, 'position-limits')!.verdict).toBe('FAIL');
      const micro = evaluate({
        snapshot,
        trade: proposal({ symbol: 'MNQ', quantity: 5, worstCaseLoss: 10 }),
      });
      expect(check(micro, 'position-limits')!.verdict).toBe('PASS');
    });

    it('applies the scaling plan tier for current profit', () => {
      const profile = makeProfile({
        scaling: {
          tiers: [
            { minProfit: 0, maxWeightedQuantity: 2 },
            { minProfit: 1_500, maxWeightedQuantity: 4 },
          ],
        },
      });
      const state = computeAccountState({
        profile,
        snapshot: makeSnapshot(),
        tracking: makeTracking(),
        instruments: lookup,
      });
      expect(
        firmQuantityHeadroom({
          profile,
          state,
          snapshot: makeSnapshot(),
          spec: NQ,
          instruments: lookup,
        }).maxQuantity,
      ).toBe(2);
      const richer = makeSnapshot({ balance: 51_600, equity: 51_600 });
      const state2 = computeAccountState({
        profile,
        snapshot: richer,
        tracking: makeTracking(),
        instruments: lookup,
      });
      const h = firmQuantityHeadroom({
        profile,
        state: state2,
        snapshot: richer,
        spec: NQ,
        instruments: lookup,
      });
      expect(h.maxQuantity).toBe(4);
      expect(h.bindingRule).toBe('scaling-plan');
    });

    it('allows nothing below the lowest scaling tier', () => {
      const profile = makeProfile({
        scaling: { tiers: [{ minProfit: 500, maxWeightedQuantity: 2 }] },
      });
      const v = evaluate({ profile });
      expect(check(v, 'position-limits')!.verdict).toBe('FAIL');
    });

    it('enforces max open positions and hedging', () => {
      const profile = makeProfile({
        positionLimits: {
          maxContracts: 10,
          maxLots: null,
          quantityWeights: {},
          maxOpenPositions: 1,
          perInstrumentMaxQuantity: {},
          maxLeverage: null,
        },
      });
      const snapshot = makeSnapshot({
        openPositions: [makePosition({ direction: 'SHORT', stopPrice: 20_001 })],
      });
      const v = evaluate({ profile, snapshot, trade: proposal({ worstCaseLoss: 10 }) });
      expect(check(v, 'max-open-positions')!.verdict).toBe('FAIL');
      expect(check(v, 'hedging')!.verdict).toBe('FAIL');
    });

    it('enforces max leverage', () => {
      const profile = makeProfile({
        positionLimits: {
          maxContracts: null,
          maxLots: null,
          quantityWeights: {},
          maxOpenPositions: null,
          perInstrumentMaxQuantity: {},
          maxLeverage: 5,
        },
      });
      // 1 NQ @ 20000 × $20 = $400k notional / 50k = 8x
      expect(check(evaluate({ profile }), 'leverage')!.verdict).toBe('FAIL');
    });

    it('enforces firm max risk per trade', () => {
      const profile = makeProfile({
        trading: {
          stopLossRequired: true,
          maxRiskPerTrade: { kind: 'PERCENT_OF_INITIAL', value: 0.3 },
          hedgingAllowed: false,
        },
      });
      expect(
        check(evaluate({ profile, trade: proposal({ worstCaseLoss: 151 }) }), 'max-risk-per-trade')!
          .verdict,
      ).toBe('FAIL');
      expect(
        check(evaluate({ profile, trade: proposal({ worstCaseLoss: 150 }) }), 'max-risk-per-trade')!
          .verdict,
      ).toBe('PASS');
    });
  });

  describe('news restriction', () => {
    const profile = makeProfile({
      news: { impactLevels: ['HIGH'], minutesBefore: 5, minutesAfter: 5 },
    });
    const event = (
      at: string,
      impact: 'HIGH' | 'LOW' | 'UNKNOWN' = 'HIGH',
      affected: string[] = [],
    ) => ({
      id: 'e1',
      title: 'Test CPI',
      impact,
      scheduledAt: at,
      affectedInstruments: affected,
    });

    it('rejects inside the window around a high-impact event', () => {
      const v = evaluate({ profile, calendar: calendarOk([event('2026-09-28T14:03:00.000Z')]) });
      expect(check(v, 'news-restriction')!.verdict).toBe('FAIL');
    });

    it('passes outside the window, for low impact, and for unaffected instruments', () => {
      expect(
        check(
          evaluate({ profile, calendar: calendarOk([event('2026-09-28T14:10:00.000Z')]) }),
          'news-restriction',
        )!.verdict,
      ).toBe('PASS');
      expect(
        check(
          evaluate({ profile, calendar: calendarOk([event('2026-09-28T14:02:00.000Z', 'LOW')]) }),
          'news-restriction',
        )!.verdict,
      ).toBe('PASS');
      expect(
        check(
          evaluate({
            profile,
            calendar: calendarOk([event('2026-09-28T14:02:00.000Z', 'HIGH', ['XAUUSD'])]),
          }),
          'news-restriction',
        )!.verdict,
      ).toBe('PASS');
    });

    it('treats UNKNOWN impact as HIGH', () => {
      const v = evaluate({
        profile,
        calendar: calendarOk([event('2026-09-28T14:02:00.000Z', 'UNKNOWN')]),
      });
      expect(check(v, 'news-restriction')!.verdict).toBe('FAIL');
    });

    it('is UNKNOWN when the calendar is unavailable or does not cover the window', () => {
      const down = evaluate({
        profile,
        calendar: notObserved('UNAVAILABLE', 'provider down', 'cal'),
      });
      expect(down.status).toBe('UNKNOWN');
      const partial = observed(
        { from: '2026-09-28T14:00:00.000Z', to: '2026-09-28T15:00:00.000Z', events: [] },
        { source: 'cal', sourceKind: 'SIMULATED', asOf: NOW },
      );
      expect(check(evaluate({ profile, calendar: partial }), 'news-restriction')!.verdict).toBe(
        'UNKNOWN',
      );
    });
  });

  describe('holding rules', () => {
    it('refuses new trades within the buffer before the mandatory flat time', () => {
      const profile = makeProfile({
        holding: {
          overnight: 'PROHIBITED',
          weekend: 'PROHIBITED',
          flatBy: { timeZone: 'America/New_York', time: '16:10' },
          weeklyClose: null,
        },
      });
      expect(
        check(evaluate({ profile, now: '2026-09-28T20:00:00.000Z' }), 'flat-by')!.verdict,
      ).toBe('FAIL');
      expect(
        check(evaluate({ profile, now: '2026-09-28T19:30:00.000Z' }), 'flat-by')!.verdict,
      ).toBe('PASS');
    });

    it('refuses new trades just before the weekly close when weekend holding is prohibited', () => {
      const profile = makeProfile({
        holding: {
          overnight: 'ALLOWED',
          weekend: 'PROHIBITED',
          flatBy: null,
          weeklyClose: { timeZone: 'America/New_York', time: '16:00', day: 'FRI' },
        },
      });
      expect(
        check(evaluate({ profile, now: '2026-10-02T19:50:00.000Z' }), 'weekend-holding')!.verdict,
      ).toBe('FAIL');
      expect(
        check(evaluate({ profile, now: '2026-10-01T19:50:00.000Z' }), 'weekend-holding')!.verdict,
      ).toBe('PASS');
    });
  });

  it('blocks new trades once today dominates total profit (consistency BLOCK)', () => {
    const profile = makeProfile({
      consistency: { maxDayProfitSharePct: 40, enforcement: 'BLOCK_NEW_TRADES' },
    });
    const v = evaluate({
      profile,
      snapshot: makeSnapshot({ balance: 51_000, equity: 51_000 }),
      tracking: makeTracking({ dayStartBalance: 50_000 }),
    });
    expect(check(v, 'consistency')!.verdict).toBe('FAIL');
  });

  it('property: approval implies the worst case stays strictly above every hard limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 47_000, max: 53_000 }),
        fc.integer({ min: 48_000, max: 52_000 }),
        fc.integer({ min: 1, max: 3_000 }),
        (equity, dayStart, loss) => {
          const profile = makeProfile();
          const snapshot = makeSnapshot({ equity, balance: equity });
          const tracking = makeTracking({ dayStartBalance: dayStart });
          const state = computeAccountState({ profile, snapshot, tracking, instruments: lookup });
          const v = evaluatePropFirmRules({
            profile,
            account: ACCOUNT,
            state,
            snapshot,
            proposal: proposal({ worstCaseLoss: loss }),
            instruments: lookup,
            calendar: calendarOk(),
            now: new Date(NOW),
            flatBufferMinutes: 15,
          });
          if (v.approved) {
            const after = equity - loss;
            expect(after).toBeGreaterThan(state.dailyLoss!.floor);
            expect(after).toBeGreaterThan(state.drawdown.threshold);
          }
        },
      ),
    );
  });

  it('property: a larger worst-case loss never turns a rejection into an approval', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 47_000, max: 53_000 }),
        fc.integer({ min: 1, max: 3_000 }),
        fc.integer({ min: 0, max: 3_000 }),
        (equity, l1, extra) => {
          const run = (loss: number) =>
            evaluate({
              snapshot: makeSnapshot({ equity, balance: equity }),
              trade: proposal({ worstCaseLoss: loss }),
            }).approved;
          if (!run(l1)) expect(run(l1 + extra)).toBe(false);
        },
      ),
    );
  });
});
