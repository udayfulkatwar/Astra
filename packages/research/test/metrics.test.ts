import { describe, expect, it } from 'vitest';
import {
  breakdown,
  byYear,
  insufficient,
  metrics,
  monteCarlo,
  renderStudy,
  robustness,
  split,
  walkForward,
  type ResearchRun,
  type ResearchTrade,
} from '../src';

let n = 0;
const trade = (r: number, closedAt: string, symbol = 'EURUSD'): ResearchTrade => ({
  id: `t${++n}`,
  symbol,
  direction: r >= 0 ? 'LONG' : 'SHORT',
  setupId: 's',
  decidedAt: closedAt,
  openedAt: closedAt,
  closedAt,
  durationMinutes: 60,
  entry: 1,
  exit: 1,
  stop: 1,
  target: 1,
  quantity: 1,
  exitReason: r > 0 ? 'TARGET' : 'STOP',
  riskMoney: 100,
  grossPnl: r * 100,
  commission: 0,
  netPnl: r * 100,
  r,
  liquidity: 'SWING_LOW',
  strongLiquidity: false,
  structure: 'BOS',
  score: 14,
  entryHourUtc: 9,
});

describe('§23 metrics', () => {
  it('win rate, averages, expectancy, profit factor, drawdown and streaks', () => {
    const ts = [
      trade(2, '2024-01-01T10:00:00Z'),
      trade(-1, '2024-01-02T10:00:00Z'),
      trade(-1, '2024-01-03T10:00:00Z'),
      trade(-1, '2024-01-04T10:00:00Z'),
      trade(2, '2024-01-05T10:00:00Z'),
    ];
    expect(metrics(ts)).toMatchObject({
      trades: 5,
      wins: 2,
      losses: 3,
      winRate: 40,
      avgWinR: 2,
      avgLossR: -1,
      expectancyR: 0.2,
      profitFactor: 1.33,
      totalR: 1,
      netPnl: 100,
      maxDrawdownR: 3,
      maxDrawdownMoney: 300,
      maxConsecutiveLosses: 3,
      avgDurationMinutes: 60,
    });
    expect(metrics([])).toMatchObject({ trades: 0, winRate: null, expectancyR: null });
    expect(breakdown(ts, byYear).map((b) => b.key)).toEqual(['2024']);
  });

  it('splits in-sample / out-of-sample and walks forward in fixed windows', () => {
    const ts = [
      trade(1, '2023-06-01T00:00:00Z'),
      trade(-1, '2024-02-01T00:00:00Z'),
      trade(2, '2024-09-01T00:00:00Z'),
    ];
    const s = split(ts, '2024-01-01T00:00:00Z');
    expect(s.inSample.trades).toBe(1);
    expect(s.outOfSample.totalR).toBe(1);
    const w = walkForward(ts, '2023-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 6);
    expect(w.map((x) => x.metrics.trades)).toEqual([1, 0, 1, 1]);
  });

  it('Monte Carlo is reproducible for a seed and bounded by the trades', () => {
    const ts = Array.from({ length: 50 }, (_, i) =>
      trade(i % 3 === 0 ? 2 : -1, `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`),
    );
    const a = monteCarlo(ts, { runs: 500, seed: 7 })!;
    expect(monteCarlo(ts, { runs: 500, seed: 7 })).toEqual(a);
    expect(a.totalR.p5).toBeLessThanOrEqual(a.totalR.p50);
    expect(a.totalR.p50).toBeLessThanOrEqual(a.totalR.p95);
    expect(a.drawdownAtLeast[0]!.probability).toBeGreaterThanOrEqual(
      a.drawdownAtLeast[3]!.probability,
    );
    expect(monteCarlo([])).toBeNull();
  });

  it('robustness removes the best year, pair, session and the largest winners', () => {
    const ts = [
      trade(5, '2023-03-01T00:00:00Z', 'GBPUSD'),
      trade(-1, '2024-03-01T00:00:00Z'),
      trade(1, '2024-04-01T00:00:00Z'),
    ];
    const r = robustness(ts);
    expect(r.withoutBestYear).toMatchObject({ year: '2023', metrics: { totalR: 0 } });
    expect(r.withoutBestPair).toMatchObject({ pair: 'GBPUSD', metrics: { totalR: 0 } });
    expect(r.withoutTop5Winners.trades).toBe(0); // only 3 trades: all are among the top 5
  });

  it('says INSUFFICIENT DATA below 30 trades — in the report too', () => {
    const few = [trade(2, '2024-01-01T00:00:00Z')];
    expect(insufficient(metrics(few))).toMatch(/^INSUFFICIENT DATA — 1 trade/);
    const run = {
      label: 'x',
      strategyId: 'lsfvg-a',
      accountId: 'paper-fx',
      model: 'A',
      params: {},
      costs: { slippageTicks: 2, limitThroughTicks: 1, commission: true, spreadMultiplier: 1 },
      propFirm: { mode: 'STRATEGY', profileId: 'template-static-50k-study', name: 'study' },
      calendar: { kind: 'NOT_MODELLED', source: null },
      window: { from: '2024-01-01T00:00:00Z', to: '2024-12-31T00:00:00Z' },
      coverage: [],
      startingBalance: 50_000,
      endingBalance: 50_200,
      trades: few,
      funnel: {},
      gate: {
        setups: 1,
        approved: 1,
        rejected: 0,
        filled: 1,
        missed: 0,
        invalidated: 0,
        blockedBy: [],
      },
      equity: [],
      breach: null,
      protectiveCloses: 0,
      records: [],
    } as unknown as ResearchRun;
    const md = renderStudy({
      generatedAt: '2026-09-28T00:00:00Z',
      window: { from: run.window.from, to: run.window.to, outOfSampleFrom: '2024-07-01T00:00:00Z' },
      data: [],
      assumptions: ['spread ASSUMED 0.5 pip'],
      models: [
        {
          afterCosts: run,
          beforeCosts: null,
          split: split(few, '2024-07-01T00:00:00Z'),
          walkForward: walkForward(few, run.window.from, run.window.to, 6),
          monteCarlo: monteCarlo(few),
          robustness: robustness(few),
          sensitivity: [],
        },
      ],
    });
    expect(md).toMatch(/INSUFFICIENT DATA — 1 trade/);
    expect(md).toMatch(/Strategy study: no prop-firm limits were applied/);
    expect(md).toMatch(/NOT MODELLED/);
    expect(md).toMatch(/A prop-firm pass\/fail needs the firm/);
    expect(md).not.toMatch(/profitable/i);
  });
});
