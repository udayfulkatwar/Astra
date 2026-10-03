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
   * Latest accepted window whose asserted coverage overlaps [from, to]. The persisted observation
   * timestamp is returned unchanged; callers must apply normal freshness rules after restore.
   */
  async latestOverlapping(from: string, to: string): Promise<ObservedOk<CalendarWindow> | null> {
    const [row] = await this.sql<Row[]>`
      select source, source_kind, as_of, window
        from calendar_windows
       where to_at >= ${from} and from_at <= ${to}
       order by as_of desc, id desc
       limit 1`;
    if (!row) return null;
    return {
      status: 'OK',
      value: CalendarWindowSchema.parse(row.window),
      source: row.source,
      sourceKind: DataSourceKindSchema.parse(row.source_kind),
      asOf: iso(row.as_of)!,
    };
  }
}
