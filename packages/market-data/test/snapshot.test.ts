import { notObserved, observed, type Observed, type Quote } from '@astra/core';
import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/bar';
import { computeMarketSnapshot, type MarketSnapshotInputs } from '../src/snapshot';
import { TIMEFRAMES, type Timeframe } from '../src/timeframe';
import { SESSIONS, bar, instrument, m1 } from './fixtures';

const NOW = '2026-09-29T14:30:00.000Z'; // Tuesday 10:30 New York, 15:30 London

const quoteAt = (asOf: string, bid = 20_150): Observed<Quote> =>
  observed(
    { symbol: 'NQ', bid, ask: bid + 0.5, asOf },
    { source: 'feed', sourceKind: 'LIVE', asOf },
  );

function noBars(): Record<Timeframe, Bar[]> {
  return Object.fromEntries(TIMEFRAMES.map((tf) => [tf, []])) as unknown as Record<
    Timeframe,
    Bar[]
  >;
}

function inputs(overrides: Partial<MarketSnapshotInputs> = {}): MarketSnapshotInputs {
  return {
    symbol: 'NQ',
    now: new Date(NOW),
    instrument: instrument(),
    sessions: SESSIONS,
    quote: quoteAt('2026-09-29T14:29:59.000Z'),
    freshness: { maxAgeMs: 5_000, maxFutureSkewMs: 2_000 },
    lastJumpAt: null,
    bars: noBars(),
    m1CoverageFrom: '2026-09-29T06:00:00.000Z',
    ...overrides,
  };
}

// Trading days (18:00 New York = 22:00Z in September).
const monday = bar('D1', '2026-09-27T22:00:00Z', '2026-09-28T22:00:00Z', {
  open: 20_000,
  high: 20_100,
  low: 19_900,
  close: 20_050,
});
const tuesday = bar(
  'D1',
  '2026-09-28T22:00:00Z',
  '2026-09-29T22:00:00Z',
  { open: 20_050, high: 20_200, low: 20_000, close: 20_150 },
  { complete: false },
);
const minutes = [
  m1('2026-09-29T12:05:00Z', 20_180, 20_100), // after NY 08:00 (12:00Z), after London 08:00 BST (07:00Z)
  m1('2026-09-29T13:45:00Z', 20_210, 20_150), // after NY cash open 09:30 (13:30Z)
  m1('2026-09-29T14:30:00Z', 20_190, 20_170, { complete: false }), // in progress
];

describe('computeMarketSnapshot', () => {
  it('derives quote figures, market status, day levels and change from real bars', () => {
    const s = computeMarketSnapshot(
      inputs({ bars: { ...noBars(), D1: [monday, tuesday], M1: minutes } }),
    );
    expect(s).toMatchObject({
      symbol: 'NQ',
      asOf: NOW,
      quote: { status: 'OK' },
      mid: 20_150.25,
      spreadTicks: 2,
      market: { open: true, nextClose: '2026-09-29T21:00:00.000Z' },
      today: { open: 20_050, high: 20_200, low: 20_000, close: 20_150 },
      previousDay: { high: 20_100, low: 19_900, close: 20_050 },
      changeFromPrevClosePct: 0.4988, // (20150 − 20050) / 20050 × 100
      quality: { status: 'OK', reason: null, lastJumpAt: null },
    });
    expect(s.activeSessions).toEqual(['london', 'new-york', 'ny-cash']);
    expect(s.barsAvailable).toEqual({ M1: 2, M5: 0, M15: 0, M30: 0, H1: 0, H4: 0, D1: 1 });
  });

  it('computes each active session’s high/low from M1 bars since that session started', () => {
    const s = computeMarketSnapshot(inputs({ bars: { ...noBars(), M1: minutes } }));
    expect(s.sessions).toEqual([
      { id: 'london', high: 20_210, low: 20_100 },
      { id: 'new-york', high: 20_210, low: 20_100 },
      { id: 'ny-cash', high: 20_210, low: 20_150 },
    ]);
  });

  it('omits a session range when observation started after the session began', () => {
    const s = computeMarketSnapshot(
      inputs({ bars: { ...noBars(), M1: minutes }, m1CoverageFrom: '2026-09-29T12:30:00.000Z' }),
    );
    expect(s.sessions).toEqual([{ id: 'ny-cash', high: 20_210, low: 20_150 }]);
    const unknown = computeMarketSnapshot(
      inputs({ bars: { ...noBars(), M1: minutes }, m1CoverageFrom: null }),
    );
    expect(unknown.sessions).toEqual([]);
  });

  it('uses the last complete D1 bar as previous day across a weekend', () => {
    const friday = bar('D1', '2026-10-01T22:00:00Z', '2026-10-02T22:00:00Z', {
      open: 1,
      high: 3,
      low: 1,
      close: 2,
    });
    const s = computeMarketSnapshot(
      inputs({
        now: new Date('2026-10-05T14:00:00Z'), // Monday; no bar yet for today
        quote: quoteAt('2026-10-05T13:59:59.000Z'),
        bars: { ...noBars(), D1: [friday] },
      }),
    );
    expect(s.previousDay).toEqual({ high: 3, low: 1, close: 2 });
    expect(s.today).toBeNull();
    expect(s.changeFromPrevClosePct).toBeNull();
  });

  it('computes ATR(14) for H1 and D1 only with at least 15 complete bars', () => {
    const start = Date.parse('2026-09-28T00:00:00Z');
    const h1 = Array.from({ length: 15 }, (_, i) =>
      bar(
        'H1',
        new Date(start + i * 3_600_000).toISOString(),
        new Date(start + (i + 1) * 3_600_000).toISOString(),
        { open: 100, high: 101, low: 99, close: 100 },
      ),
    );
    const s = computeMarketSnapshot(inputs({ bars: { ...noBars(), H1: h1, D1: [monday] } }));
    expect(s.atr).toEqual({ H1: 2, D1: null });
  });

  it('is null / empty wherever data is missing — never estimated', () => {
    const s = computeMarketSnapshot(
      inputs({
        instrument: undefined,
        quote: notObserved('UNAVAILABLE', 'no quote received for NQ', 'market-data'),
        m1CoverageFrom: null,
      }),
    );
    expect(s).toMatchObject({
      mid: null,
      spreadTicks: null,
      market: null,
      today: null,
      previousDay: null,
      changeFromPrevClosePct: null,
      sessions: [],
      atr: { H1: null, D1: null },
      quality: { status: 'NO_DATA', reason: 'no quote received for NQ' },
    });
    expect(Object.values(s.barsAvailable).every((n) => n === 0)).toBe(true);
  });

  it('uses UTC-midnight trading days when an instrument has no trading hours', () => {
    const utcDay = bar(
      'D1',
      '2026-09-29T00:00:00Z',
      '2026-09-30T00:00:00Z',
      { open: 5, high: 6, low: 4, close: 5 },
      { complete: false },
    );
    const s = computeMarketSnapshot(
      inputs({
        instrument: instrument({ tradingHours: undefined }),
        bars: { ...noBars(), D1: [utcDay] },
      }),
    );
    expect(s.market).toBeNull();
    expect(s.today).toEqual({ open: 5, high: 6, low: 4, close: 5 });
  });

  it('maps quote problems to quality statuses and withholds derived quote figures', () => {
    const stale = computeMarketSnapshot(inputs({ quote: quoteAt('2026-09-29T14:29:50.000Z') }));
    expect(stale).toMatchObject({ mid: null, spreadTicks: null, quality: { status: 'STALE' } });
    expect(stale.quote.status).toBe('STALE');

    const jump = notObserved('INVALID', 'abnormal price jump of 240 ticks', 'feed', {
      sourceKind: 'LIVE',
      asOf: '2026-09-29T14:29:59.000Z',
    });
    const suspect = computeMarketSnapshot(
      inputs({ quote: jump, lastJumpAt: '2026-09-29T14:29:59.000Z' }),
    );
    expect(suspect).toMatchObject({
      mid: null,
      quality: {
        status: 'SUSPECT',
        reason: 'abnormal price jump of 240 ticks',
        lastJumpAt: '2026-09-29T14:29:59.000Z',
      },
    });

    const future = computeMarketSnapshot(inputs({ quote: quoteAt('2026-09-29T14:30:05.000Z') }));
    expect(future.quality.status).toBe('SUSPECT');
  });
});
