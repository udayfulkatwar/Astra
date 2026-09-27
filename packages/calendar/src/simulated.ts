/**
 * SIMULATED economic calendar for paper tests and the demo: a fixed weekly schedule of
 * placeholder releases, every title prefixed "SIMULATED". It exists to exercise the event
 * blackout; it is not a calendar. Its source kind is SIMULATED, which the gate refuses in
 * SHADOW and LIVE.
 */
import type { EconomicEvent, EventImpact } from '@astra/core';
import { DateTime } from 'luxon';
import type { CalendarAdapter } from './poller';

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
type Weekday = (typeof WEEKDAYS)[number];

export interface SimulatedSlot {
  readonly key: string;
  /** Local time "HH:mm" in the adapter's time zone. */
  readonly time: string;
  readonly days: readonly Weekday[];
  readonly impact: EventImpact;
  readonly currency: string;
  readonly title: string;
}

const WORKDAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

export const DEFAULT_SIMULATED_SLOTS: readonly SimulatedSlot[] = [
  {
    key: 'eu-low',
    time: '04:00',
    days: WORKDAYS,
    impact: 'LOW',
    currency: 'EUR',
    title: 'SIMULATED — EU low-impact release',
  },
  {
    key: 'us-high',
    time: '08:30',
    days: WORKDAYS,
    impact: 'HIGH',
    currency: 'USD',
    title: 'SIMULATED — US high-impact release',
  },
  {
    key: 'us-medium',
    time: '10:00',
    days: WORKDAYS,
    impact: 'MEDIUM',
    currency: 'USD',
    title: 'SIMULATED — US medium-impact release',
  },
  {
    key: 'us-rate',
    time: '14:00',
    days: ['WED'],
    impact: 'HIGH',
    currency: 'USD',
    title: 'SIMULATED — rate decision',
  },
];

export class SimulatedCalendarAdapter implements CalendarAdapter {
  readonly id: string;
  readonly kind = 'SIMULATED' as const;
  private readonly timeZone: string;
  private readonly slots: readonly SimulatedSlot[];

  constructor(opts: { id?: string; timeZone?: string; slots?: readonly SimulatedSlot[] } = {}) {
    this.id = opts.id ?? 'simulation';
    this.timeZone = opts.timeZone ?? 'America/New_York';
    this.slots = opts.slots ?? DEFAULT_SIMULATED_SLOTS;
  }

  /** Synchronous core of `fetch` (the demo runtime uses it directly). */
  window(range: { from: Date; to: Date }): { from: string; to: string; events: EconomicEvent[] } {
    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const events: EconomicEvent[] = [];
    let day = DateTime.fromMillis(fromMs, { zone: this.timeZone }).startOf('day');
    const last = DateTime.fromMillis(toMs, { zone: this.timeZone }).startOf('day');
    while (day <= last) {
      const weekday = WEEKDAYS[day.weekday - 1]!;
      for (const slot of this.slots) {
        if (!slot.days.includes(weekday)) continue;
        const [h, m] = slot.time.split(':').map(Number) as [number, number];
        const at = day.set({ hour: h, minute: m });
        const t = at.toMillis();
        if (t < fromMs || t > toMs) continue;
        events.push({
          id: `sim-${slot.key}-${day.toISODate()}`,
          title: slot.title,
          currency: slot.currency,
          impact: slot.impact,
          scheduledAt: new Date(t).toISOString(),
          affectedInstruments: [],
        });
      }
      day = day.plus({ days: 1 });
    }
    events.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
    return { from: range.from.toISOString(), to: range.to.toISOString(), events };
  }

  fetch(range: { from: Date; to: Date }): Promise<unknown> {
    return Promise.resolve(this.window(range));
  }
}
