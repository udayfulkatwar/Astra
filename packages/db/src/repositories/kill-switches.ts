/** Kill-switch persistence: current state + append-only history + audit, atomically. */
import type { KillSwitchChange, KillSwitchState } from '@astra/safety';
import type { Sql } from '../client';
import { iso } from '../client';
import { appendAuditInTx } from './audit';

interface Row {
  scope: KillSwitchState['scope'];
  target: string;
  active: boolean;
  reason: string;
  changed_by_type: 'HUMAN' | 'SYSTEM';
  changed_by_id: string;
  changed_at: Date;
  clear_policy: KillSwitchState['clearPolicy'];
  auto_clear_at: Date | null;
}

const ALL = '*';

export class KillSwitchRepository {
  constructor(private readonly sql: Sql) {}

  async loadAll(): Promise<KillSwitchState[]> {
    const rows = await this.sql<Row[]>`select * from kill_switches`;
    return rows.map((r) => ({
      scope: r.scope,
      target: r.target === ALL ? null : r.target,
      active: r.active,
      reason: r.reason,
      changedBy: { type: r.changed_by_type, id: r.changed_by_id },
      changedAt: iso(r.changed_at)!,
      clearPolicy: r.clear_policy,
      autoClearAt: iso(r.auto_clear_at),
    }));
  }

  async persist(change: KillSwitchChange): Promise<void> {
    const s = change.next;
    const target = s.target ?? ALL;
    await this.sql.begin(async (tx) => {
      await tx`
        insert into kill_switches (scope, target, active, reason, changed_by_type, changed_by_id, changed_at, clear_policy, auto_clear_at)
        values (${s.scope}, ${target}, ${s.active}, ${s.reason}, ${s.changedBy.type}, ${s.changedBy.id},
                ${s.changedAt}, ${s.clearPolicy}, ${s.autoClearAt})
        on conflict (scope, target) do update set
          active = excluded.active, reason = excluded.reason, changed_by_type = excluded.changed_by_type,
          changed_by_id = excluded.changed_by_id, changed_at = excluded.changed_at,
          clear_policy = excluded.clear_policy, auto_clear_at = excluded.auto_clear_at`;
      await tx`
        insert into kill_switch_events (at, scope, target, active, reason, changed_by_type, changed_by_id, clear_policy, auto_clear_at)
        values (${s.changedAt}, ${s.scope}, ${target}, ${s.active}, ${s.reason}, ${s.changedBy.type},
                ${s.changedBy.id}, ${s.clearPolicy}, ${s.autoClearAt})`;
      await appendAuditInTx(tx, {
        actor: s.changedBy,
        category: 'KILL_SWITCH',
        action: s.active ? 'ACTIVATED' : 'DEACTIVATED',
        entityType: 'kill_switch',
        entityId: `${s.scope}:${target}`,
        payload: { ...s, previous: change.previous },
        at: s.changedAt,
      });
    });
  }
}
