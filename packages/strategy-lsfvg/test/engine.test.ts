import { describe, expect, it } from 'vitest';
import {
  Aggregator,
  LsfvgEngine,
  RECORD_FIELDS,
  SwingDetector,
  assessBias,
  decisionRecord,
  renderRecord,
  toSignal,
  type Candle,
  type LsfvgEvent,
  type LsfvgParamsInput,
  type LsfvgSetup,
} from '../src';
import { HOUR, M15, h1Path, split, type Ohlc } from './helpers';

const START = Date.parse('2026-03-03T00:00:00Z'); // Tuesday; FX day ends 22:00 UTC (EST)

/** A bullish H1 trend: L 1.0893 → H 1.0987 → HL 1.0933 → HH 1.1057, then a pullback to 1.1010. */
const H1_BULL = h1Path([
  [0, 1.095],
  [4, 1.09],
  [9, 1.098],
  [14, 1.094],
  [19, 1.105],
  [24, 1.101],
]);

/**
 * M15, from 1.1010: a swing low 1.0990 (candle 3), a swing high 1.1020 (candle 7), a sweep of
 * 1.0990 to 1.0985 closing back above (candle 10), a displacement closing at 1.1028 above
 * 1.1020 (candle 11) and a gap 1.1000–1.1012 left open by candle 12.
 */
const SETUP_M15: Ohlc[] = [
  { o: 1.101, h: 1.1014, l: 1.1006, c: 1.1008 },
  { o: 1.1008, h: 1.101, l: 1.1, c: 1.1002 },
  { o: 1.1002, h: 1.1004, l: 1.099, c: 1.0994 },
  { o: 1.0994, h: 1.1003, l: 1.0993, c: 1.1001 },
  { o: 1.1001, h: 1.1008, l: 1.0998, c: 1.1006 },
  { o: 1.1006, h: 1.1016, l: 1.1004, c: 1.1012 },
  { o: 1.1012, h: 1.102, l: 1.1009, c: 1.1011 },
  { o: 1.1011, h: 1.1013, l: 1.1003, c: 1.1004 },
  { o: 1.1004, h: 1.1006, l: 1.0996, c: 1.0998 },
  { o: 1.0998, h: 1.1, l: 1.0985, c: 1.0995 },
  { o: 1.0995, h: 1.103, l: 1.0993, c: 1.1028 },
  { o: 1.1028, h: 1.1035, l: 1.1012, c: 1.103 },
];

function candles(h1: Ohlc[], m15: Ohlc[], after: Ohlc[] = []): Candle[] {
  const out: Candle[] = [];
  let t = START;
  for (const x of h1) {
    out.push(...split(t, x, 12));
    t += HOUR;
  }
  for (const x of [...m15, ...after]) {
    out.push(...split(t, x, 3));
    t += M15;
  }
  return out;
}

function run(input: Candle[], params: LsfvgParamsInput = { model: 'A' }) {
  const engine = new LsfvgEngine('EURUSD', 0.00001, params);
  const events: LsfvgEvent[] = [];
  for (const c of input) events.push(...engine.onM5(c));
  return { engine, events };
}

const setups = (events: LsfvgEvent[]): LsfvgSetup[] =>
  events.flatMap((e) => (e.kind === 'SETUP' ? [e.setup] : []));

/** Mirror image around 1.1 (prices p → 2.2 − p): a bearish world. */
const mirror = (x: Ohlc): Ohlc => {
  const m = (p: number) => Math.round((2.2 - p) * 1e5) / 1e5;
  return { o: m(x.o), h: m(x.l), l: m(x.h), c: m(x.c) };
};

describe('LSFVG v1.0 — the complete LONG sequence', () => {
  it('finds the setup the candles were built for, with the SPEC’s entry, stop and 2R target', () => {
    const { events, engine } = run(candles(H1_BULL, SETUP_M15));
    const [s] = setups(events);
    expect(setups(events)).toHaveLength(1);
    expect(s).toMatchObject({
      direction: 'LONG',
      detectedAt: '2026-03-04T03:00:00.000Z',
      expiresAt: '2026-03-04T04:00:00.000Z', // 12 M5 candles
      h1Bias: { bias: 'BULLISH' },
      liquidity: { name: 'SWING_LOW', price: 1.099, strong: false },
      sweep: { extreme: 1.0985, candleTime: '2026-03-04T02:15:00.000Z' },
      structure: { kind: 'BOS', swingPrice: 1.102, brokenAt: '2026-03-04T02:45:00.000Z' },
      fvg: { low: 1.1, high: 1.1012 },
      entry: 1.1006, // the FVG midpoint
      targetSource: 'FIXED_2R',
      rewardToRisk: 2,
    });
    // Stop = sweep low − 0.10 × M5 ATR, rounded away from the entry.
    expect(s!.stop).toBe(Math.floor((1.0985 - 0.1 * s!.atrM5) * 1e5) / 1e5);
    expect(s!.target).toBeCloseTo(1.1006 + 2 * (1.1006 - s!.stop), 5);
    // Displacement: body ≥ 0.60 × range and ≥ 0.80 × M15 ATR.
    expect(s!.displacement.bodyToRange).toBeGreaterThanOrEqual(0.6);
    expect(s!.displacement.bodyToAtr).toBeGreaterThanOrEqual(0.8);
    // Score: everything but strong liquidity and the (pending) retrace.
    expect(s!.score).toMatchObject({ total: 14, max: 18, retracePending: true });
    expect(engine.counters).toMatchObject({ reclaims: 1, displacements: 1, fvgs: 1, setups: 1 });
  });

  it('Model B targets the nearest opposing liquidity giving ≥ 2R (here the previous day’s high)', () => {
    const [s] = setups(run(candles(H1_BULL, SETUP_M15), { model: 'B' }).events);
    expect(s).toMatchObject({ target: 1.1057, targetSource: 'PDH 1.1057', rewardToRisk: 2.33 });
    // The stricter reading (nearest level only) finds it too close: no trade.
    const strict = run(candles(H1_BULL, SETUP_M15), { model: 'B', modelBTarget: 'NEAREST_ONLY' });
    expect(setups(strict.events)).toEqual([]);
    expect(strict.events[0]).toMatchObject({
      kind: 'REJECTED',
      rejection: { stage: 'REWARD_TO_RISK' },
    });
  });

  it('is invalidated when an M5 candle closes below the sweep low before the entry window ends', () => {
    const crash: Ohlc = { o: 1.103, h: 1.1031, l: 1.098, c: 1.0982 };
    const { events } = run(candles(H1_BULL, SETUP_M15, [crash]));
    const inv = events.find((e) => e.kind === 'INVALIDATED');
    expect(inv).toMatchObject({ setupId: 'EURUSD-LONG-2026-03-04T03:00:00.000Z' });
  });
});

describe('LSFVG v1.0 — every step is required', () => {
  const variant = (k: number, x: Ohlc) => SETUP_M15.map((c, i) => (i === k ? x : c));

  it('no trade when the H1 bias is not bullish', () => {
    const flat = h1Path([
      [0, 1.1],
      [6, 1.102],
      [12, 1.099],
      [18, 1.103],
      [24, 1.101],
    ]);
    const { events, engine } = run(candles(flat, SETUP_M15));
    expect(setups(events)).toEqual([]);
    expect(engine.counters.rejectedBias).toBeGreaterThanOrEqual(1);
    // The designed sequence is complete but refused on bias (the flat path makes others too).
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'REJECTED',
        rejection: expect.objectContaining({ stage: 'BIAS', at: '2026-03-04T03:00:00.000Z' }),
      }),
    );
  });

  it('no trade without a close back above the swept level', () => {
    // The sweep candle and the next two all close below 1.0990.
    const m15 = [
      ...SETUP_M15.slice(0, 9),
      { o: 1.0998, h: 1.1, l: 1.0985, c: 1.0987 },
      { o: 1.0987, h: 1.0989, l: 1.0986, c: 1.0988 },
      { o: 1.0988, h: 1.0989, l: 1.0986, c: 1.0987 },
      { o: 1.0987, h: 1.103, l: 1.0986, c: 1.1028 },
      { o: 1.1028, h: 1.1035, l: 1.1012, c: 1.103 },
    ];
    const { events, engine } = run(candles(H1_BULL, m15));
    expect(setups(events)).toEqual([]);
    expect(engine.counters.reclaims).toBe(0);
  });

  it('no trade when the displacement does not CLOSE beyond the swing high (a wick is not a break)', () => {
    const m15 = variant(10, { o: 1.0995, h: 1.1025, l: 1.0993, c: 1.1019 });
    const { events, engine } = run(candles(H1_BULL, m15));
    expect(setups(events)).toEqual([]);
    expect(engine.counters.displacements).toBe(0);
  });

  it('no trade when the break is not a displacement (body too small against its range)', () => {
    const m15 = variant(10, { o: 1.0995, h: 1.1045, l: 1.0993, c: 1.1021 });
    expect(setups(run(candles(H1_BULL, m15)).events)).toEqual([]);
  });

  it('no trade when the third candle fills the gap (no FVG)', () => {
    const m15 = variant(11, { o: 1.1028, h: 1.1035, l: 1.0999, c: 1.103 });
    const { events, engine } = run(candles(H1_BULL, m15));
    expect(setups(events)).toEqual([]);
    expect(engine.counters.noFvg).toBe(1);
  });
});

describe('LSFVG v1.0 — SHORT is the exact mirror image', () => {
  it('mirrors entry, stop and target (stop rounded away from the entry)', () => {
    const long = setups(run(candles(H1_BULL, SETUP_M15)).events)[0]!;
    const { events } = run(candles(H1_BULL.map(mirror), SETUP_M15.map(mirror)));
    const [s] = setups(events);
    const m = (p: number) => Math.round((2.2 - p) * 1e5) / 1e5;
    expect(s).toMatchObject({
      direction: 'SHORT',
      h1Bias: { bias: 'BEARISH' },
      liquidity: { name: 'SWING_HIGH', price: m(1.099) },
      entry: m(long.entry),
      stop: m(long.stop),
      target: m(long.target),
    });
  });
});

describe('LSFVG v1.0 — no lookahead', () => {
  it('events up to any time are identical whether or not later candles exist', () => {
    const all = candles(H1_BULL, SETUP_M15, [{ o: 1.103, h: 1.1031, l: 1.098, c: 1.0982 }]);
    const full = run(all).events;
    const at = (e: LsfvgEvent) =>
      e.kind === 'SETUP' ? e.setup.detectedAt : e.kind === 'REJECTED' ? e.rejection.at : e.at;
    for (const cut of [all.length - 1, all.length - 4, all.length - 10, all.length - 20]) {
      const prefix = all.slice(0, cut);
      const until = Date.parse(prefix.at(-1)!.closeTime);
      expect(run(prefix).events).toEqual(full.filter((e) => Date.parse(at(e)) <= until));
    }
  });

  it('refuses candles out of order or of the wrong timeframe', () => {
    const e = new LsfvgEngine('EURUSD', 0.00001, { model: 'A' });
    const [a, b] = split(START, { o: 1.1, h: 1.1001, l: 1.0999, c: 1.1 }, 3);
    e.onM5(b!);
    expect(() => e.onM5(a!)).toThrow('out of order');
    expect(() =>
      e.onM5({
        ...b!,
        openTime: '2026-03-03T01:00:00.000Z',
        closeTime: '2026-03-03T01:15:00.000Z',
      }),
    ).toThrow('not an M5 candle');
  });
});

describe('building blocks', () => {
  it('swings are strict 5-candle fractals, known only after two right candles close', () => {
    const d = new SwingDetector();
    const c = (h: number, l: number, i: number): Candle => ({
      openTime: new Date(START + i * M15).toISOString(),
      closeTime: new Date(START + (i + 1) * M15).toISOString(),
      open: l,
      high: h,
      low: l,
      close: h,
    });
    const highs = [1, 2, 3, 2, 3].map((h, i) => d.push(c(h, 0.5, i)));
    expect(highs.flat()).toEqual([]); // 3 then 3 again: not strictly higher than its neighbour
    const d2 = new SwingDetector();
    const out = [1, 2, 5, 2, 1].map((h, i) => d2.push(c(h, 0.5, i)));
    expect(out.slice(0, 4).flat()).toEqual([]);
    expect(out[4]).toEqual([
      { kind: 'HIGH', price: 5, time: c(5, 0.5, 2).openTime, confirmedAt: c(1, 0.5, 4).closeTime },
    ]);
  });

  it('aggregation emits a period when it closes, or when a gap shows it ended', () => {
    const agg = new Aggregator(M15);
    const m5 = split(START, { o: 1, h: 1.2, l: 0.9, c: 1.1 }, 3);
    expect(agg.push(m5[0]!)).toEqual([]);
    expect(agg.push(m5[1]!)).toEqual([]);
    expect(agg.push(m5[2]!)).toEqual([
      {
        openTime: m5[0]!.openTime,
        closeTime: m5[2]!.closeTime,
        open: 1,
        high: 1.2,
        low: 0.9,
        close: 1.1,
      },
    ]);
    // A period missing its last M5 candle is emitted when a later period starts.
    const gap = split(START + M15, { o: 1, h: 1.2, l: 0.9, c: 1.1 }, 3);
    expect(agg.push(gap[0]!)).toEqual([]);
    const later = split(START + 3 * M15, { o: 1, h: 1.1, l: 1, c: 1.05 }, 3);
    expect(agg.push(later[0]!)).toHaveLength(1);
  });

  it('bias is NEUTRAL until the structure is clear', () => {
    expect(assessBias([], [], 1.1).bias).toBe('NEUTRAL');
    expect(assessBias([], [], null).bias).toBe('NEUTRAL');
  });
});

describe('§26 decision record and the ASTRA signal', () => {
  it('fills every §26 field; gate-dependent fields say when no gate has decided', () => {
    const [s] = setups(run(candles(H1_BULL, SETUP_M15)).events);
    const pending = decisionRecord({ setup: s! });
    expect(Object.keys(pending)).toEqual([...RECORD_FIELDS]);
    expect(pending).toMatchObject({
      PAIR: 'EURUSD',
      DIRECTION: 'LONG',
      'LIQUIDITY TYPE': 'SWING_LOW',
      'CHoCH/BOS': 'BOS through 1.102',
      'FVG RANGE': '1.1 – 1.1012',
      DECISION: 'PENDING GATE',
      'RISK %': 'not evaluated (no gate decision)',
    });
    const traded = decisionRecord(
      { setup: s! },
      {
        status: 'APPROVED',
        reasons: [],
        riskPercent: 0.25,
        newsFilter: 'PASS',
        correlation: 'PASS',
      },
    );
    expect(traded).toMatchObject({ DECISION: 'TRADE', 'RISK %': '0.25%', 'REJECTION REASON': '' });
    expect(renderRecord(traded).split('\n')).toHaveLength(RECORD_FIELDS.length);
  });

  it('a rejected sequence is a REJECT record with its reason', () => {
    const flat = h1Path([
      [0, 1.1],
      [6, 1.102],
      [12, 1.099],
      [18, 1.103],
      [24, 1.101],
    ]);
    const rej = run(candles(flat, SETUP_M15)).events.find((e) => e.kind === 'REJECTED');
    if (rej?.kind !== 'REJECTED') throw new Error('expected a rejection');
    expect(decisionRecord({ rejection: rej.rejection })).toMatchObject({
      DECISION: 'REJECT',
      'REJECTION REASON': expect.stringMatching(/^BIAS: H1 bias/),
    });
  });

  it('becomes a LIMIT signal expiring with the entry window', () => {
    const [s] = setups(run(candles(H1_BULL, SETUP_M15)).events);
    expect(toSignal(s!, 'lsfvg-a')).toMatchObject({
      id: `lsfvg-a:${s!.id}`,
      entryType: 'LIMIT',
      entry: 1.1006,
      expiresAt: '2026-03-04T04:00:00.000Z',
      setupState: 'QUALIFIED',
    });
  });
});
