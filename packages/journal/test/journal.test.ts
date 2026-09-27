import type { InstrumentSpec } from '@astra/core';
import { describe, expect, it } from 'vitest';
import { buildJournalEntry, type ClosedTradeInput, type OrderInput } from '../src/entry';
import { ExcursionTracker } from '../src/excursion';
import { journalStats, journalSummary } from '../src/stats';

const NQ: InstrumentSpec = {
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
  verification: { status: 'UNVERIFIED' },
};

const trade = (o: Partial<ClosedTradeInput> = {}): ClosedTradeInput => ({
  positionId: 'pos-a',
  accountId: 'acct-a',
  clientOrderId: 'astra-apr_1',
  symbol: 'NQ',
  direction: 'LONG',
  quantity: 2,
  entryPrice: 20_000.25,
  exitPrice: 20_030,
  exitReason: 'TARGET',
  realizedPnl: 1_190, // 29.75 pt × $20 × 2
  openedAt: '2026-09-28T14:00:00.000Z',
  closedAt: '2026-09-28T14:12:30.000Z',
  ...o,
});
const order = (o: Partial<OrderInput> = {}): OrderInput => ({
  decisionId: 'dec_1',
  strategyId: 'breakout',
  signalId: 'sig-1',
  mode: 'PAPER',
  plannedEntry: 20_000,
  stopLoss: 19_990,
  takeProfit: 20_030,
  quantity: 2,
  ...o,
});
const decision = {
  decidedAt: '2026-09-28T13:59:59.000Z',
  configHash: 'sha256:abc',
  plannedRisk: 418,
};

describe('ExcursionTracker', () => {
  it('tracks exit-side extremes and marks late tracking as PARTIAL', () => {
    const t = new ExcursionTracker();
    t.sync(
      [
        {
          accountId: 'a',
          positionId: 'L',
          symbol: 'NQ',
          direction: 'LONG',
          entryPrice: 100,
          openedAt: '2026-09-28T14:00:00.000Z',
        },
        {
          accountId: 'a',
          positionId: 'S',
          symbol: 'NQ',
          direction: 'SHORT',
          entryPrice: 100,
          openedAt: '2026-09-28T13:00:00.000Z',
        },
      ],
      new Date('2026-09-28T14:00:02.000Z'),
    );
    for (const [bid, ask] of [
      [103, 103.5],
      [97, 97.5],
      [101, 101.5],
    ] as const)
      t.onQuote({ symbol: 'NQ', bid, ask, asOf: '2026-09-28T14:00:03.000Z' });
    t.onQuote({ symbol: 'ES', bid: 1, ask: 2, asOf: '2026-09-28T14:00:03.000Z' }); // other symbol
    expect(t.take('L')).toEqual({
      bestPrice: 103, // bid
      worstPrice: 97,
      observedFrom: '2026-09-28T14:00:00.000Z',
      coverage: 'FULL',
      quotes: 3,
    });
    expect(t.take('S')).toMatchObject({
      bestPrice: 97.5, // ask
      worstPrice: 103.5,
      coverage: 'PARTIAL', // first seen an hour after it opened
      observedFrom: '2026-09-28T14:00:02.000Z',
    });
    expect(t.take('L')).toBeNull();
  });

  it('prunes positions nobody collected', () => {
    const t = new ExcursionTracker();
    t.sync(
      [
        {
          accountId: 'a',
          positionId: 'X',
          symbol: 'NQ',
          direction: 'LONG',
          entryPrice: 1,
          openedAt: '2026-09-28T14:00:00.000Z',
        },
      ],
      new Date('2026-09-28T14:00:00.000Z'),
    );
    t.prune([]);
    expect(t.size()).toBe(0);
  });
});

describe('buildJournalEntry', () => {
  it('records plan vs actual for a target exit, with costs, R and excursions', () => {
    const e = buildJournalEntry({
      trade: trade(),
      order: order(),
      decision,
      spec: NQ,
      excursion: {
        bestPrice: 20_031,
        worstPrice: 19_995,
        observedFrom: '2026-09-28T14:00:00.000Z',
        coverage: 'FULL',
        quotes: 90,
      },
    });
    expect(e).toMatchObject({
      source: 'ASTRA',
      strategyId: 'breakout',
      plan: { entry: 20_000, stop: 19_990, target: 20_030, rewardToRisk: 3, plannedRisk: 418 },
      entry: { price: 20_000.25, slippageTicks: 1 }, // one tick worse than planned
      exit: { price: 20_030, reason: 'TARGET', slippageTicks: 0 },
      durationSec: 750,
      result: {
        grossPnl: 1_190,
        costs: 8,
        costsSource: 'INSTRUMENT_SPEC',
        netPnl: 1_182,
        initialRisk: 410, // 10.25 pt × $40
        rMultiple: 2.88,
        outcome: 'WIN',
      },
      excursion: {
        mfe: { price: 20_031, pnl: 1_230, r: 3 },
        mae: { price: 19_995, pnl: -210, r: -0.51 },
        coverage: 'FULL',
      },
      exitedAsPlanned: true,
    });
  });

  it('measures stop slippage; a trade without an ASTRA order has no plan and no R', () => {
    const stop = buildJournalEntry({
      trade: trade({
        quantity: 1,
        entryPrice: 20_000,
        exitPrice: 19_989.5,
        exitReason: 'STOP',
        realizedPnl: -210,
      }),
      order: order({ quantity: 1 }),
      decision,
      spec: NQ,
      excursion: null,
    });
    expect(stop).toMatchObject({
      exit: { slippageTicks: 2 },
      result: { netPnl: -214, rMultiple: -1.07, outcome: 'LOSS' },
      excursion: null,
    });
    const external = buildJournalEntry({
      trade: trade({ clientOrderId: null, exitReason: 'MANUAL' }),
      order: null,
      decision: null,
      spec: NQ,
      excursion: null,
    });
    expect(external).toMatchObject({
      source: 'EXTERNAL',
      plan: null,
      entry: { slippageTicks: null },
      result: { initialRisk: null, rMultiple: null, outcome: 'WIN' },
      exitedAsPlanned: false,
    });
  });
});

describe('journalStats', () => {
  const a = buildJournalEntry({
    trade: trade(),
    order: order(),
    decision,
    spec: NQ,
    excursion: null,
  });
  const b = buildJournalEntry({
    trade: trade({
      positionId: 'pos-b',
      quantity: 1,
      entryPrice: 20_000,
      exitPrice: 19_989.5,
      exitReason: 'STOP',
      realizedPnl: -210,
      closedAt: '2026-09-28T15:00:00.000Z',
    }),
    order: order({ quantity: 1 }),
    decision,
    spec: NQ,
    excursion: null,
  });
  const c = buildJournalEntry({
    trade: trade({
      positionId: 'pos-c',
      clientOrderId: null,
      direction: 'SHORT',
      quantity: 1,
      entryPrice: 20_010,
      exitPrice: 20_010,
      exitReason: 'MANUAL',
      realizedPnl: 0,
      closedAt: '2026-09-28T16:00:00.000Z',
    }),
    order: null,
    decision: null,
    spec: NQ,
    excursion: null,
  });

  it('summarises outcomes, R, P&L and plan adherence over recorded trades only', () => {
    const s = journalStats([a, b, c]);
    expect(s).toMatchObject({
      trades: 3,
      wins: 1,
      losses: 1,
      breakeven: 1, // −$4 net is within one tick
      winRatePct: 50,
      rTrades: 2,
      netPnl: 964,
      grossPnl: 980,
      avgWin: 1_182,
      avgLoss: -214,
      profitFactor: 5.52,
      maxConsecutiveLosses: 1,
      exitedAsPlannedPct: 100, // external trades are not counted
      byExitReason: { TARGET: 1, STOP: 1, MANUAL: 1 },
    });
    expect(s.avgR).toBeCloseTo(0.9, 1);
    expect(journalStats([])).toMatchObject({
      trades: 0,
      winRatePct: null,
      avgR: null,
      netPnl: null,
      profitFactor: null,
    });
  });

  it('groups by strategy, instrument and exit reason', () => {
    const sum = journalSummary([a, b, c]);
    expect(sum.byStrategy.map((g) => [g.key, g.stats.trades])).toEqual([
      ['breakout', 2],
      ['(external)', 1],
    ]);
    expect(sum.bySymbol).toHaveLength(1);
    expect(sum.byExitReason.map((g) => g.key)).toEqual(['MANUAL', 'STOP', 'TARGET']);
  });
});

describe('ExcursionTracker.prune', () => {
  it('keeps positions of accounts that could not be read', () => {
    const t = new ExcursionTracker();
    const p = (id: string, accountId: string) => ({
      accountId,
      positionId: id,
      symbol: 'NQ',
      direction: 'LONG' as const,
      entryPrice: 1,
      openedAt: '2026-09-28T14:00:00.000Z',
    });
    t.sync([p('A1', 'a'), p('B1', 'b')], new Date('2026-09-28T14:00:00.000Z'));
    t.prune([], (acct) => acct === 'b');
    expect(t.take('A1')).toBeNull();
    expect(t.take('B1')).not.toBeNull();
  });
});
