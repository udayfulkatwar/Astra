import type { Bar, BarStore } from '@astra/market-data';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { BarPersister } from '../src/runtime/market-data';

const bar = (i: number): Bar => ({
  symbol: 'MNQ',
  timeframe: 'M1',
  openTime: new Date(Date.UTC(2026, 8, 28, 14, i)).toISOString(),
  closeTime: new Date(Date.UTC(2026, 8, 28, 14, i + 1)).toISOString(),
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: null,
  tickCount: 1,
  complete: true,
  source: 'test',
  sourceKind: 'MANUAL',
});

function store(fail: () => boolean) {
  const saved: Bar[] = [];
  const s: BarStore = {
    upsert: vi.fn((bars: readonly Bar[]) => {
      if (fail()) return Promise.reject(new Error('database unreachable'));
      saved.push(...bars);
      return Promise.resolve();
    }),
    recent: () => Promise.resolve([]),
  };
  return { s, saved };
}

describe('BarPersister', () => {
  it('logs a failed write, keeps the bars and writes them on the next flush', async () => {
    let down = true;
    const { s, saved } = store(() => down);
    const log = pino({ level: 'silent' });
    const error = vi.spyOn(log, 'error');
    const p = new BarPersister(s, log);
    p.enqueue([bar(0), bar(1)]);
    await expect(p.flush()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(p.stats()).toMatchObject({ pending: 2, persisted: 0 });
    down = false;
    await p.flush();
    expect(saved.map((b) => b.openTime)).toEqual([bar(0).openTime, bar(1).openTime]);
    expect(p.stats()).toEqual({ pending: 0, persisted: 2, dropped: 0 });
  });

  it('shares one in-flight flush and bounds the queue by dropping the oldest bars', async () => {
    const { s, saved } = store(() => false);
    const log = pino({ level: 'silent' });
    const error = vi.spyOn(log, 'error');
    const p = new BarPersister(s, log, 3);
    p.enqueue([bar(0), bar(1), bar(2), bar(3), bar(4)]);
    expect(error).toHaveBeenCalledTimes(1);
    const [a, b] = [p.flush(), p.flush()];
    expect(a).toBe(b);
    await a;
    expect(saved.map((x) => x.openTime)).toEqual([2, 3, 4].map((i) => bar(i).openTime));
    expect(p.stats()).toEqual({ pending: 0, persisted: 3, dropped: 2 });
  });
});
