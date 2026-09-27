/**
 * Event risk per instrument — the blackout assessment the gate's `calendar.event-blackout` check
 * makes, as a read model for the operator. A non-OK or uncovering calendar is UNKNOWN, never clear.
 */
import {
  assessBlackout,
  describeNotOk,
  type BlackoutRule,
  type CalendarWindow,
  type DataSourceKind,
  type EconomicEvent,
  type Observed,
} from '@astra/core';
import type { PollerStatus } from './poller';

export type InstrumentEventRisk =
  | { readonly symbol: string; readonly state: 'UNKNOWN'; readonly reason: string }
  | {
      readonly symbol: string;
      readonly state: 'CLEAR' | 'BLACKOUT';
      readonly reason: string;
      readonly blocking: EconomicEvent[];
      readonly clearAt: string | null;
      readonly next: { readonly event: EconomicEvent; readonly blackoutFrom: string } | null;
    };

export interface EventRiskView {
  readonly now: string;
  readonly rule: BlackoutRule;
  readonly calendar:
    | {
        readonly status: 'OK';
        readonly source: string;
        readonly sourceKind: DataSourceKind;
        readonly asOf: string;
        readonly from: string;
        readonly to: string;
      }
    | {
        readonly status: Exclude<Observed<CalendarWindow>['status'], 'OK'>;
        readonly reason: string;
      };
  readonly poller: PollerStatus | null;
  readonly instruments: InstrumentEventRisk[];
}

export function eventRiskView(input: {
  /** The calendar with freshness applied. */
  readonly calendar: Observed<CalendarWindow>;
  readonly symbols: readonly string[];
  readonly now: Date;
  readonly rule: BlackoutRule;
  readonly poller?: PollerStatus | null | undefined;
}): EventRiskView {
  const w = input.calendar;
  const instruments = input.symbols.map((symbol): InstrumentEventRisk => {
    if (w.status !== 'OK') {
      return { symbol, state: 'UNKNOWN', reason: describeNotOk('economic calendar', w) };
    }
    const a = assessBlackout(w.value, symbol, input.now, input.rule);
    if (a.state === 'UNCOVERED') {
      return {
        symbol,
        state: 'UNKNOWN',
        reason: `the calendar (${w.value.from} → ${w.value.to}) does not cover ${a.from} → ${a.to}`,
      };
    }
    return {
      symbol,
      state: a.state,
      reason:
        a.state === 'BLACKOUT'
          ? a.blocking.map((e) => `${e.impact} "${e.title}" at ${e.scheduledAt}`).join('; ')
          : 'no restricted event near',
      blocking: a.blocking,
      clearAt: a.clearAt,
      next: a.next,
    };
  });
  return {
    now: input.now.toISOString(),
    rule: input.rule,
    calendar:
      w.status === 'OK'
        ? {
            status: 'OK',
            source: w.source,
            sourceKind: w.sourceKind,
            asOf: w.asOf,
            from: w.value.from,
            to: w.value.to,
          }
        : { status: w.status, reason: describeNotOk('economic calendar', w) },
    poller: input.poller ?? null,
    instruments,
  };
}
