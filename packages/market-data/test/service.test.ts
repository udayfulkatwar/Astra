import { ManualClock, type InstrumentSpec } from '@astra/core';
import { describe, expect, it, vi } from 'vitest';
import type { Bar, BarStore } from '../src/bar';
import { MarketDataService, type MarketDataServiceOptions } from '../src/service';
import type { Timeframe } from '../src/timeframe';
import { SESSIONS, instrument, m1 } from './fixtures';

const T0 = '2026-09-28T14:00:00.000Z'; // Monday 10:00 New York

function service(opts: Partial<MarketDataServiceOptions> & { specs?: InstrumentSpec[] } = {}): {
  svc: MarketDataService;
  clock: ManualClock;
  bars: Bar[];
} {
  const clock = new ManualClock(T0);
  const specs = opts.specs ?? [instrument(), instrument({ symbol: 'MNQ', tickValue: 0.5 })];
  const bars: Bar[] = [];
  const svc = new MarketDataService({
    clock,
    instruments: new Map(specs.map((s) => [s.symbol, s])),
    sessions: SESSIONS,
    freshness: { maxAgeMs: 5_000, maxFutureSkewMs: 2_000 },
    onBars: (b) => bars.push(...b),
    ...opts,
  });
  return { svc, clock, bars };
}

const q = (clock: ManualClock, bid: number, extra: Record<string, unknown> = {}) => ({
  symbol: 'NQ',
  bid,
  ask: bid + 0.25,
  asOf: clock.now().toISOString(),
  ...extra,
});

describe('MarketDataService — ingestion', () => {
  it('stores the latest quote per symbol; no quote is UNAVAILABLE, never a default', () => {
    const { svc, clock } = service();
    expect(svc.latest('NQ')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(svc.ingest(q(clock, 20_000), 'feed', 'LIVE')).toMatchObject({ status: 'ACCEPTED' });
    expect(svc.latest('NQ')).toMatchObject({
      status: 'OK',
      source: 'feed',
      sourceKind: 'LIVE',
      value: { bid: 20_000, ask: 20_000.25 },
    });
    expect(svc.all()).toHaveLength(1);
  });

  it('rejects unknown instruments and invalid (crossed / zero) quotes', () => {
    const { svc, clock } = service();
    expect(() => svc.ingest(q(clock, 1, { symbol: 'ES' }), 'feed', 'LIVE')).toThrow(
      /unknown instrument ES/,
    );
    expect(() => svc.ingest({ symbol: 'NQ', bid: 10, ask: 9, asOf: T0 }, 'feed', 'LIVE')).toThrow(
      /crossed/,
    );
    expect(() => svc.ingest({ symbol: 'NQ', bid: 0, ask: 1, asOf: T0 }, 'feed', 'LIVE')).toThrow(
      /invalid quote/,
    );
    expect(svc.stats().rejected).toBe(3);
    expect(svc.latest('NQ').status).toBe('UNAVAILABLE');
  });

  it('maps provider symbols per adapter and refuses the bare symbol from a mapped adapter', () => {
    const { svc, clock } = service({
      specs: [instrument({ providerSymbols: { mt5: 'NQ.cash' } })],
    });
    expect(svc.ingest(q(clock, 20_000, { symbol: 'NQ.cash' }), 'mt5', 'LIVE')).toMatchObject({
      status: 'ACCEPTED',
      symbol: 'NQ',
    });
    expect(svc.latest('NQ')).toMatchObject({ status: 'OK', value: { symbol: 'NQ' } });
    expect(() => svc.ingest(q(clock, 20_000), 'mt5', 'LIVE')).toThrow(/NQ\.cash/);
    // Sources without a mapping use ASTRA symbols.
    expect(svc.ingest(q(clock, 20_000), 'ingest:n8n', 'MANUAL').status).toBe('ACCEPTED');
  });

  it('refuses configuration that maps one provider symbol to two instruments', () => {
    expect(() =>
      service({
        specs: [
          instrument({ providerSymbols: { mt5: 'X' } }),
          instrument({ symbol: 'MNQ', providerSymbols: { mt5: 'X' } }),
        ],
      }),
    ).toThrow(/mapped to both/);
  });

  it('binds each source to one data kind (a SIMULATED source can never become LIVE)', () => {
    const { svc, clock } = service();
    svc.ingest(q(clock, 20_000), 'sim', 'SIMULATED');
    expect(() => svc.ingest(q(clock, 20_000), 'sim', 'LIVE')).toThrow(/SIMULATED/);
  });

  it('ignores quotes older than the latest or dated beyond the clock-skew tolerance', () => {
    const { svc, clock } = service();
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    const older = svc.ingest(
      q(clock, 19_000, { asOf: '2026-09-28T13:59:59.000Z' }),
      'feed',
      'LIVE',
    );
    expect(older).toMatchObject({ status: 'IGNORED', reason: expect.stringMatching(/older/) });
    const future = svc.ingest(
      q(clock, 20_001, { asOf: '2026-09-28T14:00:03.000Z' }),
      'feed',
      'LIVE',
    );
    expect(future).toMatchObject({ status: 'IGNORED', reason: expect.stringMatching(/future/) });
    expect(svc.latest('NQ')).toMatchObject({ value: { bid: 20_000 } });
    expect(svc.stats().ignored).toBe(2);
  });

  it('notifies listeners; a failing listener never breaks ingestion', () => {
    const onListenerError = vi.fn();
    const { svc, clock } = service({ onListenerError });
    const seen: number[] = [];
    svc.onQuote(() => {
      throw new Error('boom');
    });
    const off = svc.onQuote((quote) => seen.push(quote.bid));
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    off();
    svc.ingest(q(clock, 20_001), 'feed', 'LIVE');
    expect(seen).toEqual([20_000]);
    expect(onListenerError).toHaveBeenCalledTimes(2);
  });

  it('gives adapters a sink that never throws and reports rejections', () => {
    const onRejected = vi.fn();
    const { svc, clock } = service({ onRejected });
    const sink = svc.sink({ id: 'broker', kind: 'LIVE' });
    sink(q(clock, 20_000, { symbol: 'NOPE' }));
    sink(q(clock, 20_000));
    expect(onRejected).toHaveBeenCalledWith('broker', expect.stringMatching(/unknown instrument/));
    expect(svc.latest('NQ')).toMatchObject({ status: 'OK', source: 'broker' });
  });

  it('applies freshness at the time of asking', () => {
    const { svc, clock } = service();
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    expect(svc.fresh('NQ').status).toBe('OK');
    clock.advance(5_001);
    expect(svc.fresh('NQ')).toMatchObject({ status: 'STALE' });
    expect(svc.latest('NQ').status).toBe('OK'); // raw; the gate judges freshness itself
  });
});

describe('MarketDataService — data quality (abnormal jumps)', () => {
  it('marks a symbol SUSPECT after an abnormal jump: INVALID during the cooldown, then recovers', () => {
    const { svc, clock } = service();
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    clock.advance(1_000);
    // 60 points = 240 ticks > 200 allowed.
    const r = svc.ingest(q(clock, 20_060), 'feed', 'LIVE');
    expect(r).toMatchObject({ status: 'ACCEPTED', abnormalJump: true });
    const during = svc.latest('NQ');
    expect(during.status).toBe('INVALID');
    expect(during.status !== 'OK' && during.reason).toMatch(
      /^abnormal price jump of 240 ticks \(limit 200\)/,
    );
    expect(svc.quoteQuality('NQ')).toMatchObject({
      suspect: true,
      lastJumpAt: '2026-09-28T14:00:01.000Z',
      lastMoveTicks: 240,
      spreadTicks: 1,
    });
    expect(svc.stats().abnormalJumps).toBe(1);

    // Normal quotes at the new level do not end the cooldown early.
    clock.advance(59_000);
    svc.ingest(q(clock, 20_061), 'feed', 'LIVE');
    expect(svc.latest('NQ').status).toBe('INVALID');
    expect(svc.feedHealth(['NQ']).status).toBe('UNKNOWN');

    clock.advance(1_000); // 60 s after detection
    expect(svc.latest('NQ')).toMatchObject({ status: 'OK', value: { bid: 20_061 } });
    expect(svc.quoteQuality('NQ')).toMatchObject({
      suspect: false,
      reason: null,
      lastJumpAt: '2026-09-28T14:00:01.000Z',
    });
  });

  it('restarts the cooldown on every further abnormal move; the cooldown is configurable', () => {
    const { svc, clock } = service({ suspectCooldownMs: 10_000 });
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    clock.advance(1_000);
    svc.ingest(q(clock, 20_100), 'feed', 'LIVE'); // jump
    clock.advance(8_000);
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE'); // jump back
    clock.advance(8_000);
    expect(svc.latest('NQ').status).toBe('INVALID');
    clock.advance(2_000);
    expect(svc.latest('NQ').status).toBe('OK');
  });

  it('allows moves up to the limit and skips detection when no limit is configured', () => {
    const { svc, clock } = service({
      specs: [instrument(), instrument({ symbol: 'MNQ', maxQuoteJumpTicks: undefined })],
    });
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    svc.ingest(q(clock, 20_050), 'feed', 'LIVE'); // exactly 200 ticks
    expect(svc.latest('NQ').status).toBe('OK');
    svc.ingest(q(clock, 20_000, { symbol: 'MNQ' }), 'feed', 'LIVE');
    svc.ingest(q(clock, 21_000, { symbol: 'MNQ' }), 'feed', 'LIVE');
    expect(svc.latest('MNQ').status).toBe('OK');
    expect(svc.quoteQuality('MNQ').jumpGuard).toBe(false);
  });
});

describe('MarketDataService — bars', () => {
  it('aggregates the price basis (last trade if present, otherwise mid) and emits completed bars', () => {
    const { svc, clock, bars } = service({ timeframes: ['M1'] });
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE'); // mid 20000.125
    clock.advance(10_000);
    svc.ingest(q(clock, 20_001, { last: 20_002 }), 'feed', 'LIVE');
    clock.advance(50_000);
    svc.ingest(q(clock, 20_003), 'feed', 'LIVE'); // 14:01:00 → new bar
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ open: 20_000.125, high: 20_002, close: 20_002, tickCount: 2 });
    expect(svc.bars('NQ', 'M1').map((b) => b.complete)).toEqual([true, false]);
    expect(svc.bars('NQ', 'M1', 1)).toHaveLength(1);
    expect(svc.bars('NQ', 'H1')).toEqual([]); // timeframe not configured
  });

  it('completes bars on advance() after the grace period', () => {
    const { svc, clock, bars } = service({ timeframes: ['M1'], barCloseGraceMs: 1_000 });
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    clock.set('2026-09-28T14:01:00.500Z');
    expect(svc.advance()).toEqual([]);
    clock.set('2026-09-28T14:01:01.000Z');
    expect(svc.advance()).toHaveLength(1);
    expect(bars).toHaveLength(1);
  });

  it('warms up from a bar store, skipping bars that end in the future', async () => {
    const stored = [
      m1('2026-09-28T13:58:00Z', 20_010, 20_000),
      m1('2026-09-28T13:59:00Z', 20_020, 20_005),
      m1('2026-09-28T14:05:00Z', 20_020, 20_005), // ends after "now": never used
    ];
    const store: BarStore = {
      upsert: () => Promise.resolve(),
      recent: (symbol: string, tf: Timeframe) =>
        Promise.resolve(symbol === 'NQ' && tf === 'M1' ? stored : []),
    };
    const { svc, clock } = service();
    expect(await svc.warmUp(store)).toBe(2);
    // No quote yet: the source of the newest bars represents the instrument.
    expect(svc.bars('NQ', 'M1').map((b) => b.openTime)).toEqual([
      '2026-09-28T13:58:00.000Z',
      '2026-09-28T13:59:00.000Z',
    ]);
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    expect(svc.bars('NQ', 'M1')).toHaveLength(3);
  });

  it('reports feed health from per-instrument freshness', () => {
    const { svc, clock } = service();
    expect(svc.feedHealth([]).status).toBe('UNKNOWN');
    expect(svc.feedHealth(['NQ', 'MNQ']).status).toBe('UNKNOWN');
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    const some = svc.feedHealth(['NQ', 'MNQ']);
    expect(some.status).toBe('DEGRADED');
    expect(some.detail).toMatch(/MNQ UNAVAILABLE/);
    svc.ingest(q(clock, 20_000, { symbol: 'MNQ' }), 'feed', 'LIVE');
    expect(svc.feedHealth(['NQ', 'MNQ']).status).toBe('ONLINE');
    clock.advance(6_000);
    expect(svc.feedHealth(['NQ', 'MNQ'])).toMatchObject({
      status: 'UNKNOWN',
      detail: expect.stringMatching(/STALE/),
    });
  });

  it('builds a snapshot per configured instrument', () => {
    const { svc, clock } = service();
    svc.ingest(q(clock, 20_000), 'feed', 'LIVE');
    const snaps = svc.snapshots();
    expect(snaps.map((s) => s.symbol)).toEqual(['NQ', 'MNQ']);
    expect(snaps[0]).toMatchObject({
      mid: 20_000.125,
      spreadTicks: 1,
      quality: { status: 'OK' },
      market: { open: true },
    });
    expect(snaps[1]).toMatchObject({ mid: null, quality: { status: 'NO_DATA' } });
  });
});

describe('MarketDataService — bid/ask-less prices (public streams: charts only, never a quote)', () => {
  const p = (clock: ManualClock, price: number, extra: Record<string, unknown> = {}) => ({
    symbol: 'NQ=F',
    price,
    asOf: clock.now().toISOString(),
    ...extra,
  });
  const yahoo = () => service({ specs: [instrument({ providerSymbols: { yahoo: 'NQ=F' } })] });

  it('builds bars from prices, but the latest QUOTE stays UNAVAILABLE (the gate sees no trade)', () => {
    const { svc, clock, bars } = yahoo();
    for (const [dt, price] of [
      [5_000, 20_000],
      [20_000, 20_004],
      [40_000, 19_998],
      [65_000, 20_001],
    ] as const) {
      clock.set(new Date(Date.parse(T0) + dt));
      expect(svc.ingestPrice(p(clock, price), 'yahoo', 'LIVE')).toMatchObject({
        status: 'ACCEPTED',
        symbol: 'NQ',
      });
    }
    expect(bars).toEqual([
      expect.objectContaining({
        timeframe: 'M1',
        openTime: T0,
        open: 20_000,
        high: 20_004,
        low: 19_998,
        close: 19_998,
        tickCount: 3,
        source: 'yahoo',
        sourceKind: 'LIVE',
      }),
    ]);
    expect(svc.bars('NQ', 'M1').map((b) => b.close)).toEqual([19_998, 20_001]);
    expect(svc.latest('NQ')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(svc.fresh('NQ')).toMatchObject({ status: 'UNAVAILABLE' });
    expect(svc.all()).toEqual([]);
    expect(svc.feedHealth(['NQ']).status).not.toBe('ONLINE');
    expect(svc.snapshot('NQ')).toMatchObject({ mid: null, quality: { status: 'NO_DATA' } });
    expect(svc.lastPrices()).toEqual([
      {
        symbol: 'NQ',
        price: 20_001,
        asOf: new Date(Date.parse(T0) + 65_000).toISOString(),
        source: 'yahoo',
        sourceKind: 'LIVE',
      },
    ]);
  });

  it('same rules as quotes: symbol mapping, validation, source kind, ordering, clock skew', () => {
    const { svc, clock } = yahoo();
    expect(() => svc.ingestPrice(p(clock, 1, { symbol: 'ES=F' }), 'yahoo', 'LIVE')).toThrow(
      /unknown instrument ES=F/,
    );
    expect(() => svc.ingestPrice(p(clock, 0), 'yahoo', 'LIVE')).toThrow(/invalid price/);
    expect(() => svc.ingestPrice(p(clock, 1, { asOf: 'yesterday' }), 'yahoo', 'LIVE')).toThrow(
      /invalid price/,
    );
    clock.advance(10_000);
    svc.ingestPrice(p(clock, 20_000), 'yahoo', 'LIVE');
    expect(() => svc.ingestPrice(p(clock, 20_000), 'yahoo', 'SIMULATED')).toThrow(
      /delivers LIVE data/,
    );
    const earlier = new Date(clock.now().getTime() - 1_000).toISOString();
    expect(svc.ingestPrice(p(clock, 1, { asOf: earlier }), 'yahoo', 'LIVE')).toMatchObject({
      status: 'IGNORED',
      reason: /older than the latest price/,
    });
    const future = new Date(clock.now().getTime() + 60_000).toISOString();
    expect(svc.ingestPrice(p(clock, 1, { asOf: future }), 'yahoo', 'LIVE')).toMatchObject({
      status: 'IGNORED',
      reason: /in the future/,
    });
    expect(svc.stats()).toMatchObject({ rejected: 4, ignored: 2 });
  });

  it('priceSink never throws: rejections are reported', () => {
    const onRejected = vi.fn();
    const { svc, clock } = service({
      onRejected,
      specs: [instrument({ providerSymbols: { yahoo: 'NQ=F' } })],
    });
    const sink = svc.priceSink({ id: 'yahoo', kind: 'LIVE' });
    expect(() => sink(p(clock, 1, { symbol: 'XX' }))).not.toThrow();
    expect(onRejected).toHaveBeenCalledWith('yahoo', expect.stringMatching(/unknown instrument/));
  });

  it("a provider's own history (seedBars) is continued by its stream in one series", () => {
    const { svc, clock } = yahoo();
    const history = [0, 1, 2].map((i) =>
      m1(new Date(Date.parse(T0) - (3 - i) * 60_000).toISOString(), 20_010 + i, 20_000 + i, {
        source: 'yahoo',
        sourceKind: 'LIVE',
        tickCount: 0,
      }),
    );
    const inProgress = { ...history[2]!, openTime: T0, complete: false };
    expect(svc.seedBars([...history, inProgress])).toBe(3);
    expect(svc.bars('NQ', 'M1').map((b) => b.openTime)).toEqual(history.map((b) => b.openTime));
    clock.advance(5_000);
    svc.ingestPrice(p(clock, 20_020), 'yahoo', 'LIVE');
    expect(svc.bars('NQ', 'M1').map((b) => [b.openTime, b.complete])).toEqual([
      ...history.map((b) => [b.openTime, true]),
      [T0, false],
    ]);
  });
});
