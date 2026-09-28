/** Economic calendar DATA. Coverage is explicit: "no events" is only meaningful inside [from, to]. */
import { z } from 'zod';
import { IsoDateTimeSchema, SymbolSchema } from '../schemas';

export const EVENT_IMPACTS = ['HIGH', 'MEDIUM', 'LOW', 'HOLIDAY', 'UNKNOWN'] as const;
export type EventImpact = (typeof EVENT_IMPACTS)[number];
export const EventImpactSchema = z.enum(EVENT_IMPACTS);

export const EconomicEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  country: z.string().optional(),
  currency: z.string().optional(),
  impact: EventImpactSchema,
  scheduledAt: IsoDateTimeSchema,
  /** Instruments the provider/mapping marks as affected. Empty = unknown → treated as affecting all. */
  affectedInstruments: z.array(SymbolSchema).default([]),
  expected: z.string().optional(),
  previous: z.string().optional(),
  actual: z.string().optional(),
});
export type EconomicEvent = z.infer<typeof EconomicEventSchema>;

export const CalendarWindowSchema = z
  .object({
    /** The provider asserts completeness of events within [from, to]. */
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    events: z.array(EconomicEventSchema),
  })
  .refine((w) => Date.parse(w.to) > Date.parse(w.from), { message: 'to must be after from' });
export type CalendarWindow = z.infer<typeof CalendarWindowSchema>;

/** Unknown impact is treated as HIGH (fail-safe). */
export function effectiveImpact(impact: EventImpact): EventImpact {
  return impact === 'UNKNOWN' ? 'HIGH' : impact;
}

export function eventAffects(event: EconomicEvent, symbol: string): boolean {
  return event.affectedInstruments.length === 0 || event.affectedInstruments.includes(symbol);
}

/**
 * Whether an event affects one instrument, applying the currency mapping to an event the
 * provider did not map: an instrument without `eventCurrencies`, or an event without a currency,
 * is affected (fail-safe) — the rule `CalendarService` applies when it ingests a window.
 */
export function eventAffectsInstrument(
  event: EconomicEvent,
  symbol: string,
  eventCurrencies: readonly string[] | undefined,
): boolean {
  if (event.affectedInstruments.length > 0) return event.affectedInstruments.includes(symbol);
  if (event.currency === undefined || eventCurrencies === undefined) return true;
  return eventCurrencies.includes(event.currency.toUpperCase());
}

/** Event blackout rule: restricted impact levels and the window around each event. */
export interface BlackoutRule {
  readonly impactLevels: readonly EventImpact[];
  readonly minutesBefore: number;
  readonly minutesAfter: number;
}

export type BlackoutAssessment =
  | {
      /** The window does not cover [now − minutesAfter, now + minutesBefore]: unknown, not clear. */
      readonly state: 'UNCOVERED';
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly state: 'CLEAR' | 'BLACKOUT';
      readonly from: string;
      readonly to: string;
      /** Restricted events affecting the symbol inside [from, to]. */
      readonly blocking: EconomicEvent[];
      /** When the current blackout ends (latest blocking event + minutesAfter); null when clear. */
      readonly clearAt: string | null;
      /** The next restricted event after `to` inside the window, and when its blackout starts. */
      readonly next: { readonly event: EconomicEvent; readonly blackoutFrom: string } | null;
    };

/**
 * Whether `symbol` is inside an event blackout at `now`: any restricted event (UNKNOWN impact
 * counts as HIGH) affecting the symbol within [now − minutesAfter, now + minutesBefore]. The
 * window must cover that range, otherwise the answer is UNCOVERED (never "clear").
 */
export function assessBlackout(
  window: CalendarWindow,
  symbol: string,
  now: Date,
  rule: BlackoutRule,
  /** Latest entry time (a resting LIMIT order may fill until it expires); default: now. */
  until: Date = now,
): BlackoutAssessment {
  const t = now.getTime();
  const fromMs = t - rule.minutesAfter * 60_000;
  const toMs = Math.max(t, until.getTime()) + rule.minutesBefore * 60_000;
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  if (Date.parse(window.from) > fromMs || Date.parse(window.to) < toMs) {
    return { state: 'UNCOVERED', from, to };
  }
  const restricted = window.events
    .filter((e) => rule.impactLevels.includes(effectiveImpact(e.impact)) && eventAffects(e, symbol))
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const blocking = restricted.filter((e) => {
    const at = Date.parse(e.scheduledAt);
    return at >= fromMs && at <= toMs;
  });
  const upcoming = restricted.find((e) => Date.parse(e.scheduledAt) > toMs);
  const lastBlocking = blocking.at(-1);
  return {
    state: blocking.length > 0 ? 'BLACKOUT' : 'CLEAR',
    from,
    to,
    blocking,
    clearAt: lastBlocking
      ? new Date(Date.parse(lastBlocking.scheduledAt) + rule.minutesAfter * 60_000).toISOString()
      : null,
    next: upcoming
      ? {
          event: upcoming,
          blackoutFrom: new Date(
            Date.parse(upcoming.scheduledAt) - rule.minutesBefore * 60_000,
          ).toISOString(),
        }
      : null,
  };
}
