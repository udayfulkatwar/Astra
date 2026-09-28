import { nextDailyTime } from '@astra/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Bar } from '@astra/market-data';
import { runBacktest, simulateM1Bars, type BacktestEnvironment, type BacktestResult } from '../src';
import { config, environment } from './helpers';

const spec = config.instruments.get('MNQ')!;
const sim = (seed: number, from = '2026-03-02T00:00:00Z', to = '2026-03-07T00:00:00Z') =>
  simulateM1Bars({
    symbol: 'MNQ',
    tickSize: 0.25,
    startPrice: 18_000,
    from,
    to,
    hours: spec.tradingHours!,
    seed,
  });
const BARS = sim(7);
const BASE = {
  symbol: 'MNQ',
  accountId: 'paper-demo',
  calendar: 'SIMULATED_SCHEDULE',
  news: 'SIMULATED_FEED',
} as const;
const run = (bars: readonly Bar[], env: BacktestEnvironment = environment(), extra = {}) =>
  runBacktest({ config: { ...BASE, ...extra }, bars, env });

describe('runBacktest', () => {
  it('trades through the real decision gate and journals every closed trade', async () => {
    const r = await run(BARS);
    expect(r.decisions.signals).toBeGreaterThan(0);
    expect(r.decisions.approved).toBeGreaterThan(0);
    expect(r.decisions.approved + r.decisions.rejected).toBe(r.decisions.signals);
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t).toMatchObject({
        source: 'ASTRA',
        mode: 'BACKTEST',
        strategyId: 'structure-breakout-template',
      });
      expect(t.plan).not.toBeNull();
    }
    expect(r.summary.overall.trades).toBe(r.trades.length);
    expect(r.label).toBe('Engine test on SIMULATED data — not evidence of performance');
    expect(r.warnings[0]).toContain('SIMULATED');
    expect(r.strategy.ownership).toBe('TEMPLATE');
    expect(r.equity.length).toBeLessThanOrEqual(400);
    expect(r.performance.endingEquity).toBe(r.equity.at(-1)!.equity);
  });

  it('fills every entry at the open of the bar after the decision (ask/bid + slippage)', async () => {
    const r = await run(BARS);
    const byOpen = new Map(BARS.map((b) => [b.openTime, b]));
    for (const t of r.trades) {
      expect(Date.parse(t.entry.at)).toBeGreaterThanOrEqual(Date.parse(t.plan!.decidedAt!));
      const bar = byOpen.get(t.entry.at)!;
      const adverse = 0.125 + 0.25;
      expect(t.entry.price).toBe(t.direction === 'LONG' ? bar.open + adverse : bar.open - adverse);
    }
  });

  it('is deterministic', async () => {
    expect(JSON.stringify(await run(BARS))).toBe(JSON.stringify(await run(BARS)));
  });

  it('has no lookahead: a run cut at any bar agrees with the full run up to the cut', async () => {
    const full = await run(BARS);
    const upTo = (r: BacktestResult, t: string) => ({
      decisions: r.decisions.log.filter((d) => d.at <= t).map((d) => ({ ...d, fill: null })),
      trades: r.trades.filter((x) => x.exit.at <= t),
      protective: r.protective.filter((p) => p.at <= t),
    });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 500, max: BARS.length - 1 }), async (k) => {
        const prefix = await run(BARS.slice(0, k));
        const t = BARS[k - 1]!.closeTime;
        expect(upTo(prefix, t)).toEqual(upTo(full, t));
      }),
      { numRuns: 6, seed: 42 },
    );
  }, 60_000);

  it('applies news risk from the SIMULATED feed through the real gate', async () => {
    const r = await run(BARS);
    expect(r.warnings).toContain('News comes from the SIMULATED placeholder feed, not real news.');
    // Treating every news level as blocking proves the assessment reaches the gate.
    const env = environment();
    const news = {
      ...env.config.policy.news,
      blockLevels: ['HIGH', 'ELEVATED', 'NORMAL'] as const,
    };
    const policy = { ...env.config.policy, news: { ...news, blockLevels: [...news.blockLevels] } };
    const blocked = await run(BARS, { ...env, config: { ...env.config, policy } });
    expect(blocked.decisions.signals).toBeGreaterThan(0);
    expect(blocked.decisions.approved).toBe(0);
    expect(blocked.decisions.blockedBy.find((b) => b.checkId === 'news.risk')?.count).toBe(
      blocked.decisions.signals,
    );
  });

  it('says so loudly when news is not modelled', async () => {
    const r = await run(BARS, environment(), { news: 'NOT_MODELLED' });
    expect(r.warnings).toContain('News risk NOT applied: no news data was used for this period.');
    expect(r.decisions.blockedBy.find((b) => b.checkId === 'news.risk')).toBeUndefined();
  });

  it('says so loudly when the calendar is not modelled', async () => {
    const r = await run(BARS, environment(), { calendar: 'NOT_MODELLED' });
    expect(r.warnings).toContain(
      'Economic-event blackout NOT applied: no calendar data was used for this period.',
    );
    expect(
      r.decisions.blockedBy.find((b) => b.checkId === 'calendar.event-blackout'),
    ).toBeUndefined();
  });

  it('replays recorded (non-simulated) bars as HISTORICAL data, accepted in BACKTEST', async () => {
    const recorded = BARS.map((b) => ({ ...b, source: 'paper-feed', sourceKind: 'LIVE' as const }));
    const r = await run(recorded);
    expect(r.label).toBe('Historical replay — past results do not predict future results');
    expect(r.decisions.blockedBy.find((b) => b.checkId === 'data.source-kinds')).toBeUndefined();
    expect(r.decisions.approved).toBeGreaterThan(0);
  });

  it('closes positions automatically before a mandatory flat time (protection)', async () => {
    const env = environment();
    const account = {
      ...env.config.account('paper-demo')!,
      propFirmProfileId: 'template-trailing-50k',
    };
    const view = {
      ...env.config,
      account: (id: string) => (id === account.id ? account : undefined),
    };
    const bars = sim(5, '2026-03-02T00:00:00Z', '2026-03-14T00:00:00Z');
    const r = await run(bars, { ...env, config: view });
    expect(r.protective.length).toBeGreaterThan(0);
    expect(r.protective.every((p) => p.trigger === 'FLAT_BY')).toBe(true);
    expect(r.trades.some((t) => t.exit.reason === 'PROTECTIVE')).toBe(true);
    // No trade is ever held through 16:59 New York.
    for (const t of r.trades) {
      const flat = nextDailyTime(new Date(t.entry.at), {
        timeZone: 'America/New_York',
        time: '16:59',
      });
      expect(Date.parse(t.exit.at)).toBeLessThanOrEqual(flat.getTime());
    }
  }, 30_000);

  it('rejects invalid runs before replaying anything', async () => {
    await expect(run([])).rejects.toThrow('no bars');
    await expect(run([BARS[1]!, BARS[0]!])).rejects.toThrow('not strictly ordered');
    await expect(run(BARS.slice(0, 5).map((b) => ({ ...b, symbol: 'NQ' })))).rejects.toThrow(
      'bar for NQ',
    );
    await expect(
      runBacktest({ config: { ...BASE, accountId: 'nope' }, bars: BARS, env: environment() }),
    ).rejects.toThrow('account nope not found');
    await expect(
      runBacktest({ config: { ...BASE, symbol: 'ES' }, bars: BARS, env: environment() }),
    ).rejects.toThrow('no instrument spec for ES');
    // The calendar and news choices are explicit: there is no silent default.
    await expect(
      runBacktest({
        config: { symbol: 'MNQ', accountId: 'paper-demo', calendar: 'NOT_MODELLED' } as never,
        bars: BARS,
        env: environment(),
      }),
    ).rejects.toThrow();
    await expect(
      runBacktest({
        config: { symbol: 'MNQ', accountId: 'paper-demo' } as never,
        bars: BARS,
        env: environment(),
      }),
    ).rejects.toThrow();
  });
});

describe('simulateM1Bars', () => {
  it('is seeded, labelled SIMULATED, on the tick grid and only while the market is open', () => {
    const a = sim(3, '2026-03-06T20:00:00Z', '2026-03-09T02:00:00Z');
    expect(a).toEqual(sim(3, '2026-03-06T20:00:00Z', '2026-03-09T02:00:00Z'));
    expect(a.every((b) => b.sourceKind === 'SIMULATED')).toBe(true);
    expect(
      a.every((b) => [b.open, b.high, b.low, b.close].every((p) => Number.isInteger(p / 0.25))),
    ).toBe(true);
    // Friday 17:00 ET close → Sunday 18:00 ET open: nothing in between.
    const weekend = a.filter(
      (b) => b.openTime >= '2026-03-06T22:00:00.000Z' && b.openTime < '2026-03-08T22:00:00.000Z',
    );
    expect(weekend).toEqual([]);
    expect(a.at(-1)!.closeTime <= '2026-03-09T02:00:00.000Z').toBe(true);
  });
});

describe('runBacktest — FX quoted in another currency', () => {
  const jpy = config.instruments.get('USDJPY')!;
  const bars = simulateM1Bars({
    symbol: 'USDJPY',
    tickSize: jpy.tickSize,
    startPrice: 150,
    from: '2026-03-02T00:00:00Z',
    to: '2026-03-07T00:00:00Z',
    hours: jpy.tradingHours!,
    seed: 11,
  });
  const fxRun = (env = environment()) =>
    runBacktest({ config: { ...BASE, symbol: 'USDJPY', accountId: 'paper-fx' }, bars, env });

  it('values USD/JPY in dollars with the replayed rate: a stop loses about the planned risk', async () => {
    const r = await fxRun();
    const stopped = r.trades.filter((t) => t.exit.reason === 'STOP' && t.plan?.plannedRisk);
    expect(stopped.length).toBeGreaterThan(0);
    for (const t of stopped) {
      // Planned risk (sized in USD at the decision) vs the booked loss (converted at the exit):
      // unconverted yen would be ~150× larger.
      const ratio = Math.abs(t.result.grossPnl) / t.plan!.plannedRisk!;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(1.5);
    }
  });

  it("refuses a replay it cannot value with the instrument's own price", async () => {
    const env = environment();
    const gbpQuoted = { ...jpy, quoteCurrency: 'GBP' };
    await expect(
      fxRun({
        ...env,
        config: {
          ...env.config,
          instrument: (s) => (s === 'USDJPY' ? gbpQuoted : env.config.instrument(s)),
        },
      }),
    ).rejects.toThrow(/can only convert with its own price/);
  });
});
