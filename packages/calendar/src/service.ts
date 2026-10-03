/**
 * Economic-calendar store: one validated window at a time (the newest ingest wins), mapped to
 * instruments, with change detection between successive windows.
 *
 * - Validation: `CalendarWindowSchema` plus unique event ids; an invalid window is rejected and
 *   the previous one kept — it ages into STALE and the gate stops trading (fail-closed).
 * - Instrument mapping: an event without `affectedInstruments` but with a currency affects every
 *   instrument whose `eventCurrencies` include it, and every instrument without `eventCurrencies`
 *   (fail-safe). Events without a currency keep the empty list, which means "all instruments".
 * - Each source is bound to one `DataSourceKind` (a SIMULATED source can never turn LIVE).
 * - Changes (ADDED, REMOVED, RESCHEDULED, IMPACT_CHANGED, ACTUAL_RELEASED) are reported only
 *   inside the range both windows cover; the first window is the baseline (no changes).
 */
import {
  AstraError,
  CalendarWindowSchema,
  applyFreshness,
  notObserved,
  observed,
  type CalendarWindow,
  type Clock,
  type DataSourceKind,
  type EconomicEvent,
  type FreshnessPolicy,
  type HealthStatus,
  type InstrumentSpec,
  type Observed,
  type ObservedOk,
} from '@astra/core';
import { z } from 'zod';

export type CalendarChangeType =
  'ADDED' | 'REMOVED' | 'RESCHEDULED' | 'IMPACT_CHANGED' | 'ACTUAL_RELEASED';

export interface CalendarChange {
  readonly type: CalendarChangeType;
  readonly event: EconomicEvent;
  /** The event as it was before (REMOVED: the removed event itself). */
  readonly previous: EconomicEvent | null;
}

export interface CalendarIngestResult {
  readonly events: number;
  readonly changes: CalendarChange[];
}

export interface CalendarServiceOptions {
  readonly clock: Clock;
  /** The decision policy's `calendarMaxAgeMs` and `maxFutureSkewMs`. */
  readonly freshness: FreshnessPolicy;
  readonly instruments: ReadonlyMap<string, Pick<InstrumentSpec, 'eventCurrencies'>>;
  /** Changes detected by an ingest (not called when there are none). */
  readonly onChanges?: ((changes: readonly CalendarChange[], source: string) => void) | undefined;
  /** Every accepted live/manual/simulated ingest after mapping; restore never calls this. */
  readonly onWindow?: ((window: ObservedOk<CalendarWindow>) => void) | undefined;
}

export class CalendarService {
  private window: ObservedOk<CalendarWindow> | null = null;
  private readonly sourceKinds = new Map<string, DataSourceKind>();

  constructor(private readonly opts: CalendarServiceOptions) {}

  /** Validates, maps and stores a window. Throws VALIDATION (the previous window is kept). */
  ingest(raw: unknown, source: string, sourceKind: DataSourceKind): CalendarIngestResult {
    const parsed = this.validate(raw, source);
    this.bindSource(source, sourceKind);

    const window: CalendarWindow = {
      from: parsed.from,
      to: parsed.to,
      events: parsed.events
        .map((e) => this.mapInstruments(e))
        .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)),
    };
    const previous = this.window?.value ?? null;
    const accepted = observed(window, {
      source,
      sourceKind,
      asOf: this.opts.clock.now().toISOString(),
    });
    this.window = accepted;
    this.opts.onWindow?.(accepted);
    const changes = previous ? diffWindows(previous, window) : [];
    if (changes.length > 0) this.opts.onChanges?.(changes, source);
    return { events: window.events.length, changes };
  }

  /**
   * Restores a previously accepted window exactly as observed. The original `asOf` is preserved,
   * so restart cannot make stale data fresh. Restore is a baseline: it emits no change events and
   * does not call `onWindow` (which would persist the same observation again).
   */
  restore(saved: ObservedOk<CalendarWindow>): void {
    const parsed = this.validate(saved.value, saved.source);
    this.bindSource(saved.source, saved.sourceKind);
    this.window = { ...saved, value: parsed };
  }

  /** The stored window as observed (UNAVAILABLE before the first ingest); not freshness-checked. */
  current(): Observed<CalendarWindow> {
    return (
      this.window ?? notObserved('UNAVAILABLE', 'no economic calendar data received', 'calendar')
    );
  }

  /** The stored window with freshness applied now. */
  fresh(): Observed<CalendarWindow> {
    return applyFreshness(this.current(), this.opts.clock.now(), this.opts.freshness);
  }

  /** Events scheduled inside [from, to] (the window's coverage is kept as received). */
  upcoming(from: Date, to: Date): Observed<CalendarWindow> {
    const w = this.current();
    if (w.status !== 'OK') return w;
    const events = w.value.events.filter((e) => {
      const t = Date.parse(e.scheduledAt);
      return t >= from.getTime() && t <= to.getTime();
    });
    return { ...w, value: { ...w.value, events } };
  }

  /** CALENDAR component health: ONLINE only while the window is fresh. */
  health(): { status: HealthStatus; detail: string } {
    const w = this.fresh();
    if (w.status !== 'OK') {
      return {
        status: w.status === 'UNAVAILABLE' ? 'UNKNOWN' : 'DEGRADED',
        detail: `calendar ${w.status}: ${w.reason}`,
      };
    }
    return {
      status: 'ONLINE',
      detail: `${w.value.events.length} events from ${w.source} (${w.sourceKind}), coverage ${w.value.from} → ${w.value.to}`,
    };
  }

  private validate(raw: unknown, source: string): CalendarWindow {
    const parsed = CalendarWindowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AstraError(
        'VALIDATION',
        `invalid calendar window from ${source}: ${z.prettifyError(parsed.error)}`,
      );
    }
    const ids = new Set<string>();
    for (const e of parsed.data.events) {
      if (ids.has(e.id)) {
        throw new AstraError(
          'VALIDATION',
          `calendar window from ${source} repeats event id ${e.id}`,
        );
      }
      ids.add(e.id);
    }
    return parsed.data;
  }

  private bindSource(source: string, sourceKind: DataSourceKind): void {
    const bound = this.sourceKinds.get(source);
    if (bound !== undefined && bound !== sourceKind) {
      throw new AstraError(
        'VALIDATION',
        `calendar source ${source} delivers ${bound} data; refusing ${sourceKind}`,
      );
    }
    this.sourceKinds.set(source, sourceKind);
  }

  private mapInstruments(e: EconomicEvent): EconomicEvent {
    if (e.affectedInstruments.length > 0 || e.currency === undefined) return e;
    const currency = e.currency.toUpperCase();
    const all = [...this.opts.instruments.entries()];
    const affected = all
      .filter(
        ([, spec]) => spec.eventCurrencies === undefined || spec.eventCurrencies.includes(currency),
      )
      .map(([symbol]) => symbol)
      .sort();
    // Every instrument affected: keep the empty list ("all"), which also covers ones added later.
    return affected.length === all.length ? e : { ...e, affectedInstruments: affected };
  }
}

/** Changes from `before` to `after`, limited to the range both windows cover. */
export function diffWindows(before: CalendarWindow, after: CalendarWindow): CalendarChange[] {
  const from = Math.max(Date.parse(before.from), Date.parse(after.from));
  const to = Math.min(Date.parse(before.to), Date.parse(after.to));
  const inBoth = (e: EconomicEvent) => {
    const t = Date.parse(e.scheduledAt);
    return t >= from && t <= to;
  };
  const old = new Map(before.events.map((e) => [e.id, e]));
  const now = new Map(after.events.map((e) => [e.id, e]));
  const changes: CalendarChange[] = [];
  for (const e of after.events) {
    const prev = old.get(e.id);
    if (!prev) {
      if (inBoth(e)) changes.push({ type: 'ADDED', event: e, previous: null });
      continue;
    }
    if (prev.scheduledAt !== e.scheduledAt)
      changes.push({ type: 'RESCHEDULED', event: e, previous: prev });
    if (prev.impact !== e.impact)
      changes.push({ type: 'IMPACT_CHANGED', event: e, previous: prev });
    if (prev.actual === undefined && e.actual !== undefined)
      changes.push({ type: 'ACTUAL_RELEASED', event: e, previous: prev });
  }
  for (const e of before.events) {
    if (!now.has(e.id) && inBoth(e)) changes.push({ type: 'REMOVED', event: e, previous: e });
  }
  return changes;
}
