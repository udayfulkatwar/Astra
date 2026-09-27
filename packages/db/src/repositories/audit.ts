/**
 * Hash-chained, append-only audit log (spec §22). Each entry's hash covers the previous hash and
 * the canonical entry, so any alteration or removal of history is detectable by verifyChain().
 * Appends are serialised with a transaction-scoped advisory lock to keep the chain linear.
 */
import { canonicalJson, newId, sha256 } from '@astra/core';
import type { Queryable, Sql } from '../client';
import { iso, json, jsonb } from '../client';

export const AUDIT_GENESIS_HASH = 'sha256:genesis';
const AUDIT_LOCK_KEY = 0x4a57_2a01;

export type AuditActorType = 'HUMAN' | 'SYSTEM' | 'AUTOMATION';

export interface AuditEntryInput {
  readonly actor: { readonly type: AuditActorType; readonly id: string };
  readonly category: string;
  readonly action: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly payload: Record<string, unknown>;
  readonly at: string;
}

export interface AuditEntry {
  readonly seq: number;
  readonly id: string;
  readonly at: string;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly category: string;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Record<string, unknown>;
  readonly prevHash: string;
  readonly hash: string;
}

function entryHash(prevHash: string, e: Omit<AuditEntry, 'seq' | 'prevHash' | 'hash'>): string {
  return sha256(
    `${prevHash}\n${canonicalJson({
      id: e.id,
      at: e.at,
      actorType: e.actorType,
      actorId: e.actorId,
      category: e.category,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      payload: e.payload,
    })}`,
  );
}

interface AuditRow {
  seq: string;
  id: string;
  at: Date;
  actor_type: AuditActorType;
  actor_id: string;
  category: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

function mapRow(r: AuditRow): AuditEntry {
  return {
    seq: Number(r.seq),
    id: r.id,
    at: iso(r.at)!,
    actorType: r.actor_type,
    actorId: r.actor_id,
    category: r.category,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    payload: r.payload,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/** Appends within the caller's transaction (the advisory lock lasts until it commits). */
export async function appendAuditInTx(tx: Queryable, input: AuditEntryInput): Promise<AuditEntry> {
  await tx`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;
  const last = await tx<{ hash: string }[]>`select hash from audit_log order by seq desc limit 1`;
  const prevHash = last[0]?.hash ?? AUDIT_GENESIS_HASH;
  // Normalise through JSON so the hashed payload equals what the database returns later.
  const payload = JSON.parse(json(input.payload)) as Record<string, unknown>;
  const base = {
    id: newId('event'),
    at: new Date(input.at).toISOString(),
    actorType: input.actor.type,
    actorId: input.actor.id,
    category: input.category,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    payload,
  };
  const hash = entryHash(prevHash, base);
  const rows = await tx<AuditRow[]>`
    insert into audit_log (id, at, actor_type, actor_id, category, action, entity_type, entity_id, payload, prev_hash, hash)
    values (${base.id}, ${base.at}, ${base.actorType}, ${base.actorId}, ${base.category}, ${base.action},
            ${base.entityType}, ${base.entityId}, ${jsonb(tx, payload)}, ${prevHash}, ${hash})
    returning *`;
  return mapRow(rows[0]!);
}

export interface AuditQuery {
  readonly limit?: number;
  readonly beforeSeq?: number;
  readonly category?: string;
  readonly entityId?: string;
}

export class AuditRepository {
  constructor(private readonly sql: Sql) {}

  append(input: AuditEntryInput): Promise<AuditEntry> {
    return this.sql.begin((tx) => appendAuditInTx(tx, input));
  }

  async list(q: AuditQuery = {}): Promise<AuditEntry[]> {
    const limit = Math.min(q.limit ?? 100, 500);
    const rows = await this.sql<AuditRow[]>`
      select * from audit_log
      where (${q.beforeSeq ?? null}::bigint is null or seq < ${q.beforeSeq ?? null})
        and (${q.category ?? null}::text is null or category = ${q.category ?? null})
        and (${q.entityId ?? null}::text is null or entity_id = ${q.entityId ?? null})
      order by seq desc
      limit ${limit}`;
    return rows.map(mapRow);
  }

  /** Recomputes every hash in order. Any edit, deletion or reordering breaks the chain. */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null }> {
    let prev = AUDIT_GENESIS_HASH;
    let checked = 0;
    const cursor = this.sql<AuditRow[]>`select * from audit_log order by seq asc`.cursor(500);
    for await (const batch of cursor) {
      for (const row of batch) {
        const e = mapRow(row);
        if (e.prevHash !== prev || entryHash(prev, e) !== e.hash) {
          return { ok: false, checked, brokenAtSeq: e.seq };
        }
        prev = e.hash;
        checked++;
      }
    }
    return { ok: true, checked, brokenAtSeq: null };
  }
}
