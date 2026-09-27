/** Trade journal (append-only): one entry per closed trade, stored as recorded. */
import type { JournalEntry } from '@astra/journal';
import type { Sql } from '../client';
import { jsonb } from '../client';

export interface JournalQuery {
  readonly accountId?: string | undefined;
  readonly strategyId?: string | undefined;
  readonly symbol?: string | undefined;
  readonly limit?: number | undefined;
}

export class JournalRepository {
  constructor(private readonly sql: Sql) {}

  /** Records an entry once; returns false when the trade was already journaled. */
  async record(entry: JournalEntry, recordedAt: string): Promise<boolean> {
    const rows = await this.sql`
      insert into trade_journal
        (trade_id, account_id, strategy_id, symbol, outcome, closed_at, entry, recorded_at)
      values (${entry.tradeId}, ${entry.accountId}, ${entry.strategyId}, ${entry.symbol},
        ${entry.result.outcome}, ${entry.exit.at}, ${jsonb(this.sql, entry)}, ${recordedAt})
      on conflict (trade_id) do nothing
      returning trade_id`;
    return rows.length > 0;
  }

  /** Newest first. */
  async list(q: JournalQuery = {}): Promise<JournalEntry[]> {
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5_000);
    const rows = await this.sql<{ entry: JournalEntry }[]>`
      select entry from trade_journal
      where (${q.accountId ?? null}::text is null or account_id = ${q.accountId ?? null})
        and (${q.strategyId ?? null}::text is null or strategy_id = ${q.strategyId ?? null})
        and (${q.symbol ?? null}::text is null or symbol = ${q.symbol ?? null})
      order by closed_at desc, trade_id
      limit ${limit}`;
    return rows.map((r) => r.entry);
  }
}
