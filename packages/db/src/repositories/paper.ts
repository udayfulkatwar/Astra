import type { PaperAccountState } from '@astra/execution';
import type { Sql } from '../client';
import { jsonb } from '../client';

export class PaperBrokerStateRepository {
  constructor(private readonly sql: Sql) {}

  async load(adapterId: string, accountRef: string): Promise<PaperAccountState | null> {
    const rows = await this.sql<{ state: PaperAccountState }[]>`
      select state from paper_broker_state where adapter_id = ${adapterId} and account_ref = ${accountRef}`;
    return rows[0]?.state ?? null;
  }

  async save(
    adapterId: string,
    accountRef: string,
    state: PaperAccountState,
    at: string,
  ): Promise<void> {
    await this.sql`
      insert into paper_broker_state (adapter_id, account_ref, state, updated_at)
      values (${adapterId}, ${accountRef}, ${jsonb(this.sql, state)}, ${at})
      on conflict (adapter_id, account_ref) do update set state = excluded.state, updated_at = excluded.updated_at`;
  }
}
