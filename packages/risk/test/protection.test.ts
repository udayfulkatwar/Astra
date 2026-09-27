import { describe, expect, it } from 'vitest';
import type { HoldingRules } from '@astra/prop-firm';
import type { AccountMonitorView, PositionView } from '../src/monitor';
import { ProtectionEvaluator, ProtectionPolicySchema } from '../src/protection';

const pos = (o: Partial<PositionView> = {}): PositionView => ({
  positionId: 'p1',
  symbol: 'NQ',
  direction: 'LONG',
  quantity: 1,
  entryPrice: 20_000,
  stopPrice: 19_990,
  targetPrice: 20_030,
  openedAt: '2026-09-28T13:00:00.000Z', // Mon 09:00 New York
  strategyId: null,
  mark: 20_001,
  markReason: null,
  unrealizedPnl: 20,
  brokerUnrealizedPnl: 20,
  initialRisk: 200,
  rMultiple: 0.1,
  stopRemainingPct: 110,
  stopDistanceTicks: 44,
  targetProgressPct: 3,
  targetDistanceTicks: 116,
  riskToStop: 229,
  flags: [],
  ...o,
});

const view = (
  positions: PositionView[],
  used: { daily?: number; dd?: number } = {},
): AccountMonitorView => ({
  accountId: 'acct-a',
  asOf: '2026-09-28T14:00:00.000Z',
  status: 'OK',
  reason: null,
  currency: 'USD',
  equity: 50_000,
  positions,
  dailyLoss: {
    limit: 1_000,
    remaining: 500,
    usedPct: used.daily ?? 10,
    worstCaseRemaining: 300,
    worstCaseUsedPct: 70,
  },
  drawdown: {
    limit: 2_500,
    remaining: 2_000,
    usedPct: used.dd ?? 10,
    worstCaseRemaining: 1_800,
    worstCaseUsedPct: 28,
  },
  trailing: null,
  bufferUsedPct: 70,
});

const holding = (o: Partial<HoldingRules> = {}): HoldingRules => ({
  overnight: 'ALLOWED',
  weekend: 'ALLOWED',
  flatBy: null,
  weeklyClose: null,
  ...o,
});

const at = (iso: string, h: HoldingRules | null = null) => ({
  now: new Date(iso),
  holding: () => h,
});
const policy = ProtectionPolicySchema.parse({});
const NOW = '2026-09-28T14:00:00.000Z'; // Mon 10:00 New York

describe('ProtectionEvaluator', () => {
  it('does nothing when disabled, for healthy accounts, or accounts it cannot evaluate', () => {
    expect(
      new ProtectionEvaluator({ ...policy, enabled: false }).evaluate(
        [view([pos()], { daily: 99 })],
        at(NOW),
      ),
    ).toEqual([]);
    const e = new ProtectionEvaluator(policy);
    expect(e.evaluate([view([pos()])], at(NOW))).toEqual([]);
    expect(e.evaluate([{ ...view([pos()], { daily: 99 }), status: 'UNKNOWN' }], at(NOW))).toEqual(
      [],
    );
  });

  it('flattens everything near a hard limit and blocks the account', () => {
    const e = new ProtectionEvaluator(policy);
    const daily = e.evaluate(
      [view([pos(), pos({ positionId: 'p2', symbol: 'MNQ' })], { daily: 91 })],
      at(NOW),
    );
    expect(daily.map((a) => [a.trigger, a.positionId, a.blockAccount])).toEqual([
      ['LIMIT_PROXIMITY', 'p1', 'NEXT_TRADING_DAY'],
      ['LIMIT_PROXIMITY', 'p2', 'NEXT_TRADING_DAY'],
    ]);
    expect(daily[0]!.reason).toBe('LONG 1 NQ: daily loss limit 91.0% used (flatten at 90%)');
    // The drawdown limit (incl. a trailing threshold) blocks until a human clears it.
    expect(e.evaluate([view([pos()], { dd: 95 })], at(NOW))[0]).toMatchObject({
      blockAccount: 'MANUAL',
    });
  });

  it('closes a position without a stop only after the grace period', () => {
    const e = new ProtectionEvaluator(policy); // 10 s grace
    const naked = view([pos({ stopPrice: null })]);
    expect(e.evaluate([naked], at('2026-09-28T14:00:00.000Z'))).toEqual([]);
    expect(e.evaluate([naked], at('2026-09-28T14:00:09.000Z'))).toEqual([]);
    expect(e.evaluate([naked], at('2026-09-28T14:00:10.000Z'))).toMatchObject([
      {
        trigger: 'UNPROTECTED',
        positionId: 'p1',
        blockAccount: null,
        reason: 'LONG 1 NQ: no protective stop for 10 s (grace 10 s)',
      },
    ]);
    // A stop arrives: the clock resets.
    expect(e.evaluate([view([pos()])], at('2026-09-28T14:00:11.000Z'))).toEqual([]);
    expect(e.evaluate([naked], at('2026-09-28T14:00:12.000Z'))).toEqual([]);
  });

  it('flattens before the mandatory flat time and closes positions held through it', () => {
    const e = new ProtectionEvaluator(policy); // 2 min before
    const h = holding({ flatBy: { timeZone: 'America/New_York', time: '16:59' } });
    expect(e.evaluate([view([pos()])], at('2026-09-28T20:56:00.000Z', h))).toEqual([]); // 16:56
    expect(e.evaluate([view([pos()])], at('2026-09-28T20:57:00.000Z', h))).toMatchObject([
      {
        trigger: 'FLAT_BY',
        reason: 'LONG 1 NQ: mandatory flat time 16:59 America/New_York in 2.0 min',
      },
    ]);
    // Next morning: yesterday's position was held through 16:59; today's is fine.
    const acts = e.evaluate(
      [view([pos(), pos({ positionId: 'p2', openedAt: '2026-09-29T13:30:00.000Z' })])],
      at('2026-09-29T14:00:00.000Z', h),
    );
    expect(acts.map((a) => [a.trigger, a.positionId])).toEqual([['FLAT_BY', 'p1']]);
    expect(acts[0]!.reason).toMatch(/held through the mandatory flat time/);
  });

  it('flattens before the weekly close when weekend holding is prohibited', () => {
    const e = new ProtectionEvaluator(policy);
    const h = holding({
      weekend: 'PROHIBITED',
      weeklyClose: { day: 'FRI', timeZone: 'America/New_York', time: '16:00' },
    });
    // Fri 2 Oct 15:58:30 New York
    expect(
      e.evaluate(
        [view([pos({ openedAt: '2026-10-02T14:00:00.000Z' })])],
        at('2026-10-02T19:58:30.000Z', h),
      ),
    ).toMatchObject([{ trigger: 'WEEKLY_CLOSE' }]);
    // Weekend holding allowed: nothing.
    expect(
      e.evaluate(
        [view([pos()])],
        at('2026-10-02T19:58:30.000Z', holding({ weeklyClose: h.weeklyClose })),
      ),
    ).toEqual([]);
  });

  it('keeps one action per position, the most important trigger first', () => {
    const e = new ProtectionEvaluator({ ...policy, unprotectedGraceMs: 0 });
    const acts = e.evaluate([view([pos({ stopPrice: null })], { daily: 95 })], at(NOW));
    expect(acts.map((a) => a.trigger)).toEqual(['LIMIT_PROXIMITY']);
  });
});
