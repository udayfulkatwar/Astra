import { toNum } from '@astra/core';
import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/bar';
import { averageTrueRange, trueRange } from '../src/indicators';
import { bar } from './fixtures';

/** Hourly bars closing at 100 whose true range equals the given values (high − low). */
function barsWithRanges(ranges: number[]): Bar[] {
  const start = Date.parse('2026-09-01T00:00:00Z');
  return [0, ...ranges].map((r, i) =>
    bar(
      'H1',
      new Date(start + i * 3_600_000).toISOString(),
      new Date(start + (i + 1) * 3_600_000).toISOString(),
      { open: 100, high: 100 + r / 2, low: 100 - r / 2, close: 100 },
    ),
  );
}

describe('true range', () => {
  it('uses the previous close when the bar gaps away from it', () => {
    expect(toNum(trueRange({ high: 105, low: 104 }, 100))).toBe(5); // gap up
    expect(toNum(trueRange({ high: 96, low: 95 }, 100))).toBe(5); // gap down
    expect(toNum(trueRange({ high: 102, low: 98 }, 100))).toBe(4); // inside
  });
});

describe('ATR(14), Wilder smoothing', () => {
  const first14 = Array.from({ length: 14 }, (_, i) => i + 1); // TR 1…14

  it('is null with fewer than 15 complete bars (never estimated)', () => {
    expect(averageTrueRange([])).toBeNull();
    expect(averageTrueRange(barsWithRanges(first14.slice(0, 13)))).toBeNull(); // 14 bars
  });

  it('starts with the simple mean of the first 14 true ranges', () => {
    expect(averageTrueRange(barsWithRanges(first14))).toBe(7.5); // (1+…+14)/14
  });

  it('then applies ATR = (prev × 13 + TR) / 14 (hand-computed)', () => {
    // (7.5 × 13 + 21) / 14 = 8.4642857142…
    expect(averageTrueRange(barsWithRanges([...first14, 21]))).toBe(8.46428571);
    // (8.4642857142… × 13 + 0.5) / 14 = 7.8954081632…
    expect(averageTrueRange(barsWithRanges([...first14, 21, 0.5]))).toBe(7.89540816);
  });

  it('ignores the in-progress bar', () => {
    const bars = barsWithRanges(first14);
    const last = bars.at(-1)!;
    const inProgress = { ...last, openTime: last.closeTime, high: 1_000, complete: false };
    expect(averageTrueRange([...bars, inProgress])).toBe(7.5);
  });
});
