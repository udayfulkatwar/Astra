/** Read-only aggregates for daily / weekly reports (numbers come from the records, never estimated). */
import type { JournalEntry } from '@astra/journal';
import type { Sql } from '../client';
import { iso } from '../client';
import type { EventLevel } from './system';

export interface DecisionStats {
  readonly approved: number;
  readonly rejected: number;
  /** Mandatory checks that failed (or were unknown) in rejected decisions, most frequent first. */
  readonly topRejectChecks: readonly { readonly check: string; readonly count: number }[];
}

export interface EventStats {
  readonly warn: number;
  readonly error: number;
  readonly critical: number;
  /** Latest ERROR / CRITICAL events, newest first. */
  readonly incidents: readonly {
    readonly at: string;
    readonly level: EventLevel;
    readonly component: string;
    readonly message: string;
  }[];
}

export interface AiStats {
  readonly sent: number;
  readonly blocked: number;
  readonly failed: number;
  readonly costUsd: number;
  readonly analyses: number;
  readonly reviews: number;
}

export class ReportRepository {
  constructor(private readonly sql: Sql) {}

  /** Journal entries whose trade closed in [from, to), oldest first. */
  async journal(accountId: string, from: string, to: string): Promise<JournalEntry[]> {
    const rows = await this.sql<{ entry: JournalEntry }[]>`
      select entry from trade_journal
       where account_id = ${accountId} and closed_at >= ${from} and closed_at < ${to}
       order by closed_at, trade_id`;
    return rows.map((r) => r.entry);
  }

  async decisions(accountId: string, from: string, to: string, top = 5): Promise<DecisionStats> {
    const [counts] = await this.sql<{ approved: number; rejected: number }[]>`
      select count(*) filter (where status = 'APPROVED')::int as approved,
             count(*) filter (where status = 'REJECTED')::int as rejected
        from trade_decisions
       where account_id = ${accountId} and decided_at >= ${from} and decided_at < ${to}`;
    const checks = await this.sql<{ check: string; count: number }[]>`
      select c->>'checkId' as check, count(distinct d.id)::int as count
        from trade_decisions d, jsonb_array_elements(d.checks) c
       where d.account_id = ${accountId} and d.decided_at >= ${from} and d.decided_at < ${to}
         and d.status = 'REJECTED' and (c->>'mandatory')::boolean and c->>'verdict' <> 'PASS'
       group by 1 order by 2 desc, 1 limit ${top}`;
    return {
      approved: counts?.approved ?? 0,
      rejected: counts?.rejected ?? 0,
      topRejectChecks: checks.map((c) => ({ check: c.check, count: c.count })),
    };
  }

  async events(from: string, to: string, incidents = 10): Promise<EventStats> {
    const [counts] = await this.sql<{ warn: number; error: number; critical: number }[]>`
      select count(*) filter (where level = 'WARN')::int as warn,
             count(*) filter (where level = 'ERROR')::int as error,
             count(*) filter (where level = 'CRITICAL')::int as critical
        from system_events where at >= ${from} and at < ${to}`;
    const rows = await this.sql<
      { at: Date; level: EventLevel; component: string; message: string }[]
    >`
      select at, level, component, message from system_events
       where at >= ${from} and at < ${to} and level in ('ERROR', 'CRITICAL')
       order by seq desc limit ${incidents}`;
    return {
      warn: counts?.warn ?? 0,
      error: counts?.error ?? 0,
      critical: counts?.critical ?? 0,
      incidents: rows.map((r) => ({
        at: iso(r.at)!,
        level: r.level,
        component: r.component,
        message: r.message,
      })),
    };
  }

  async ai(from: string, to: string): Promise<AiStats> {
    const [calls] = await this.sql<
      { sent: number; blocked: number; failed: number; cost: string | null }[]
    >`
      select count(*) filter (where status <> 'BLOCKED')::int as sent,
             count(*) filter (where status = 'BLOCKED')::int as blocked,
             count(*) filter (where status not in ('OK', 'BLOCKED'))::int as failed,
             sum(cost_usd) as cost
        from ai_model_calls where started_at >= ${from} and started_at < ${to}`;
    const [made] = await this.sql<{ analyses: number; reviews: number }[]>`
      select (select count(*) from ai_analyses
                where produced_at >= ${from} and produced_at < ${to})::int as analyses,
             (select count(*) from ai_reviews
                where produced_at >= ${from} and produced_at < ${to})::int as reviews`;
    return {
      sent: calls?.sent ?? 0,
      blocked: calls?.blocked ?? 0,
      failed: calls?.failed ?? 0,
      costUsd: Number(calls?.cost ?? 0) + 0,
      analyses: made?.analyses ?? 0,
      reviews: made?.reviews ?? 0,
    };
  }
}
