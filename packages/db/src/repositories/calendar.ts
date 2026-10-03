/** Accepted economic-calendar windows as observed. Append-only so restart can restore context honestly. */
import {
  CalendarWindowSchema,
  DataSourceKindSchema,
  type CalendarWindow,
  type ObservedOk,
} from '@astra/core';
import type { Sql } from '../client';
import { iso, jsonb } from '../client';

interface Row {
  source: string;
  source_kind: string;
  as_of: Date;
  window: unknown;
}

export class CalendarRepository {
  constructor(private readonly sql: Sql) {}

  async record(observation: ObservedOk<CalendarWindow>): Promise<void> {
    await this.sql`
      insert into calendar_windows (source, source_kind, as_of, from_at, to_at, window)
      values (${observation.source}, ${observation.sourceKind}, ${observation.asOf},
        ${observation.value.from}, ${observation.value.to}, ${jsonb(this.sql, observation.value)})`;
  }

  /**
   * Latest valid accepted window whose asserted coverage overlaps [from, to]. The persisted
   * observation timestamp is returned unchanged; callers must apply normal freshness rules after
   * restore. Malformed rows are skipped, never repaired; `onInvalid` is told about each one.
   */
  async latestOverlapping(
    from: string,
    to: string,
    onInvalid?: (reason: string) => void,
  ): Promise<ObservedOk<CalendarWindow> | null> {
    const rows = await this.sql<Row[]>`
      select source, source_kind, as_of, window
        from calendar_windows
       where to_at >= ${from} and from_at <= ${to}
       order by as_of desc, id desc
       limit 50`;
    for (const row of rows) {
      const window = CalendarWindowSchema.safeParse(row.window);
      const kind = DataSourceKindSchema.safeParse(row.source_kind);
      if (!window.success || !kind.success) {
        onInvalid?.(`stored calendar window from ${row.source} is malformed`);
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
