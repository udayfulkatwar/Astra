import { describe, expect, it } from 'vitest';
import type { Bar } from '../api/types';
import { delay, tickDecimals, toCandles } from './candles';
import { ago, money, pct, shortHash, utcTime } from './format';
import { toneOf } from './status';

describe('toneOf', () => {
  it('never maps an unrecognised or missing status to a good tone', () => {
    expect(toneOf(undefined)).toBe('unknown');
    expect(toneOf(null)).toBe('unknown');
    expect(toneOf('SOMETHING_NEW')).toBe('unknown');
  });

  it('maps the safety vocabularies consistently', () => {
    expect(toneOf('ONLINE')).toBe('ok');
    expect(toneOf('SAFE')).toBe('ok');
    expect(toneOf('CAUTION')).toBe('warn');
    expect(toneOf('RESTRICTED')).toBe('restricted');
    for (const bad of ['HALTED', 'BREACH_RISK', 'REJECTED', 'FAIL', 'ERROR', 'CRITICAL'])
      expect(toneOf(bad)).toBe('bad');
    for (const unknown of ['UNKNOWN', 'STALE', 'TIMEOUT', 'UNAVAILABLE', 'INVALID'])
      expect(toneOf(unknown)).toBe('unknown');
    expect(toneOf('LIVE')).toBe('live');
    expect(toneOf('SHADOW')).toBe('shadow');
  });
});

describe('format', () => {
  it('shows missing values as a dash, never as zero', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(pct(null)).toBe('—');
    expect(utcTime(null)).toBe('—');
  });

  it('formats money, percentages, times and hashes', () => {
    expect(money(-1234.5)).toBe('-$1,234.50');
    expect(pct(24.6789)).toBe('24.7%');
    expect(utcTime('2026-09-28T14:05:09.000Z')).toBe('14:05:09Z');
    expect(shortHash('sha256:abcdef0123456789')).toBe('abcdef0123');
  });

  it('describes ages relative to now', () => {
    const now = Date.parse('2026-09-28T14:00:00Z');
    expect(ago('2026-09-28T13:59:30Z', now)).toBe('30s ago');
    expect(ago('2026-09-28T13:00:00Z', now)).toBe('1h ago');
    expect(ago('2026-09-28T14:01:00Z', now)).toBe('in the future');
    expect(ago(null, now)).toBe('never');
  });
});

describe('candles', () => {
  const bar = (openTime: string, open: number, close: number, complete = true): Bar => ({
    symbol: 'EURUSD',
    timeframe: 'M1',
    openTime,
    closeTime: new Date(Date.parse(openTime) + 60_000).toISOString(),
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: null,
    tickCount: 0,
    complete,
    source: 'yahoo',
    sourceKind: 'LIVE',
  });

  it('maps bars to UTC epoch-second candles, strictly ascending, in-progress bar muted', () => {
    const c = toCandles(
      [
        bar('2026-09-28T14:00:00.000Z', 10, 11),
        bar('2026-09-28T14:00:00.000Z', 99, 99), // duplicate time → dropped
        bar('2026-09-28T13:59:00.000Z', 99, 99), // out of order → dropped
        bar('2026-09-28T14:01:00.000Z', 11, 10, false),
      ],
      { up: 'U', down: 'D' },
    );
    expect(c).toEqual([
      { time: Date.parse('2026-09-28T14:00:00Z') / 1000, open: 10, high: 12, low: 9, close: 11 },
      {
        time: Date.parse('2026-09-28T14:01:00Z') / 1000,
        open: 11,
        high: 12,
        low: 9,
        close: 10,
        color: 'D',
        wickColor: 'D',
        borderColor: 'D',
      },
    ]);
  });

  it('price precision from the tick size; delays for people', () => {
    expect(tickDecimals(0.25)).toBe(2);
    expect(tickDecimals(0.00001)).toBe(5);
    expect(tickDecimals(0.001)).toBe(3);
    expect(tickDecimals(1)).toBe(0);
    expect(tickDecimals(0)).toBe(2);
    expect(delay(300)).toBe('0.3 s');
    expect(delay(12_400)).toBe('12 s');
    expect(delay(65_000)).toBe('1 min 5 s');
    expect(delay(900_000)).toBe('15 min');
    expect(delay(null)).toBe('—');
    expect(delay(-1_500)).toBe('-1.5 s (clock ahead)');
  });
});
