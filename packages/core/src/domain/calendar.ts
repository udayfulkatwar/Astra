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
