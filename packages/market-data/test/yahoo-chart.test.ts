import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/bar';
import {
  YAHOO_CHART_URL,
  parseYahooChart,
  yahooBackfill,
  type FetchLike,
} from '../src/feeds/yahoo-chart';
import { rollUp } from '../src/rollup';
import { GLOBEX, m1 } from './fixtures';

const s = (iso: string) => Date.parse(iso) / 1000;
const NOW = Date.parse('2026-09-28T14:10:30.000Z');
const OPTS = { symbol: 'NQ', source: 'yahoo', sourceKind: 'LIVE' as const, nowMs: NOW };

/**
 * SYNTHETIC response in the documented chart format (made-up prices, not market data): the
 * shape yfinance reads — `chart.result[0].timestamp[]` + `indicators.quote[0]` arrays.
 */
function chart(
  rows: [string, number | null, number | null, number | null, number | null, number | null][],
) {
  return {
    chart: {
      result: [
        {
          meta: { symbol: 'NQ=F', dataGranularity: '1m' },
          timestamp: rows.map((r) => s(r[0])),
          indicators: {
            quote: [
              {
                open: rows.map((r) => r[1]),
                high: rows.map((r) => r[2]),
                low: rows.map((r) => r[3]),
                close: rows.map((r) => r[4]),
                volume: rows.map((r) => r[5]),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

describe('parseYahooChart', () => {
  it('keeps genuine complete 1-minute candles; drops nulls, inconsistent and unaligned ones', () => {
    const r = parseYahooChart(
      chart([
        ['2026-09-28T14:00:00Z', 100, 101, 99, 100.5, 12],
        ['2026-09-28T14:01:00Z', null, null, null, null, null], // no trade → gap, not filled
        ['2026-09-28T14:02:00Z', 100, 99, 98, 98.5, 3], // high below open → inconsistent
        ['2026-09-28T14:03:00Z', 100.5, 102, 100, 101, 0], // FX-style 0 volume → null
        ['2026-09-28T14:04:30Z', 101, 102, 100, 101, 5], // not minute-aligned
        ['2026-09-28T14:03:00Z', 1, 2, 1, 1, 1], // duplicate minute
        ['2026-09-28T14:10:00Z', 101, 103, 101, 102, 7], // still in progress at NOW
      ]),
      OPTS,
    );
    expect(r).toMatchObject({ received: 7, dropped: 4 });
    expect(r.bars).toEqual([
      {
        symbol: 'NQ',
        timeframe: 'M1',
        openTime: '2026-09-28T14:00:00.000Z',
        closeTime: '2026-09-28T14:01:00.000Z',
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 12,
        tickCount: 0,
        complete: true,
        source: 'yahoo',
        sourceKind: 'LIVE',
      },
      expect.objectContaining({ openTime: '2026-09-28T14:03:00.000Z', volume: null }),
    ]);
  });

  it('refuses error and non-chart responses instead of returning empty history', () => {
    expect(() => parseYahooChart({ foo: 1 }, OPTS)).toThrow(/not a chart response/);
    expect(() =>
      parseYahooChart(
        { chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } },
        OPTS,
      ),
    ).toThrow(/No data found/);
    expect(() => parseYahooChart({ chart: { result: [{}] } }, OPTS)).toThrow(/without candles/);
  });
});

describe('rollUp', () => {
  const minutes = (fromIso: string, n: number, extra: Partial<Bar> = {}) =>
    Array.from({ length: n }, (_, i) => {
      const t = new Date(Date.parse(fromIso) + i * 60_000).toISOString();
      return m1(t, 100 + i, 99 + i, { volume: 10, ...extra });
    });

  it('builds only whole, ended periods: first partial and in-progress periods are left out', () => {
    // 13:58 … 14:11: 13:55–14:00 began before the history, 14:10–14:15 has not ended at NOW.
    const bars = rollUp(minutes('2026-09-28T13:58:00Z', 14), 'M5', GLOBEX, NOW);
    expect(bars.map((b) => b.openTime)).toEqual([
      '2026-09-28T14:00:00.000Z',
      '2026-09-28T14:05:00.000Z',
    ]);
    expect(bars[0]).toMatchObject({
      timeframe: 'M5',
      closeTime: '2026-09-28T14:05:00.000Z',
      open: 99 + 2, // the 14:00 minute's open (= its low in the fixture)
      high: 100 + 6,
      low: 99 + 2,
      close: 100 + 6,
      volume: 50,
      tickCount: 0,
      complete: true,
      source: 'feed',
    });
  });

  it('a gap minute stays a gap (fewer minutes, nothing filled); volume only when every minute has one', () => {
    const m = minutes('2026-09-28T14:00:00Z', 5);
    const withGap = [m[0]!, m[1]!, m[3]!, m[4]!];
    const [bar] = rollUp(withGap, 'M5', GLOBEX, NOW);
    expect(bar).toMatchObject({ high: 104, low: 99, volume: 40 });
    const noVolume = [...m.slice(0, 4), { ...m[4]!, volume: null }];
    expect(rollUp(noVolume, 'M5', GLOBEX, NOW)[0]!.volume).toBeNull();
    expect(rollUp([], 'H1', GLOBEX, NOW)).toEqual([]);
  });
});

describe('yahooBackfill', () => {
  it('requests 1-minute history for the provider symbol and builds the requested timeframes', async () => {
    const calls: string[] = [];
    const rows = Array.from({ length: 10 }, (_, i) => {
      const t = new Date(Date.parse('2026-09-28T14:00:00Z') + i * 60_000).toISOString();
      return [t, 100, 101, 99, 100, 1] as [string, number, number, number, number, number];
    });
    const fetch: FetchLike = (url, init) => {
      calls.push(url);
      expect(init?.headers?.['User-Agent']).toMatch(/ASTRA/);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(chart(rows)) });
    };
    const r = await yahooBackfill({
      ...OPTS,
      providerSymbol: 'NQ=F',
      timeframes: ['M1', 'M5', 'H1'],
      tradingHours: GLOBEX,
      fetch,
    });
    expect(calls).toEqual([`${YAHOO_CHART_URL}/NQ%3DF?range=5d&interval=1m&includePrePost=true`]);
    expect(r).toMatchObject({ received: 10, kept: 10, dropped: 0 });
    expect(r.bars.filter((b) => b.timeframe === 'M1')).toHaveLength(10);
    expect(r.bars.filter((b) => b.timeframe === 'M5')).toHaveLength(2);
    expect(r.bars.filter((b) => b.timeframe === 'H1')).toHaveLength(0); // hour not over
  });

  it('fails loudly on HTTP errors (the caller logs it; the stream still starts)', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
    await expect(
      yahooBackfill({
        ...OPTS,
        providerSymbol: 'NQ=F',
        timeframes: ['M1'],
        tradingHours: GLOBEX,
        fetch,
      }),
    ).rejects.toThrow(/HTTP 429/);
  });
});
