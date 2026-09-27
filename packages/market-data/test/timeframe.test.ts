import { describe, expect, it } from 'vitest';
import { barWindow, dailyWindow, TIMEFRAMES } from '../src/timeframe';
import { GLOBEX, ms } from './fixtures';

const iso = (w: { openMs: number; closeMs: number }) => [
  new Date(w.openMs).toISOString(),
  new Date(w.closeMs).toISOString(),
];

describe('bar windows', () => {
  it('aligns intraday timeframes to UTC epoch multiples', () => {
    const at = ms('2026-09-28T14:07:31.500Z');
    expect(iso(barWindow(at, 'M1', GLOBEX))).toEqual([
      '2026-09-28T14:07:00.000Z',
      '2026-09-28T14:08:00.000Z',
    ]);
    expect(iso(barWindow(at, 'M5', GLOBEX))[0]).toBe('2026-09-28T14:05:00.000Z');
    expect(iso(barWindow(at, 'M15', GLOBEX))[0]).toBe('2026-09-28T14:00:00.000Z');
    expect(iso(barWindow(at, 'M30', GLOBEX))[0]).toBe('2026-09-28T14:00:00.000Z');
    expect(iso(barWindow(at, 'H1', GLOBEX))).toEqual([
      '2026-09-28T14:00:00.000Z',
      '2026-09-28T15:00:00.000Z',
    ]);
    expect(iso(barWindow(at, 'H4', GLOBEX))).toEqual([
      '2026-09-28T12:00:00.000Z',
      '2026-09-28T16:00:00.000Z',
    ]);
  });

  it('puts a boundary instant in the bar it opens (start inclusive, end exclusive)', () => {
    expect(iso(barWindow(ms('2026-09-28T14:08:00Z'), 'M1', undefined))[0]).toBe(
      '2026-09-28T14:08:00.000Z',
    );
    expect(iso(barWindow(ms('2026-09-28T15:59:59.999Z'), 'H4', undefined))[0]).toBe(
      '2026-09-28T12:00:00.000Z',
    );
  });

  it('nests every intraday boundary inside the finer timeframes', () => {
    const at = ms('2026-09-28T16:00:00Z');
    for (const tf of TIMEFRAMES.filter((t) => t !== 'D1')) {
      expect(barWindow(at, tf, undefined).openMs).toBe(at);
    }
  });

  it('aligns D1 to the instrument trading day (18:00 New York) in summer time', () => {
    // Mon 10:00 EDT → Sun 18:00 EDT (22:00Z) … Mon 18:00 EDT.
    expect(iso(dailyWindow(ms('2026-09-28T14:00:00Z'), GLOBEX))).toEqual([
      '2026-09-27T22:00:00.000Z',
      '2026-09-28T22:00:00.000Z',
    ]);
    // Exactly at 18:00 EDT a new trading day starts.
    expect(iso(dailyWindow(ms('2026-09-28T22:00:00Z'), GLOBEX))[0]).toBe(
      '2026-09-28T22:00:00.000Z',
    );
  });

  it('keeps the 18:00 New York day start across the DST changes (23 h and 25 h days)', () => {
    // After US DST ends (Sun Nov 1 2026): 18:00 EST = 23:00Z.
    expect(iso(dailyWindow(ms('2026-11-02T15:00:00Z'), GLOBEX))).toEqual([
      '2026-11-01T23:00:00.000Z',
      '2026-11-02T23:00:00.000Z',
    ]);
    // The trading day spanning the fall-back change is 25 hours long.
    const fall = dailyWindow(ms('2026-10-31T23:30:00Z'), GLOBEX);
    expect(iso(fall)).toEqual(['2026-10-31T22:00:00.000Z', '2026-11-01T23:00:00.000Z']);
    expect((fall.closeMs - fall.openMs) / 3_600_000).toBe(25);
    // Spring forward (Sun Mar 8 2026): 23 hours.
    const spring = dailyWindow(ms('2026-03-08T12:00:00Z'), GLOBEX);
    expect(iso(spring)).toEqual(['2026-03-07T23:00:00.000Z', '2026-03-08T22:00:00.000Z']);
    expect((spring.closeMs - spring.openMs) / 3_600_000).toBe(23);
    expect(barWindow(ms('2026-03-08T12:00:00Z'), 'D1', GLOBEX)).toEqual(spring);
  });

  it('falls back to UTC midnight for D1 without trading hours', () => {
    expect(iso(barWindow(ms('2026-09-28T23:59:00Z'), 'D1', undefined))).toEqual([
      '2026-09-28T00:00:00.000Z',
      '2026-09-29T00:00:00.000Z',
    ]);
  });
});
