import type { SessionDefinition } from '@astra/core';
import type { JournalEntry, TradeContext } from '@astra/journal';
import { describe, expect, it } from 'vitest';
import { learningReport, meanInterval, tCritical95, welchT } from '../src';

let seq = 0;
function entry(o: {
  r: number;
  at?: string;
  direction?: 'LONG' | 'SHORT';
  strategy?: string | null;
  mode?: string;
  context?: TradeContext;
  exit?: string;
}): JournalEntry {
  seq++;
  const at = o.at ?? new Date(Date.parse('2026-09-28T14:30:00Z') + seq * 3_600_000).toISOString();
  const pnl = o.r * 100;
  const outcome = Math.abs(pnl) <= 5 ? 'BREAKEVEN' : pnl > 0 ? 'WIN' : 'LOSS';
  return {
    tradeId: `t${seq}`,
    accountId: 'acct',
    source: o.strategy === null ? 'EXTERNAL' : 'ASTRA',
    strategyId: o.strategy === undefined ? 'breakout' : o.strategy,
    signalId: null,
    decisionId: null,
    mode: o.mode ?? 'PAPER',
    symbol: 'NQ',
    direction: o.direction ?? 'LONG',
    quantity: 1,
    plan: null,
    entry: { price: 100, at, slippageTicks: 1 },
    exit: {
      price: 100,
      at: new Date(Date.parse(at) + 600_000).toISOString(),
      reason: o.exit ?? (pnl > 0 ? 'TARGET' : 'STOP'),
      slippageTicks: pnl > 0 ? 0 : 1,
    },
    durationSec: 600,
    result: {
      grossPnl: pnl,
      costs: 0,
      costsSource: 'INSTRUMENT_SPEC',
      netPnl: pnl,
      initialRisk: 100,
      rMultiple: o.r,
      outcome,
    },
    excursion: {
      mfe: { price: 101, pnl: Math.max(pnl, 150), r: Math.max(o.r, 1.5) },
      mae: { price: 99, pnl: -50, r: -0.5 },
      coverage: 'FULL',
      observedFrom: at,
    },
    exitedAsPlanned: true,
    ...(o.context ? { context: o.context } : {}),
  };
}

describe('statistics helpers', () => {
  it('uses Student-t critical values and a symmetric interval around the mean', () => {
    expect(tCritical95(1)).toBe(12.706);
    expect(tCritical95(30)).toBe(2.042);
    expect(tCritical95(1_000)).toBeGreaterThan(1.96);
    expect(tCritical95(1_000)).toBeLessThan(1.97);
    const ci = meanInterval([1, 2, 3])!;
    expect(ci.lo + ci.hi).toBeCloseTo(4);
    expect(ci.hi - 2).toBeCloseTo(4.303 / Math.sqrt(3)); // sd = 1
    expect(meanInterval([1])).toBeNull();
    expect(welchT([2, 3, 4], [0, 1, 2])).toBeGreaterThan(0);
  });
});

describe('learningReport', () => {
  it('describes the trades: overall R statistics, drawdown in R and money, losing streaks', () => {
    const rs = [1, -1, -1, 2, -1, 1.5, -1, -1, -1];
    const r = learningReport(rs.map((x) => entry({ r: x })));
    expect(r.overall).toMatchObject({ trades: 9, rTrades: 9, wins: 3, losses: 6, totalR: -1.5 });
    expect(r.overall.smallSample).toBe(true);
    // Cumulative R: 1, 0, −1, 1, 0, 1.5, 0.5, −0.5, −1.5 → peak 1.5, trough −1.5.
    expect(r.drawdown.maxR).toBe(3);
    expect(r.drawdown.maxMoney).toBe(300);
    expect(r.drawdown.losingStreaks).toEqual([
      { length: 1, count: 1 },
      { length: 2, count: 1 },
      { length: 3, count: 1 },
    ]);
    expect(r.curve.at(-1)).toMatchObject({ n: 9, cumR: -1.5, cumPnl: -150 });
    expect(r.observations).toEqual([]);
    expect(r.notes[0]).toContain('Only 9 trades');
    expect(r.notes.at(-1)).toContain('never changes risk settings');
  });

  it('groups by hour and weekday in the chosen time zone, and by session at entry', () => {
    const sessions: SessionDefinition[] = [
      {
        id: 'new-york',
        name: 'New York',
        timeZone: 'America/New_York',
        start: '09:30',
        end: '16:00',
        days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      },
    ];
    const r = learningReport(
      [
        entry({ r: 1, at: '2026-09-28T14:30:00.000Z' }), // Mon 10:30 New York
        entry({ r: -1, at: '2026-09-28T12:00:00.000Z' }), // Mon 08:00 New York
      ],
      { timeZone: 'America/New_York', sessions },
    );
    const dim = (d: string) => r.dimensions.find((x) => x.dimension === d)!;
    expect(dim('hour').groups.map((g) => g.key)).toEqual(['08:00', '10:00']);
    expect(dim('weekday').groups.map((g) => g.key)).toEqual(['Mon']);
    expect(dim('session').groups.map((g) => [g.key, g.avgR])).toEqual([
      ['(outside sessions)', -1],
      ['new-york', 1],
    ]);
    expect(dim('hour').label).toBe('Hour of entry (America/New_York)');
  });

  it('shows missing context as unknown and says which facts are simulated', () => {
    const ctx: TradeContext = {
      setup: 'BOS',
      timeframe: 'M15',
      eventDay: 'YES',
      heldThroughEvent: 'NO',
      calendarSource: 'SIMULATED',
    };
    const r = learningReport([entry({ r: 1, context: ctx }), entry({ r: -1 })]);
    const keys = (d: string) =>
      r.dimensions
        .find((x) => x.dimension === d)!
        .groups.map((g) => g.key)
        .sort();
    expect(keys('setup')).toEqual(['(not labelled)', 'BOS']);
    expect(keys('eventDay')).toEqual(['unknown (not covered)', 'yes']);
    expect(r.notes.some((n) => n.includes('1 trade(s) were recorded before trade context'))).toBe(
      true,
    );
    expect(r.notes.some((n) => n.includes('SIMULATED placeholder calendar'))).toBe(true);
  });

  it('raises an observation only when both sides have enough trades', () => {
    const trades = [
      ...Array.from({ length: 40 }, (_, i) =>
        entry({ r: i % 4 === 0 ? -1 : 1.5, direction: 'LONG' }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        entry({ r: i % 4 === 0 ? 1 : -1, direction: 'SHORT' }),
      ),
    ];
    const r = learningReport(trades);
    const long = r.observations.find((o) => o.dimension === 'direction' && o.group === 'LONG');
    expect(long).toMatchObject({
      strength: 'STRONG',
      direction: 'BETTER',
      rTrades: 40,
      restRTrades: 40,
    });
    const short = r.observations.find((o) => o.dimension === 'direction' && o.group === 'SHORT');
    expect(short?.direction).toBe('WORSE');
    expect(r.notes.some((n) => n.includes('group comparisons'))).toBe(true);
    // Not enough trades on each side at a higher bar: no observation.
    expect(learningReport(trades, { minSample: 41 }).observations).toEqual([]);
  });

  it('measures execution quality from recorded slippage and excursions', () => {
    const r = learningReport([
      entry({ r: 1.5 }),
      entry({ r: -1 }),
      entry({ r: -1, exit: 'PROTECTIVE' }),
    ]);
    expect(r.execution.entrySlippage).toEqual({ trades: 3, avgTicks: 1, adversePct: 100 });
    expect(r.execution.stopSlippage).toEqual({ trades: 1, avgTicks: 1 });
    expect(r.execution.protectiveExits).toBe(1);
    // Winner: realised 1.5 R of a 1.5 R best; both losers had been +1.5 R first.
    expect(r.execution.excursion).toMatchObject({
      trades: 3,
      winnersCapturePct: 100,
      losersAfterPlusOneR: 2,
      losers: 2,
    });
  });
});
