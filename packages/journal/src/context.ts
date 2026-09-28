/**
 * Trade context for learning, recorded with the journal entry: the strategy's setup label and
 * whether a high-impact economic event fell on the entry's trading day or while the position was
 * open. Event facts come only from a calendar window that COVERS the period in question;
 * otherwise they are UNKNOWN — never assumed "no event".
 */
import {
  effectiveImpact,
  eventAffectsInstrument,
  type CalendarWindow,
  type DataSourceKind,
  type Observed,
} from '@astra/core';

export type Tristate = 'YES' | 'NO' | 'UNKNOWN';

export interface TradeContext {
  /** The strategy's setup label (signal `features.setup`); null when it gave none. */
  readonly setup: string | null;
  /** Signal timeframe; null when not given. */
  readonly timeframe: string | null;
  /** A HIGH- (or unknown-) impact event for the instrument was scheduled on the entry's trading day. */
  readonly eventDay: Tristate;
  /** Such an event was scheduled while the position was open. */
  readonly heldThroughEvent: Tristate;
  /** Kind of calendar data the event facts came from (null when none covered them). */
  readonly calendarSource: DataSourceKind | null;
}

export function tradeContext(input: {
  readonly signal: {
    readonly features?: Record<string, unknown>;
    readonly timeframe?: string | undefined;
  } | null;
  readonly symbol: string;
  readonly eventCurrencies: readonly string[] | undefined;
  readonly entryAt: string;
  readonly exitAt: string;
  /** The entry's trading-day window (the account's day reset). */
  readonly day: { readonly start: Date; readonly end: Date };
  /** Candidate calendars, most authoritative first (e.g. the one the decision saw, then the current one). */
  readonly calendars: readonly (Observed<CalendarWindow> | null)[];
}): TradeContext {
  const setup = input.signal?.features?.['setup'];
  const windows = input.calendars.flatMap((c) => (c?.status === 'OK' ? [c] : []));
  const sources: DataSourceKind[] = [];
  const within = (fromMs: number, toMs: number): Tristate => {
    const w = windows.find(
      (c) => Date.parse(c.value.from) <= fromMs && Date.parse(c.value.to) >= toMs,
    );
    if (!w) return 'UNKNOWN';
    sources.push(w.sourceKind);
    return w.value.events.some((e) => {
      const t = Date.parse(e.scheduledAt);
      return (
        t >= fromMs &&
        t <= toMs &&
        effectiveImpact(e.impact) === 'HIGH' &&
        eventAffectsInstrument(e, input.symbol, input.eventCurrencies)
      );
    })
      ? 'YES'
      : 'NO';
  };
  const eventDay = within(input.day.start.getTime(), input.day.end.getTime() - 1);
  const heldThroughEvent = within(Date.parse(input.entryAt), Date.parse(input.exitAt));
  return {
    setup: typeof setup === 'string' && setup.length > 0 ? setup : null,
    timeframe: input.signal?.timeframe ?? null,
    eventDay,
    heldThroughEvent,
    calendarSource: sources[0] ?? null,
  };
}
