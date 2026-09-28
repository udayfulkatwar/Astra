import { observed, type CalendarWindow, type EconomicEvent } from '@astra/core';
import { describe, expect, it } from 'vitest';
import { tradeContext } from '../src/context';

const event = (id: string, at: string, o: Partial<EconomicEvent> = {}): EconomicEvent => ({
  id,
  title: id,
  impact: 'HIGH',
  scheduledAt: at,
  affectedInstruments: [],
  ...o,
});
const cal = (from: string, to: string, events: EconomicEvent[], kind = 'LIVE' as const) =>
  observed<CalendarWindow>({ from, to, events }, { source: 'test', sourceKind: kind, asOf: from });
const DAY = { start: new Date('2026-09-27T21:00:00Z'), end: new Date('2026-09-28T21:00:00Z') };
const base = {
  signal: { features: { setup: 'BOS' }, timeframe: 'M15' },
  symbol: 'NQ',
  eventCurrencies: ['USD'],
  entryAt: '2026-09-28T13:00:00.000Z',
  exitAt: '2026-09-28T15:00:00.000Z',
  day: DAY,
};

describe('tradeContext', () => {
  it('records the setup and whether a relevant high-impact event fell on the day / while open', () => {
    const c = tradeContext({
      ...base,
      calendars: [
        cal('2026-09-27T00:00:00Z', '2026-09-30T00:00:00Z', [
          event('cpi', '2026-09-28T14:30:00Z', { currency: 'USD' }),
        ]),
      ],
    });
    expect(c).toEqual({
      setup: 'BOS',
      timeframe: 'M15',
      eventDay: 'YES',
      heldThroughEvent: 'YES',
      calendarSource: 'LIVE',
    });
  });

  it('ignores events of other currencies, medium impact, and events outside the period', () => {
    const c = tradeContext({
      ...base,
      calendars: [
        cal('2026-09-27T00:00:00Z', '2026-09-30T00:00:00Z', [
          event('ecb', '2026-09-28T14:00:00Z', { currency: 'EUR' }),
          event('ism', '2026-09-28T14:00:00Z', { currency: 'USD', impact: 'MEDIUM' }),
          event('late', '2026-09-28T19:00:00Z', { currency: 'USD' }), // same day, after the exit
        ]),
      ],
    });
    expect(c).toMatchObject({ eventDay: 'YES', heldThroughEvent: 'NO' });
  });

  it('is UNKNOWN — never "no event" — when no calendar covers the period', () => {
    const partial = cal('2026-09-28T12:00:00Z', '2026-09-28T16:00:00Z', []);
    const c = tradeContext({ ...base, signal: null, calendars: [null, partial] });
    expect(c).toEqual({
      setup: null,
      timeframe: null,
      eventDay: 'UNKNOWN', // the window starts after the trading day began
      heldThroughEvent: 'NO', // but it covers the time the position was open
      calendarSource: 'LIVE',
    });
    expect(tradeContext({ ...base, calendars: [] })).toMatchObject({
      eventDay: 'UNKNOWN',
      heldThroughEvent: 'UNKNOWN',
      calendarSource: null,
    });
  });
});
