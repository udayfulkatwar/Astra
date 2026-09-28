/**
 * The operator's view of news context per instrument (spec §19): news risk as the gate would see
 * it now, provider sentiment, the calendar blackout state, and the combined one-line context.
 * Read model only — nothing here feeds a decision except through the gate's own checks.
 */
import { describeNotOk, type DataSourceKind, type NewsRiskLevel } from '@astra/core';
import type { NewsPollerStatus } from './poller';
import { combinedContext, type SentimentView } from './risk';
import type { NewsFeedStatus, NewsService } from './service';

export type CalendarState = 'CLEAR' | 'BLACKOUT' | 'UNKNOWN';

export interface InstrumentNewsContext {
  readonly symbol: string;
  readonly risk:
    | {
        readonly status: 'OK';
        readonly level: NewsRiskLevel;
        readonly reasons: string[];
        readonly clearsAt: string | null;
        readonly sourceKind: DataSourceKind;
      }
    | { readonly status: 'UNKNOWN'; readonly reason: string };
  readonly sentiment: SentimentView;
  readonly calendar: CalendarState;
  readonly combined: string;
}

export interface NewsContextView {
  readonly now: string;
  readonly feed: NewsFeedStatus & { readonly health: { status: string; detail: string } };
  readonly poller: NewsPollerStatus | null;
  readonly instruments: InstrumentNewsContext[];
}

export function newsContextView(input: {
  readonly service: NewsService;
  readonly symbols: readonly string[];
  readonly now: Date;
  readonly calendarState: (symbol: string) => CalendarState;
  readonly poller?: NewsPollerStatus | null | undefined;
}): NewsContextView {
  const instruments = input.symbols.map((symbol): InstrumentNewsContext => {
    const r = input.service.freshRisk(symbol);
    const sentiment = input.service.sentiment(symbol);
    const calendar = input.calendarState(symbol);
    const risk: InstrumentNewsContext['risk'] =
      r.status === 'OK'
        ? {
            status: 'OK',
            level: r.value.level,
            reasons: r.value.reasons,
            clearsAt: r.value.clearsAt ?? null,
            sourceKind: r.sourceKind,
          }
        : { status: 'UNKNOWN', reason: describeNotOk('news risk', r) };
    return {
      symbol,
      risk,
      sentiment,
      calendar,
      combined: combinedContext(
        sentiment.label,
        risk.status === 'OK' ? risk.level : 'UNKNOWN',
        calendar,
      ),
    };
  });
  return {
    now: input.now.toISOString(),
    feed: { ...input.service.feedStatus(), health: input.service.health() },
    poller: input.poller ?? null,
    instruments,
  };
}
