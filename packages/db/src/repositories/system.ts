/** System state (trading mode), events, heartbeats and config versions. */
import {
  AstraError,
  newId,
  type ComponentId,
  type HealthStatus,
  type TradingMode,
} from '@astra/core';
import type { Sql } from '../client';
import { iso, jsonb } from '../client';
import { appendAuditInTx, type AuditActorType } from './audit';

export interface ModeState {
  readonly mode: TradingMode;
  readonly version: number;
  readonly changedAt: string;
  readonly changedBy: string;
  readonly reason: string;
}

export class SystemStateRepository {
  constructor(private readonly sql: Sql) {}

  async get(): Promise<ModeState> {
    const rows = await this.sql<
      { mode: TradingMode; version: number; changed_at: Date; changed_by: string; reason: string }[]
    >`
      select mode, version, changed_at, changed_by, reason from system_state where id = 1`;
    const r = rows[0];
    if (!r) throw new AstraError('INTERNAL', 'system_state row missing');
    return {
      mode: r.mode,
      version: r.version,
      changedAt: iso(r.changed_at)!,
      changedBy: r.changed_by,
      reason: r.reason,
    };
  }

  /** Changes the mode with optimistic concurrency and an audit entry in the same transaction. */
  async setMode(params: {
    mode: TradingMode;
    actor: { type: AuditActorType; id: string };
    reason: string;
    expectedVersion: number;
    at: string;
  }): Promise<ModeState> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        {
          mode: TradingMode;
          version: number;
          changed_at: Date;
          changed_by: string;
          reason: string;
        }[]
      >`
        update system_state
           set mode = ${params.mode}, version = version + 1, changed_at = ${params.at},
               changed_by = ${`${params.actor.type}:${params.actor.id}`}, reason = ${params.reason}
         where id = 1 and version = ${params.expectedVersion}
        returning mode, version, changed_at, changed_by, reason`;
      const r = rows[0];
      if (!r)
        throw new AstraError('CONFLICT', 'trading mode was changed concurrently; reload and retry');
      await appendAuditInTx(tx, {
        actor: params.actor,
        category: 'SYSTEM',
        action: 'MODE_CHANGED',
        entityType: 'system_state',
        entityId: '1',
        payload: { mode: params.mode, reason: params.reason, version: r.version },
        at: params.at,
      });
      return {
        mode: r.mode,
        version: r.version,
        changedAt: iso(r.changed_at)!,
        changedBy: r.changed_by,
        reason: r.reason,
      };
    });
  }
}

export const EVENT_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export interface SystemEvent {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly level: EventLevel;
  readonly component: string;
  readonly type: string;
  readonly message: string;
  readonly accountId: string | null;
  readonly data: Record<string, unknown>;
}

export type SystemEventInput = Omit<SystemEvent, 'seq' | 'id' | 'accountId'> & {
  accountId?: string | null;
};

interface EventRow {
  seq: string;
  id: string;
  at: Date;
  level: EventLevel;
  component: string;
  type: string;
  message: string;
  account_id: string | null;
  data: Record<string, unknown>;
}

const mapEvent = (r: EventRow): SystemEvent => ({
  seq: Number(r.seq),
  id: r.id,
  at: iso(r.at)!,
  level: r.level,
  component: r.component,
  type: r.type,
  message: r.message,
  accountId: r.account_id,
  data: r.data,
});

export class EventRepository {
  constructor(private readonly sql: Sql) {}

  async append(e: SystemEventInput): Promise<SystemEvent> {
    const rows = await this.sql<EventRow[]>`
      insert into system_events (id, at, level, component, type, message, account_id, data)
      values (${newId('event')}, ${e.at}, ${e.level}, ${e.component}, ${e.type}, ${e.message},
              ${e.accountId ?? null}, ${jsonb(this.sql, e.data)})
      returning *`;
    return mapEvent(rows[0]!);
  }

  /**
   * Newest first by default. `order: 'asc'` returns the OLDEST events after `afterSeq` first, so a
   * poller that advances its cursor to the last seq it received never skips an event.
   */
  async recent(
    params: {
      limit?: number;
      afterSeq?: number;
      order?: 'asc' | 'desc';
      minLevel?: EventLevel;
    } = {},
  ): Promise<SystemEvent[]> {
    const limit = Math.min(params.limit ?? 100, 500);
    const levels = params.minLevel
      ? EVENT_LEVELS.slice(EVENT_LEVELS.indexOf(params.minLevel))
      : null;
    const after = params.afterSeq ?? null;
    const rows =
      params.order === 'asc'
        ? await this.sql<EventRow[]>`
            select * from system_events
            where (${after}::bigint is null or seq > ${after})
              and (${levels}::text[] is null or level = any(${levels}))
            order by seq asc limit ${limit}`
        : await this.sql<EventRow[]>`
            select * from system_events
            where (${after}::bigint is null or seq > ${after})
              and (${levels}::text[] is null or level = any(${levels}))
            order by seq desc limit ${limit}`;
    return rows.map(mapEvent);
  }
}

export interface Heartbeat {
  readonly component: ComponentId;
  readonly status: HealthStatus;
  readonly detail: string;
  readonly reportedAt: string;
  readonly reportedBy: string;
}

export class HeartbeatRepository {
  constructor(private readonly sql: Sql) {}

  async upsert(h: Heartbeat): Promise<void> {
    await this.sql`
      insert into component_heartbeats (component, status, detail, reported_at, reported_by)
      values (${h.component}, ${h.status}, ${h.detail}, ${h.reportedAt}, ${h.reportedBy})
      on conflict (component) do update
        set status = excluded.status, detail = excluded.detail,
            reported_at = excluded.reported_at, reported_by = excluded.reported_by`;
  }

  async list(): Promise<Heartbeat[]> {
    const rows = await this.sql<
      {
        component: ComponentId;
        status: HealthStatus;
        detail: string;
        reported_at: Date;
        reported_by: string;
      }[]
    >`
      select * from component_heartbeats`;
    return rows.map((r) => ({
      component: r.component,
      status: r.status,
      detail: r.detail,
      reportedAt: iso(r.reported_at)!,
      reportedBy: r.reported_by,
    }));
  }
}

export class ConfigVersionRepository {
  constructor(private readonly sql: Sql) {}

  async record(hash: string, canonical: string, at: string): Promise<void> {
    await this.sql`
      insert into config_versions (hash, content, first_loaded_at, last_loaded_at)
      values (${hash}, ${jsonb(this.sql, JSON.parse(canonical))}, ${at}, ${at})
      on conflict (hash) do update set last_loaded_at = excluded.last_loaded_at`;
  }
}
