import { describe, expect, it } from 'vitest';
import { ManualClock, nextDailyTime, nextWeeklyTime, tradingDayWindow } from '../src/time';

describe('tradingDayWindow', () => {
  const nyReset = { timeZone: 'America/New_York', time: '17:00' };

  it('labels a futures-style 17:00 ET reset by the day the window ends', () => {
    // Monday 2026-09-28 10:00 ET (14:00Z, EDT = UTC-4)
    const w = tradingDayWindow(new Date('2026-09-28T14:00:00Z'), nyReset);
    expect(w.key).toBe('2026-09-28');
    expect(w.start.toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-28T21:00:00.000Z');
  });

  it('rolls to the next trading day at the reset instant', () => {
    const w = tradingDayWindow(new Date('2026-09-28T21:00:00Z'), nyReset);
    expect(w.key).toBe('2026-09-29');
  });

  it('uses the local calendar date for a midnight reset', () => {
    const w = tradingDayWindow(new Date('2026-09-28T21:30:00Z'), {
      timeZone: 'Europe/Prague',
      time: '00:00',
    });
    // 21:30Z = 23:30 in Prague (CEST, UTC+2)
    expect(w.key).toBe('2026-09-28');
    const w2 = tradingDayWindow(new Date('2026-09-28T22:30:00Z'), {
      timeZone: 'Europe/Prague',
      time: '00:00',
    });
    expect(w2.key).toBe('2026-09-29');
  });

  it('keeps the reset at wall-clock time across the DST change (window is 25h)', () => {
    // US DST ends 2026-11-01 02:00 local. Window from Oct 31 17:00 EDT to Nov 1 17:00 EST.
    const w = tradingDayWindow(new Date('2026-11-01T12:00:00Z'), nyReset);
    expect(w.start.toISOString()).toBe('2026-10-31T21:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-01T22:00:00.000Z');
    expect(w.key).toBe('2026-11-01');
  });
});

describe('nextDailyTime / nextWeeklyTime', () => {
  it('finds the next daily flat time', () => {
    const t = nextDailyTime(new Date('2026-09-28T14:00:00Z'), {
      timeZone: 'America/New_York',
      time: '16:10',
    });
    expect(t.toISOString()).toBe('2026-09-28T20:10:00.000Z');
  });

  it('finds the next Friday close from a Wednesday', () => {
    const t = nextWeeklyTime(new Date('2026-09-30T12:00:00Z'), {
      timeZone: 'America/New_York',
      time: '16:00',
      day: 'FRI',
    });
    expect(t.toISOString()).toBe('2026-10-02T20:00:00.000Z');
  });

  it('wraps to next week after the weekly time has passed', () => {
    const t = nextWeeklyTime(new Date('2026-10-02T21:00:00Z'), {
      timeZone: 'America/New_York',
      time: '16:00',
      day: 'FRI',
    });
    expect(t.toISOString()).toBe('2026-10-09T20:00:00.000Z');
  });
});

describe('ManualClock', () => {
  it('advances deterministically', () => {
    const c = new ManualClock('2026-09-28T14:00:00Z');
    c.advance(1_500);
    expect(c.now().toISOString()).toBe('2026-09-28T14:00:01.500Z');
  });
});
