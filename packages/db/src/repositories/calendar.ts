/** Accepted economic-calendar windows as observed. Append-only so restart can restore context honestly. */
import {
  CalendarWindowSchema,
  DataSourceKindSchema,
  firstDuplicateEventId,
  type CalendarWindow,
  type ObservedOk,
} from '@astra/core';
import type { Sql } from '../client';
import { iso, jsonb } from '../client';

interface Row {
  source: string;
  source_kind: string;
  as_of: Date;
  window_payload: unknown;
}

export class CalendarRepository {
  constructor(private readonly sql: Sql) {}

  async record(observation: ObservedOk<CalendarWindow>): Promise<void> {
    await this.sql`
      insert into calendar_windows (source, source_kind, as_of, from_at, to_at, window_payload)
      values (${observation.source}, ${observation.sourceKind}, ${observation.asOf},
        ${observation.value.from}, ${observation.value.to}, ${jsonb(this.sql, observation.value)})`;
  }

  /**
   * Latest valid accepted window whose asserted coverage overlaps [from, to]. The persisted
   * observation timestamp is returned unchanged; callers must apply normal freshness rules after
   * restore. A row that is malformed OR semantically invalid (duplicate event ids, which
   * `CalendarService` also rejects) is skipped so an older valid row is still restored rather than
   * the newest one aborting the whole restore; `onInvalid` is told about each skipped row.
   */
  async latestOverlapping(
    from: string,
    to: string,
    onInvalid?: (reason: string) => void,
  ): Promise<ObservedOk<CalendarWindow> | null> {
    const rows = await this.sql<Row[]>`
      select source, source_kind, as_of, window_payload
        from calendar_windows
       where to_at >= ${from} and from_at <= ${to}
       order by as_of desc, id desc
       limit 50`;
    for (const row of rows) {
      const window = CalendarWindowSchema.safeParse(row.window_payload);
      const kind = DataSourceKindSchema.safeParse(row.source_kind);
      if (!window.success || !kind.success) {
        onInvalid?.(`stored calendar window from ${row.source} is malformed`);
        continue;
      }
      const duplicate = firstDuplicateEventId(window.data.events);
      if (duplicate !== undefined) {
        onInvalid?.(`stored calendar window from ${row.source} repeats event id ${duplicate}`);
        continue;
      }
      return {
        status: 'OK',
        value: window.data,
        source: row.source,
        sourceKind: kind.data,
        asOf: iso(row.as_of)!,
      };
    }
    return null;
  }
}
