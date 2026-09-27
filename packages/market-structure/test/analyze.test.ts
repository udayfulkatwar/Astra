import type { Bar } from '@astra/market-data';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyzeStructure, type MarketStructure } from '../src/analyze';
import { DEFAULT_STRUCTURE_PARAMS } from '../src/params';

type OHLC = readonly [number, number, number, number];
const START = Date.parse('2026-09-28T13:00:00Z');
const M5 = 5 * 60_000;
const iso = (t: number) => new Date(t).toISOString();

function series(rows: readonly OHLC[], extra: Partial<Bar> = {}): Bar[] {
  return rows.map(([open, high, low, close], i) => ({
    symbol: 'NQ',
    timeframe: 'M5',
    openTime: iso(START + i * M5),
    closeTime: iso(START + (i + 1) * M5),
    open,
    high,
    low,
    close,
    volume: null,
    tickCount: 10,
    complete: true,
    source: 'feed',
    sourceKind: 'LIVE',
    ...extra,
  }));
}

/** Close time of bar `i` in `series`. */
const closeOf = (i: number) => iso(START + (i + 1) * M5);
const openOf = (i: number) => iso(START + i * M5);

const analyze = (rows: readonly OHLC[], params = {}) =>
  analyzeStructure({ bars: series(rows), tickSize: 0.25, params: { swingStrength: 1, ...params } });

describe('swings', () => {
  it('confirms a swing only when the bars after it have closed (no lookahead)', () => {
    const rows: OHLC[] = [
      [10, 11, 9, 10],
      [10, 11.5, 9.5, 11],
      [11, 15, 10.5, 14], // candidate swing high
      [14, 14.5, 12, 12.5],
    ];
    // Strength 2: the high at bar 2 needs bars 3 AND 4.
    expect(analyze(rows, { swingStrength: 2 }).swings).toEqual([]);
    const s = analyze([...rows, [12.5, 13, 11.5, 12]], { swingStrength: 2 });
    expect(s.swings).toEqual([
      {
        kind: 'HIGH',
        price: 15,
        time: openOf(2),
        confirmedAt: closeOf(4),
        label: null,
        status: 'INTACT',
        resolvedAt: null,
      },
    ]);
  });

  it('takes the first of equal adjacent highs as the swing', () => {
    const s = analyze([
      [10, 11, 9, 10],
      [10, 13, 10, 12],
      [12, 13, 11, 11.5],
      [11.5, 12, 11, 11.25],
    ]);
    expect(s.swings.filter((x) => x.kind === 'HIGH').map((x) => x.time)).toEqual([openOf(1)]);
  });

  it('reports insufficient data instead of a trend with too few bars', () => {
    const s = analyzeStructure({
      bars: series([
        [10, 11, 9, 10],
        [10, 12, 9.5, 11],
      ]),
      tickSize: 0.25,
    });
    expect(s).toMatchObject({ sufficient: false, trend: 'UNKNOWN', swings: [], breaks: [] });
    expect(s.params).toEqual(DEFAULT_STRUCTURE_PARAMS);
    // Without bars the result still names its series.
    expect(
      analyzeStructure({ bars: [], tickSize: 0.25, symbol: 'NQ', timeframe: 'H1' }),
    ).toMatchObject({
      symbol: 'NQ',
      timeframe: 'H1',
      asOf: null,
      barsAnalysed: 0,
      lastClose: null,
      nearestAbove: null,
    });
  });
});

describe('breaks of structure', () => {
  // prettier-ignore
  const rows: OHLC[] = [
    [10, 11, 9, 10],
    [10, 13, 10, 12],          // swing high 13 (confirmed by bar 2)
    [12, 12.5, 11, 11.5],
    [11.5, 12, 10.5, 11],      // swing low 10.5 (confirmed by bar 4)
    [11, 14, 11, 13.75],       // closes above 13 → BOS (sets the trend)
    [13.75, 15, 13, 14.5],     // swing high 15 = HH (confirmed by bar 6)
    [14.5, 14.75, 12, 12.5],
    [12.5, 13, 10, 10.25],     // closes below 10.5 in an uptrend → CHoCH
    [10.25, 11, 9.5, 10.75],
  ];

  it('labels the first break BOS and a break against the trend CHoCH', () => {
    const s = analyze(rows);
    expect(s.breaks).toEqual([
      {
        type: 'BOS',
        direction: 'BULLISH',
        level: 13,
        swingTime: openOf(1),
        at: closeOf(4),
        close: 13.75,
        from: 'UNKNOWN',
      },
      {
        type: 'CHOCH',
        direction: 'BEARISH',
        level: 10.5,
        swingTime: openOf(3),
        at: closeOf(7),
        close: 10.25,
        from: 'UP',
      },
    ]);
    expect(s.trend).toBe('DOWN');
    expect(s.lastBreak).toEqual(s.breaks[1]);
    expect(s.swings.map((x) => [x.kind, x.price, x.label, x.status, x.resolvedAt])).toEqual([
      ['HIGH', 13, null, 'BROKEN', closeOf(4)],
      ['LOW', 10.5, null, 'BROKEN', closeOf(7)],
      ['HIGH', 15, 'HH', 'INTACT', null],
    ]);
    expect(s.lastSwingHigh?.price).toBe(15);
    expect(s.nearestAbove).toEqual({
      side: 'BUY_SIDE',
      level: 15,
      kind: 'SWING',
      swingTime: openOf(5),
    });
  });

  it('needs a CLOSE beyond the level: a wick through is a sweep, not a break', () => {
    // prettier-ignore
    const s = analyze([
      [10, 11, 9, 10],
      [10, 13, 10, 12],               // swing high 13
      [12, 12.5, 11, 11.5],
      [11.5, 13.5, 11.25, 12.75],     // wick to 13.5, close 12.75 → sweep of 13
      [12.75, 13.25, 12.5, 13.1],     // close above 13 → BOS; 13.5 becomes the next swing high
    ]);
    expect(s.sweeps).toEqual([
      {
        side: 'BUY_SIDE',
        level: 13,
        swingTime: openOf(1),
        at: closeOf(3),
        extreme: 13.5,
        close: 12.75,
      },
    ]);
    expect(s.breaks.map((b) => [b.type, b.direction, b.level, b.at])).toEqual([
      ['BOS', 'BULLISH', 13, closeOf(4)],
    ]);
    expect(s.swings.map((x) => [x.price, x.label, x.status])).toEqual([
      [13, null, 'SWEPT'],
      [13.5, 'EQH', 'INTACT'], // 2 ticks above 13: within the default equal-level tolerance
    ]);
  });

  it('ignores the in-progress bar (nothing repaints)', () => {
    const bars = series(rows.slice(0, 4));
    const live: Bar = {
      ...series([[11, 14, 11, 13.75]])[0]!,
      openTime: closeOf(3),
      closeTime: closeOf(4),
      complete: false,
    };
    const s = analyzeStructure({
      bars: [...bars, live],
      tickSize: 0.25,
      params: { swingStrength: 1 },
    });
    expect(s.breaks).toEqual([]);
    expect(s.barsAnalysed).toBe(4);
    expect(s.asOf).toBe(closeOf(3));
  });
});

describe('liquidity', () => {
  // prettier-ignore
  const rows: OHLC[] = [
    [10, 11, 9, 10],
    [10, 13, 10, 12],        // swing high 13
    [12, 12.5, 11, 11.5],
    [11.5, 12, 10.5, 11],    // swing low 10.5
    [11, 12.75, 11, 12.5],   // swing high 12.75: within 2 ticks of 13 → EQH
    [12.5, 12.5, 11.5, 12],
  ];

  it('groups intact equal highs into a buy-side pool and points at the nearest liquidity', () => {
    const s = analyze(rows);
    expect(s.swings.map((x) => [x.kind, x.price, x.label])).toEqual([
      ['HIGH', 13, null],
      ['LOW', 10.5, null],
      ['HIGH', 12.75, 'EQH'],
    ]);
    expect(s.equalTolerance).toBe(0.5);
    expect(s.pools).toEqual([{ side: 'BUY_SIDE', level: 13, swingTimes: [openOf(1), openOf(4)] }]);
    expect(s.nearestAbove).toEqual({
      side: 'BUY_SIDE',
      level: 12.75,
      kind: 'EQUAL_LEVELS',
      swingTime: openOf(4),
    });
    expect(s.nearestBelow).toEqual({
      side: 'SELL_SIDE',
      level: 10.5,
      kind: 'SWING',
      swingTime: openOf(3),
    });
  });

  it('a tighter tolerance keeps them apart', () => {
    const s = analyze(rows, { equalLevelTicks: 0.5 });
    expect(s.swings[2]!.label).toBe('LH');
    expect(s.pools).toEqual([]);
    expect(s.nearestAbove?.kind).toBe('SWING');
  });
});

describe('fair value gaps', () => {
  // prettier-ignore
  const rows: OHLC[] = [
    [10, 10.5, 9.5, 10.25],
    [10.25, 12, 10.25, 11.75],
    [11.75, 12.5, 11, 12.25],   // low 11 > first high 10.5 → bullish gap 10.5–11
    [12.25, 12.5, 10.75, 11.5], // trades into it → PARTIAL
    [11.5, 11.75, 10.25, 10.5], // through the bottom → FILLED
  ];

  it('detects, mitigates and fills a bullish gap', () => {
    expect(analyze(rows.slice(0, 3)).fvgs).toEqual([
      {
        direction: 'BULLISH',
        bottom: 10.5,
        top: 11,
        at: closeOf(2),
        status: 'OPEN',
        mitigatedTo: null,
        filledAt: null,
      },
    ]);
    expect(analyze(rows.slice(0, 4)).fvgs).toMatchObject([
      { status: 'PARTIAL', mitigatedTo: 10.75 },
    ]);
    expect(analyze(rows).fvgs).toEqual([]);
  });

  it('detects a bearish gap and honours the minimum size', () => {
    // prettier-ignore
    const bearish: OHLC[] = [
      [12, 12.5, 11.5, 11.75],
      [11.75, 11.75, 10, 10.25],
      [10.25, 11, 9.5, 9.75],     // high 11 < first low 11.5 → bearish gap 11–11.5
    ];
    expect(analyze(bearish).fvgs).toMatchObject([{ direction: 'BEARISH', bottom: 11, top: 11.5 }]);
    expect(analyze(bearish, { fvgMinTicks: 3 }).fvgs).toEqual([]);
  });

  it('measures gaps in ticks without floating-point noise (0.01 ticks)', () => {
    const s = analyzeStructure({
      bars: series([
        [2600, 2600.1, 2599.9, 2600.05],
        [2600.05, 2600.3, 2600.05, 2600.25],
        [2600.25, 2600.4, 2600.11, 2600.3], // gap 2600.10 → 2600.11: exactly 1 tick
      ]),
      tickSize: 0.01,
    });
    expect(s.fvgs).toHaveLength(1);
  });
});

describe('validation', () => {
  it('refuses mixed series and overlapping bars', () => {
    const bars = series([
      [10, 11, 9, 10],
      [10, 12, 9.5, 11],
    ]);
    expect(() =>
      analyzeStructure({ bars: [bars[0]!, { ...bars[1]!, symbol: 'MNQ' }], tickSize: 0.25 }),
    ).toThrow(/one symbol and timeframe/);
    expect(() => analyzeStructure({ bars: [bars[1]!, bars[0]!], tickSize: 0.25 })).toThrow(
      /ordered and non-overlapping/,
    );
    expect(() => analyzeStructure({ bars, tickSize: 0.25, symbol: 'MNQ' })).toThrow(
      /does not belong to MNQ M5/,
    );
    expect(() => analyzeStructure({ bars, tickSize: 0.25, timeframe: 'H1' })).toThrow(
      /does not belong to NQ H1/,
    );
    expect(() => analyzeStructure({ bars, tickSize: 0 })).toThrow(/tickSize/);
    expect(() =>
      analyzeStructure({ bars, tickSize: 0.25, params: { swingStrength: 0 } }),
    ).toThrow();
  });
});

describe('no lookahead (property)', () => {
  const walk = fc.array(
    fc.tuple(
      fc.integer({ min: -8, max: 8 }),
      fc.integer({ min: 0, max: 6 }),
      fc.integer({ min: 0, max: 6 }),
    ),
    { minLength: 1, maxLength: 160 },
  );

  function toRows(steps: [number, number, number][]): OHLC[] {
    let close = 100;
    return steps.map(([d, up, down]) => {
      const open = close;
      close = open + d * 0.25;
      return [
        open,
        Math.max(open, close) + up * 0.25,
        Math.min(open, close) - down * 0.25,
        close,
      ] as const;
    });
  }

  const eventsUpTo = (s: MarketStructure, end: string) => ({
    swings: s.swings
      .filter((x) => x.confirmedAt <= end)
      .map(({ kind, price, time, confirmedAt, label }) => ({
        kind,
        price,
        time,
        confirmedAt,
        label,
      })),
    breaks: s.breaks.filter((b) => b.at <= end),
    sweeps: s.sweeps.filter((x) => x.at <= end),
  });

  it('analysing a prefix reports exactly the full analysis events up to that prefix', () => {
    fc.assert(
      fc.property(walk, fc.nat(), fc.integer({ min: 1, max: 3 }), (steps, cut, strength) => {
        const rows = toRows(steps);
        const k = 1 + (cut % rows.length);
        const params = { swingStrength: strength, maxItems: 200 };
        const full = analyzeStructure({ bars: series(rows), tickSize: 0.25, params });
        const prefix = analyzeStructure({ bars: series(rows.slice(0, k)), tickSize: 0.25, params });
        expect(eventsUpTo(prefix, closeOf(k - 1))).toEqual(eventsUpTo(full, closeOf(k - 1)));
        // Every CHoCH reverses the trend it came from; the first break is a BOS.
        for (const b of full.breaks) {
          if (b.type === 'CHOCH') expect(b.from).toBe(b.direction === 'BULLISH' ? 'DOWN' : 'UP');
        }
        if (full.breaks.length > 0) expect(full.breaks[0]!.from).toBe('UNKNOWN');
      }),
      { numRuns: 400 },
    );
  });
});
