/**
 * Economic calendar store (Phase 1: fed by ingestion or simulation; Phase 4 adds providers).
 * No window → UNAVAILABLE. Coverage is explicit: the gate checks it covers the blackout window.
 */
import {
  notObserved,
  observed,
  type CalendarWindow,
  type DataSourceKind,
  type Observed,
  type ObservedOk,
} from '@astra/core';

export class CalendarService {
  private window: ObservedOk<CalendarWindow> | null = null;

  constructor(private readonly onIngest: () => void) {}

  ingest(window: CalendarWindow, source: string, sourceKind: DataSourceKind, asOf: string): void {
    this.window = observed(window, { source, sourceKind, asOf });
    this.onIngest();
  }

  current(): Observed<CalendarWindow> {
    return (
      this.window ?? notObserved('UNAVAILABLE', 'no economic calendar data received', 'calendar')
    );
  }

  /** Events inside [from, to] from the current window (for the dashboard). */
  upcoming(from: Date, to: Date): Observed<CalendarWindow> {
    const w = this.current();
    if (w.status !== 'OK') return w;
    const events = w.value.events.filter((e) => {
      const t = Date.parse(e.scheduledAt);
      return t >= from.getTime() && t <= to.getTime();
    });
    return { ...w, value: { ...w.value, events } };
  }
}
