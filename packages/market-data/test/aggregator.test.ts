import { describe, expect, it } from 'vitest';
import { BarAggregator, type BarAggregatorOptions, type PriceTick } from '../src/aggregator';
import type { Bar } from '../src/bar';
import { GLOBEX, bar, m1, ms } from './fixtures';

function agg(opts: Partial<BarAggregatorOptions> = {}) {
  const emitted: Bar[] = [];
  const a = new BarAggregator({
    tradingHours: () => GLOBEX,
    timeframes: ['M1'],
    onBar: (b) => emitted.push(b),
    ...opts,
  });
  return { a, emitted };
}

const tick = (at: string, price: number, extra: Partial<PriceTick> = {}): PriceTick => ({
  symbol: 'NQ',
  price,
  atMs: ms(at),
  source: 'feed',
  sourceKind: 'LIVE',
  ...extra,
});

describe('BarAggregator — rollover', () => {
  it('builds OHLC from prices and completes the bar when time passes its end', () => {
    const { a, emitted } = agg();
    a.ingest(tick('2026-09-28T14:00:10Z', 100));
    a.ingest(tick('2026-09-28T14:00:30Z', 102));
    a.ingest(tick('2026-09-28T14:00:50Z', 99));
    const r = a.ingest(tick('2026-09-28T14:01:05Z', 101));
    const done = {
      symbol: 'NQ',
      timeframe: 'M1',
      openTime: '2026-09-28T14:00:00.000Z',
      closeTime: '2026-09-28T14:01:00.000Z',
      open: 100,
      high: 102,
      low: 99,
      close: 99,
      volume: null,
      tickCount: 3,
      complete: true,
      source: 'feed',
      sourceKind: 'LIVE',
    };
    expect(r).toEqual({ accepted: true, completed: [done] });
    expect(emitted).toEqual([done]);
    const bars = a.bars('NQ', 'feed', 'M1', { includeCurrent: true });
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({ openTime: '2026-09-28T14:01:00.000Z', open: 101 });
    expect(bars[1]!.complete).toBe(false);
    expect(a.bars('NQ', 'feed', 'M1')).toEqual([done]); // completed only by default
  });

  it('rolls every configured timeframe independently, including D1 at 18:00 New York', () => {
    const { a } = agg({ timeframes: ['M1', 'H1', 'D1'] });
    a.ingest(tick('2026-09-28T20:59:00Z', 100)); // Mon 16:59 EDT
    const r = a.ingest(tick('2026-09-28T22:00:01Z', 105)); // Mon 18:00:01 EDT → new trading day
    if (!r.accepted) throw new Error('expected acceptance');
    expect(r.completed.map((b) => [b.timeframe, b.openTime, b.closeTime])).toEqual([
      ['M1', '2026-09-28T20:59:00.000Z', '2026-09-28T21:00:00.000Z'],
      ['H1', '2026-09-28T20:00:00.000Z', '2026-09-28T21:00:00.000Z'],
      ['D1', '2026-09-27T22:00:00.000Z', '2026-09-28T22:00:00.000Z'],
    ]);
    expect(a.bars('NQ', 'feed', 'D1', { includeCurrent: true }).at(-1)).toMatchObject({
      openTime: '2026-09-28T22:00:00.000Z',
      closeTime: '2026-09-29T22:00:00.000Z',
      complete: false,
    });
  });

  it('a price at the exact period end opens the next bar, including a 25 h D1 on the DST change', () => {
    const { a } = agg({ timeframes: ['M1', 'D1'] });
    a.ingest(tick('2026-11-01T22:58:30Z', 100)); // Sun 17:58:30 EST, day opened Sat 18:00 EDT
    a.ingest(tick('2026-11-01T22:59:59.999Z', 101)); // same bars (in-period fast path)
    const r = a.ingest(tick('2026-11-01T23:00:00Z', 102)); // Sun 18:00 EST → next trading day
    if (!r.accepted) throw new Error('expected acceptance');
    expect(r.completed.map((b) => [b.timeframe, b.openTime, b.closeTime, b.close])).toEqual([
      ['M1', '2026-11-01T22:59:00.000Z', '2026-11-01T23:00:00.000Z', 101],
      ['D1', '2026-10-31T22:00:00.000Z', '2026-11-01T23:00:00.000Z', 101],
    ]);
    expect(a.bars('NQ', 'feed', 'D1', { includeCurrent: true }).at(-1)).toMatchObject({
      openTime: '2026-11-01T23:00:00.000Z',
      closeTime: '2026-11-02T23:00:00.000Z',
      open: 102,
      complete: false,
    });
  });

  it('never fills gaps: periods without prices have no bar', () => {
    const { a } = agg({ timeframes: ['M1', 'M5'] });
    a.ingest(tick('2026-09-28T14:00:10Z', 100));
    a.ingest(tick('2026-09-28T14:07:10Z', 110));
    const m1 = a.bars('NQ', 'feed', 'M1', { includeCurrent: true }).map((b) => b.openTime);
    expect(m1).toEqual(['2026-09-28T14:00:00.000Z', '2026-09-28T14:07:00.000Z']);
    const m5 = a.bars('NQ', 'feed', 'M5', { includeCurrent: true });
    expect(m5.map((b) => [b.openTime, b.open, b.close])).toEqual([
      ['2026-09-28T14:00:00.000Z', 100, 100],
      ['2026-09-28T14:05:00.000Z', 110, 110],
    ]);
  });

  it('completes bars on advance() when no newer price arrives, honouring the grace period', () => {
    const { a, emitted } = agg();
    a.ingest(tick('2026-09-28T14:00:10Z', 100));
    expect(a.advance(ms('2026-09-28T14:01:01Z'), 2_000)).toEqual([]);
    expect(a.advance(ms('2026-09-28T14:01:02Z'), 2_000)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect(a.bars('NQ', 'feed', 'M1', { includeCurrent: true })).toHaveLength(1);
  });
});

describe('BarAggregator — ordering', () => {
  it('ignores and counts prices older than the current bar start', () => {
    const { a } = agg();
    a.ingest(tick('2026-09-28T14:01:05Z', 101));
    const r = a.ingest(tick('2026-09-28T14:00:59Z', 150));
    expect(r.accepted).toBe(false);
    expect(a.stats().outOfOrder).toBe(1);
    expect(a.bars('NQ', 'feed', 'M1', { includeCurrent: true })[0]).toMatchObject({
      high: 101,
      tickCount: 1,
    });
  });

  it('keeps a late price inside the current bar for high/low but not for the close', () => {
    const { a } = agg();
    a.ingest(tick('2026-09-28T14:01:30Z', 105));
    a.ingest(tick('2026-09-28T14:01:10Z', 107));
    expect(a.bars('NQ', 'feed', 'M1', { includeCurrent: true })[0]).toMatchObject({
      open: 105,
      high: 107,
      close: 105,
      tickCount: 2,
    });
  });

  it('refuses prices for a bar that advance() already completed', () => {
    const { a } = agg();
    a.ingest(tick('2026-09-28T14:00:10Z', 100));
    a.advance(ms('2026-09-28T14:01:05Z'));
    expect(a.ingest(tick('2026-09-28T14:00:40Z', 90)).accepted).toBe(false);
    expect(a.bars('NQ', 'feed', 'M1')[0]!.low).toBe(100);
  });

  it('rejects non-positive prices and a source that changes its data kind', () => {
    const { a } = agg();
    expect(a.ingest(tick('2026-09-28T14:00:10Z', 0)).accepted).toBe(false);
    a.ingest(tick('2026-09-28T14:00:10Z', 100));
    const r = a.ingest(tick('2026-09-28T14:00:20Z', 100, { sourceKind: 'SIMULATED' }));
    expect(r).toMatchObject({ accepted: false, reason: expect.stringMatching(/LIVE/) });
  });

  it('keeps one series per source (sources are never mixed in a bar)', () => {
    const { a } = agg();
    a.ingest(tick('2026-09-28T14:00:10Z', 100));
    a.ingest(tick('2026-09-28T14:00:20Z', 200, { source: 'sim', sourceKind: 'SIMULATED' }));
    expect(a.sources('NQ').sort()).toEqual(['feed', 'sim']);
    expect(a.bars('NQ', 'sim', 'M1', { includeCurrent: true })[0]).toMatchObject({
      open: 200,
      sourceKind: 'SIMULATED',
    });
    expect(a.bars('NQ', 'feed', 'M1', { includeCurrent: true })[0]!.high).toBe(100);
  });
});

describe('BarAggregator — observation coverage and window', () => {
  it('discards bars whose period began before observation started (never shown as complete)', () => {
    const { a, emitted } = agg({
      timeframes: ['M1', 'D1'],
      observingSinceMs: ms('2026-09-28T14:00:30Z'),
    });
    a.ingest(tick('2026-09-28T14:00:40Z', 100));
    // Neither the partial minute nor the partial trading day is exposed.
    expect(a.bars('NQ', 'feed', 'M1', { includeCurrent: true })).toEqual([]);
    expect(a.bars('NQ', 'feed', 'D1', { includeCurrent: true })).toEqual([]);
    a.ingest(tick('2026-09-28T14:01:10Z', 101));
    a.ingest(tick('2026-09-28T14:02:10Z', 102));
    expect(emitted.map((b) => b.openTime)).toEqual(['2026-09-28T14:01:00.000Z']);
    expect(a.stats().incompleteDiscarded).toBe(1);
    // The next full trading day is complete coverage again.
    a.ingest(tick('2026-09-28T22:00:05Z', 103));
    expect(a.bars('NQ', 'feed', 'D1', { includeCurrent: true })).toHaveLength(1);
    expect(a.stats().incompleteDiscarded).toBe(2);
  });

  it('bounds the window per series and timeframe and reports the coverage start', () => {
    const { a } = agg({ maxBars: 3, observingSinceMs: ms('2026-09-28T14:00:00Z') });
    for (let i = 0; i < 6; i++) {
      a.ingest(tick(new Date(ms('2026-09-28T14:00:10Z') + i * 60_000).toISOString(), 100 + i));
    }
    const done = a.bars('NQ', 'feed', 'M1');
    expect(done.map((b) => b.open)).toEqual([102, 103, 104]);
    // Minutes 14:00 and 14:01 were evicted: complete data only from 14:02.
    expect(new Date(a.coverageFromMs('NQ', 'feed', 'M1')!).toISOString()).toBe(
      '2026-09-28T14:02:00.000Z',
    );
    expect(a.coverageFromMs('NQ', 'other', 'M1')).toBeNull();
  });
});

describe('BarAggregator — seeding (warm-up)', () => {
  const seeds = [
    m1('2026-09-28T13:58:00Z', 101, 99),
    m1('2026-09-28T13:59:00Z', 102, 100),
    bar('D1', '2026-09-26T22:00:00Z', '2026-09-27T22:00:00Z', {
      open: 90,
      high: 110,
      low: 80,
      close: 100,
    }),
  ];

  it('loads completed bars and continues from them', () => {
    const { a, emitted } = agg({ timeframes: ['M1', 'D1'] });
    expect(a.seed(seeds)).toBe(3);
    expect(a.bars('NQ', 'feed', 'M1').map((b) => b.openTime)).toEqual([
      '2026-09-28T13:58:00.000Z',
      '2026-09-28T13:59:00.000Z',
    ]);
    // Older than the last seeded bar's end → out of order.
    expect(a.ingest(tick('2026-09-28T13:59:30Z', 100)).accepted).toBe(false);
    expect(a.ingest(tick('2026-09-28T14:00:05Z', 100)).accepted).toBe(true);
    a.ingest(tick('2026-09-28T14:01:05Z', 100));
    expect(a.bars('NQ', 'feed', 'M1')).toHaveLength(3);
    expect(emitted).toHaveLength(1); // seeds are not re-emitted
    expect(a.lastActivityMs('NQ', 'feed')).toBe(ms('2026-09-28T14:01:05Z'));
  });

  it('rejects incomplete, misaligned, duplicate, unconfigured and kind-conflicting bars', () => {
    const { a } = agg({ timeframes: ['M1'] });
    a.seed([seeds[0]!]);
    const n = a.seed([
      seeds[0]!, // duplicate
      m1('2026-09-28T14:00:00Z', 101, 99, { complete: false }),
      m1('2026-09-28T14:01:30Z', 101, 99), // misaligned
      seeds[2]!, // D1 not configured
      m1('2026-09-28T14:02:00Z', 101, 99, { sourceKind: 'SIMULATED' }),
    ]);
    expect(n).toBe(0);
    expect(a.stats().seedRejected).toBe(5);
  });

  it('rejects D1 seeds aligned to a different trading-day start', () => {
    const { a } = agg({ timeframes: ['D1'] });
    const utcDay = bar('D1', '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z', {
      open: 1,
      high: 1,
      low: 1,
      close: 1,
    });
    expect(a.seed([utcDay])).toBe(0);
  });
});
