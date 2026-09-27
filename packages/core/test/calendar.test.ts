import { describe, expect, it } from 'vitest';
import { assessBlackout, type CalendarWindow, type EconomicEvent } from '../src';

const rule = { impactLevels: ['HIGH'] as const, minutesBefore: 15, minutesAfter: 15 };
const ev = (id: string, at: string, extra: Partial<EconomicEvent> = {}): EconomicEvent => ({
  id,
  title: id,
  impact: 'HIGH',
  scheduledAt: at,
  affectedInstruments: [],
  ...extra,
});
const window = (events: EconomicEvent[]): CalendarWindow => ({
  from: '2026-09-28T00:00:00.000Z',
  to: '2026-09-29T00:00:00.000Z',
  events,
});

describe('assessBlackout', () => {
  const events = [
    ev('cpi', '2026-09-28T12:30:00.000Z'),
    ev('medium', '2026-09-28T13:00:00.000Z', { impact: 'MEDIUM' }),
    ev('gold-only', '2026-09-28T14:00:00.000Z', { affectedInstruments: ['XAUUSD'] }),
    ev('unknown-impact', '2026-09-28T18:00:00.000Z', { impact: 'UNKNOWN' }),
  ];

  it('is BLACKOUT within minutesBefore/After of a restricted event, with the time it clears', () => {
    const a = assessBlackout(window(events), 'NQ', new Date('2026-09-28T12:20:00Z'), rule);
    expect(a).toMatchObject({
      state: 'BLACKOUT',
      blocking: [{ id: 'cpi' }],
      clearAt: '2026-09-28T12:45:00.000Z',
    });
  });

  it('is CLEAR otherwise and names the next restricted event for the symbol', () => {
    const nq = assessBlackout(window(events), 'NQ', new Date('2026-09-28T12:50:00Z'), rule);
    // MEDIUM is not restricted; the gold-only event does not affect NQ; UNKNOWN counts as HIGH.
    expect(nq).toMatchObject({
      state: 'CLEAR',
      blocking: [],
      clearAt: null,
      next: { event: { id: 'unknown-impact' }, blackoutFrom: '2026-09-28T17:45:00.000Z' },
    });
    const gold = assessBlackout(window(events), 'XAUUSD', new Date('2026-09-28T12:50:00Z'), rule);
    expect(gold).toMatchObject({ state: 'CLEAR', next: { event: { id: 'gold-only' } } });
  });

  it('is UNCOVERED — never clear — when the window does not cover the blackout range', () => {
    const a = assessBlackout(window([]), 'NQ', new Date('2026-09-28T23:50:00Z'), rule);
    expect(a).toEqual({
      state: 'UNCOVERED',
      from: '2026-09-28T23:35:00.000Z',
      to: '2026-09-29T00:05:00.000Z',
    });
  });
});
