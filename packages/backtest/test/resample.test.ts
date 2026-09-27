import { describe, expect, it } from 'vitest';
import type { Bar } from '@astra/market-data';
import { Resampler } from '../src';
import { config } from './helpers';

const hours = config.instruments.get('MNQ')!.tradingHours;

function m1(iso: string, price: number): Bar {
  const open = Date.parse(iso);
  return {
    symbol: 'MNQ',
    timeframe: 'M1',
    openTime: new Date(open).toISOString(),
    closeTime: new Date(open + 60_000).toISOString(),
    open: price,
    high: price + 1,
    low: price - 1,
    close: price + 0.5,
    volume: null,
    tickCount: 3,
    complete: true,
    source: 'test',
    sourceKind: 'SIMULATED',
  };
}

describe('Resampler', () => {
  it('emits a higher bar only when its period has closed', () => {
    const r = new Resampler('M15', hours);
    const out: Bar[] = [];
    for (let i = 0; i < 15; i++) {
      const got = r.push(
        m1(new Date(Date.parse('2026-03-03T15:00:00Z') + i * 60_000).toISOString(), 100 + i),
      );
      if (i < 14) expect(got).toEqual([]); // still forming: never visible
      out.push(...got);
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      timeframe: 'M15',
      openTime: '2026-03-03T15:00:00.000Z',
      closeTime: '2026-03-03T15:15:00.000Z',
      open: 100,
      high: 115,
      low: 99,
      close: 114.5,
      tickCount: 45,
      complete: true,
      sourceKind: 'SIMULATED',
    });
  });

  it('never emits the period the replay started inside', () => {
    const r = new Resampler('M15', hours);
    const got: Bar[] = [];
    for (let i = 5; i < 30; i++)
      got.push(
        ...r.push(m1(new Date(Date.parse('2026-03-03T15:00:00Z') + i * 60_000).toISOString(), 100)),
      );
    expect(got.map((b) => b.openTime)).toEqual(['2026-03-03T15:15:00.000Z']);
  });

  it('closes a period left incomplete by a data gap when a later period starts', () => {
    const r = new Resampler('M15', hours);
    r.push(m1('2026-03-03T15:00:00Z', 100));
    r.push(m1('2026-03-03T15:01:00Z', 101));
    const got = r.push(m1('2026-03-03T15:40:00Z', 90));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ openTime: '2026-03-03T15:00:00.000Z', close: 101.5 });
  });
});
