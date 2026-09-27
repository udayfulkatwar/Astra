import { describe, expect, it } from 'vitest';
import {
  activeSessions,
  isInSession,
  marketStatus,
  TradingHoursSchema,
  type SessionDefinition,
} from '../src/sessions';

const london: SessionDefinition = {
  id: 'london',
  name: 'London',
  timeZone: 'Europe/London',
  start: '08:00',
  end: '16:30',
  days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
};
const asiaCrossing: SessionDefinition = {
  id: 'asia',
  name: 'Asia (UTC)',
  timeZone: 'UTC',
  start: '23:00',
  end: '08:00',
  days: ['SUN', 'MON', 'TUE', 'WED', 'THU'],
};

describe('sessions', () => {
  it('evaluates a daily window in its own time zone across DST', () => {
    // Summer (BST = UTC+1): 08:00 London = 07:00Z
    expect(isInSession(new Date('2026-07-06T07:00:00Z'), london)).toBe(true);
    expect(isInSession(new Date('2026-07-06T06:59:00Z'), london)).toBe(false);
    // Winter (GMT): 08:00 London = 08:00Z
    expect(isInSession(new Date('2026-12-07T07:30:00Z'), london)).toBe(false);
    expect(isInSession(new Date('2026-12-07T08:00:00Z'), london)).toBe(true);
    expect(isInSession(new Date('2026-12-07T16:30:00Z'), london)).toBe(false); // end exclusive
  });

  it('respects configured days', () => {
    expect(isInSession(new Date('2026-07-04T10:00:00Z'), london)).toBe(false); // Saturday
  });

  it('handles windows that cross midnight (attributed to the start day)', () => {
    expect(isInSession(new Date('2026-09-27T23:30:00Z'), asiaCrossing)).toBe(true); // Sun 23:30
    expect(isInSession(new Date('2026-09-28T07:59:00Z'), asiaCrossing)).toBe(true); // Mon early, started Sun
    expect(isInSession(new Date('2026-10-02T23:30:00Z'), asiaCrossing)).toBe(false); // Fri 23:30 — no Fri start
    expect(isInSession(new Date('2026-10-03T02:00:00Z'), asiaCrossing)).toBe(false); // Sat early — no Fri start
  });

  it('lists active sessions', () => {
    expect(activeSessions(new Date('2026-09-28T07:30:00Z'), [london, asiaCrossing])).toEqual([
      'london',
      'asia',
    ]);
  });
});

// CME Globex-style equity-index futures schedule (ET): Sun 18:00 → Fri 17:00, daily 17:00–18:00 break.
const globex = TradingHoursSchema.parse({
  timeZone: 'America/New_York',
  dayStart: '18:00',
  weekly: [
    { open: { day: 'SUN', time: '18:00' }, close: { day: 'MON', time: '17:00' } },
    { open: { day: 'MON', time: '18:00' }, close: { day: 'TUE', time: '17:00' } },
    { open: { day: 'TUE', time: '18:00' }, close: { day: 'WED', time: '17:00' } },
    { open: { day: 'WED', time: '18:00' }, close: { day: 'THU', time: '17:00' } },
    { open: { day: 'THU', time: '18:00' }, close: { day: 'FRI', time: '17:00' } },
  ],
});

describe('marketStatus', () => {
  it('is open mid-session with minutes to the daily close', () => {
    const s = marketStatus(new Date('2026-09-28T14:00:00Z'), globex); // Mon 10:00 ET
    expect(s.open).toBe(true);
    expect(s.nextClose).toBe('2026-09-28T21:00:00.000Z');
    expect(s.minutesToClose).toBe(420);
  });

  it('is closed during the daily break and reports the next open', () => {
    const s = marketStatus(new Date('2026-09-28T21:30:00Z'), globex); // Mon 17:30 ET
    expect(s.open).toBe(false);
    expect(s.nextOpen).toBe('2026-09-28T22:00:00.000Z');
  });

  it('is closed over the weekend and opens Sunday evening', () => {
    const s = marketStatus(new Date('2026-10-03T15:00:00Z'), globex); // Sat
    expect(s.open).toBe(false);
    expect(s.nextOpen).toBe('2026-10-04T22:00:00.000Z'); // Sun 18:00 EDT
  });

  it('handles the Sunday interval that crosses into Monday and DST changes', () => {
    expect(marketStatus(new Date('2026-10-04T23:00:00Z'), globex).open).toBe(true); // Sun 19:00 EDT
    // After US DST ends (Nov 1): Sun 18:00 EST = 23:00Z
    expect(marketStatus(new Date('2026-11-01T22:30:00Z'), globex).open).toBe(false);
    expect(marketStatus(new Date('2026-11-01T23:00:00Z'), globex).open).toBe(true);
  });

  it('supports an interval that wraps the week end (Sat open → Mon close)', () => {
    const wrap = TradingHoursSchema.parse({
      timeZone: 'UTC',
      dayStart: '00:00',
      weekly: [{ open: { day: 'SAT', time: '00:00' }, close: { day: 'MON', time: '00:00' } }],
    });
    expect(marketStatus(new Date('2026-10-04T12:00:00Z'), wrap).open).toBe(true); // Sunday
    expect(marketStatus(new Date('2026-10-05T12:00:00Z'), wrap).open).toBe(false); // Monday
  });
});
