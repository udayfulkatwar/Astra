import { newId } from '@astra/core';
import type { PaperAccountState } from '@astra/execution';
import type { Sql } from '../client';
import { dedicatedClient, jsonb } from '../client';

/** Raised when this process is not (or no longer) the single DIRTY owner of the paper adapter. */
export class PaperOwnershipError extends Error {
  constructor(
    readonly code: 'BUSY' | 'LOST' | 'STALE',
    message: string,
  ) {
    super(message);
    this.name = 'PaperOwnershipError';
  }
}

export interface PaperFence {
  readonly sessionId: string;
  /** Strictly increasing per account within a session; an ACK means THIS revision is durable. */
  readonly revision: number;
}

export class PaperBrokerStateRepository {
  constructor(private readonly sql: Sql) {}

  async load(adapterId: string, accountRef: string): Promise<PaperAccountState | null> {
    return (await this.loadWithRevision(adapterId, accountRef))?.state ?? null;
  }

  async loadWithRevision(
    adapterId: string,
    accountRef: string,
  ): Promise<{ state: PaperAccountState; revision: number } | null> {
    const rows = await this.sql<{ state: PaperAccountState; revision: string }[]>`
      select state, revision from paper_broker_state
       where adapter_id = ${adapterId} and account_ref = ${accountRef}`;
    return rows[0] ? { state: rows[0].state, revision: Number(rows[0].revision) } : null;
  }

  /**
   * Durably saves an immutable snapshot at `fence.revision`. Resolves only when the row is
   * committed. In ONE transaction the owner row is locked FOR SHARE first (the same order as
   * acquire, markClean and the reserve/dispatch fence), so an ownership change either waits for
   * this save or is ordered before it and refuses it: a stale session can neither persist a
   * snapshot nor receive an ACK after replacement. Re-sending the same revision is an ACK only
   * when the stored content is IDENTICAL (an earlier acknowledgement may have been lost); the same
   * revision with different content, or an older one, is refused.
   */
  async save(
    adapterId: string,
    accountRef: string,
    state: PaperAccountState,
    at: string,
    fence: PaperFence,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const owner = await tx<{ session_id: string; state: string }[]>`
        select session_id, state from paper_owner where adapter_id = ${adapterId} for share`;
      if (owner[0]?.session_id !== fence.sessionId || owner[0]?.state !== 'DIRTY')
        throw new PaperOwnershipError('LOST', 'this process is not the DIRTY paper owner');
      const rows = await tx<{ revision: string }[]>`
        insert into paper_broker_state (adapter_id, account_ref, state, updated_at, revision, session_id)
        values (${adapterId}, ${accountRef}, ${jsonb(tx, state)}, ${at}, ${fence.revision}, ${fence.sessionId})
        on conflict (adapter_id, account_ref) do update
          set state = excluded.state, updated_at = excluded.updated_at,
              revision = excluded.revision, session_id = excluded.session_id
          where paper_broker_state.revision < excluded.revision
        returning revision`;
      if (rows.length > 0) return;
      const cur = await tx<{ revision: string; session_id: string | null; state: unknown }[]>`
        select revision, session_id, state from paper_broker_state
         where adapter_id = ${adapterId} and account_ref = ${accountRef}`;
      const c = cur[0];
      if (c && Number(c.revision) === fence.revision && c.session_id === fence.sessionId) {
        if (canonical(c.state) === canonical(state)) return; // identical content: a lost ACK, re-sent
        throw new PaperOwnershipError(
          'STALE',
          `paper snapshot revision ${fence.revision} is already stored with DIFFERENT content`,
        );
      }
      throw new PaperOwnershipError(
        'STALE',
        `paper snapshot revision ${fence.revision} is not newer than the stored ${c?.revision}`,
      );
    });
  }
}

/** Key-order-independent JSON (jsonb does not preserve key order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export type PaperPriorSession = 'NONE' | 'CLEAN' | 'UNCLEAN';

/** The live ownership of the paper adapter by this process. */
export class PaperOwnerSession {
  private lost: string | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly lock: Sql,
    readonly adapterId: string,
    readonly sessionId: string,
    readonly prior: PaperPriorSession,
    readonly priorSessionId: string | null,
    /** The ONE Postgres backend that holds the advisory lock; its identity is re-proved on verify. */
    readonly backendPid: number,
  ) {}

  /** Synchronous: set permanently once ownership was found gone; never cleared. */
  get ownerLost(): string | null {
    return this.lost;
  }

  /** Latches the loss. A later successful query on a RECONNECTED backend never revives it. */
  markLost(reason: string): void {
    this.lost ??= reason;
  }

  /**
   * Proves, now, that the ORIGINAL backend still holds the advisory lock (pid identity plus a
   * granted lock row for this key) and that the DIRTY row is still ours. Any failure latches.
   */
  async verify(): Promise<void> {
    if (this.lost) throw new PaperOwnershipError('LOST', this.lost);
    try {
      const held = await this.lock<{ ok: boolean }[]>`
        select (pg_backend_pid() = ${this.backendPid}
                and exists (select 1 from pg_locks l
                             where l.locktype = 'advisory' and l.granted and l.objsubid = 1
                               and l.pid = pg_backend_pid()
                               and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(current_schema() || ':paper-owner:' || ${this.adapterId}, 0))) as ok`;
      if (!held[0]?.ok)
        throw new Error('the original lock backend no longer holds the paper advisory lock');
      const rows = await this.sql<{ ok: boolean }[]>`
        select true as ok from paper_owner
         where adapter_id = ${this.adapterId} and session_id = ${this.sessionId} and state = 'DIRTY'`;
      if (!rows[0]) throw new Error('the DIRTY owner row is no longer ours');
    } catch (err) {
      this.markLost(`paper ownership lost: ${err instanceof Error ? err.message : String(err)}`);
      throw new PaperOwnershipError('LOST', this.lost!);
    }
  }

  /**
   * CLEAN only if the checkpoint account set is EXACTLY the stored snapshot account set and every
   * revision is the stored one, written by this session (a missing or extra row refuses). The
   * commit may succeed while its acknowledgement is lost: the next start verifies the same
   * checkpoints, so an uncertain outcome is never reported as certain either way.
   */
  async markClean(checkpoints: Readonly<Record<string, number>>, at: string): Promise<void> {
    await this.verify();
    await this.sql.begin(async (tx) => {
      const own = await tx<{ session_id: string; state: string }[]>`
        select session_id, state from paper_owner where adapter_id = ${this.adapterId} for update`;
      if (own[0]?.session_id !== this.sessionId || own[0].state !== 'DIRTY')
        throw new PaperOwnershipError('LOST', 'not the DIRTY owner at the CLEAN transition');
      const stored = await tx<
        { account_ref: string; revision: string; session_id: string | null }[]
      >`
        select account_ref, revision, session_id from paper_broker_state
         where adapter_id = ${this.adapterId}`;
      const refs = Object.keys(checkpoints);
      if (
        stored.length !== refs.length ||
        !refs.every((r) => stored.some((x) => x.account_ref === r))
      )
        throw new PaperOwnershipError(
          'STALE',
          `checkpoint accounts [${refs.sort().join(',')}] differ from stored snapshot accounts [${stored
            .map((x) => x.account_ref)
            .sort()
            .join(',')}]`,
        );
      for (const r of stored) {
        if (Number(r.revision) !== checkpoints[r.account_ref] || r.session_id !== this.sessionId)
          throw new PaperOwnershipError(
            'STALE',
            `checkpoint ${r.account_ref}@${checkpoints[r.account_ref]} is not the stored one`,
          );
      }
      await tx`
        update paper_owner set state = 'CLEAN', checkpoints = ${jsonb(tx, checkpoints)}, updated_at = ${at}
         where adapter_id = ${this.adapterId}`;
    });
  }

  async release(): Promise<void> {
    try {
      await this.lock.end({ timeout: 2 }); // the lock dies with its only connection
    } catch {
      // the connection is gone: the lock is gone with it
    }
  }
}

export class PaperOwnerRepository {
  constructor(private readonly sql: Sql) {}

  /**
   * Becomes the exclusive paper owner or throws. Takes the advisory lock on a pinned dedicated
   * connection (BUSY if another live process holds it), then commits the DIRTY session row. The
   * previous session counts as clean ONLY when a CLEAN row's checkpoints equal the stored
   * snapshots exactly; a DIRTY row, a mismatching/missing/extra snapshot, or legacy paper
   * evidence (snapshots, orders, reservations) with NO ownership record at all is UNCLEAN, and
   * EVERY listed account is quarantined with a ledger bump in the same transaction. Only a truly
   * empty install is NONE. Nothing may touch paper state before this resolves.
   */
  async acquire(p: {
    adapterId: string;
    sessionId: string;
    accountIds: readonly string[];
    at: string;
  }): Promise<PaperOwnerSession> {
    let session: PaperOwnerSession | null = null;
    let closedEarly = false;
    const lock = dedicatedClient(this.sql, 'astra-paper-owner', () => {
      if (session) session.markLost('the paper lock connection closed');
      else closedEarly = true;
    });
    try {
      const got = await lock<{ ok: boolean; pid: number }[]>`
        select pg_try_advisory_lock(hashtextextended(current_schema() || ':paper-owner:' || ${p.adapterId}, 0)) as ok,
               pg_backend_pid() as pid`;
      if (!got[0]?.ok)
        throw new PaperOwnershipError('BUSY', 'another live process owns the paper adapter');
      const { prior, priorSessionId } = await this.sql.begin(async (tx) => {
        const cur = await tx<
          { session_id: string; state: string; checkpoints: Record<string, number> }[]
        >`select session_id, state, checkpoints from paper_owner where adapter_id = ${p.adapterId} for update`;
        const row = cur[0];
        let prior: PaperPriorSession = 'NONE';
        let reason = '';
        if (row) {
          prior = row.state === 'CLEAN' ? 'CLEAN' : 'UNCLEAN';
          reason = `paper session ${row.session_id} did not end cleanly (state ${row.state}); recovery required — a stale snapshot cannot prove no mutation was lost`;
          if (prior === 'CLEAN') {
            const states = await tx<
              { account_ref: string; revision: string; session_id: string | null }[]
            >`select account_ref, revision, session_id from paper_broker_state where adapter_id = ${p.adapterId}`;
            const keys = Object.keys(row.checkpoints);
            const exact =
              states.length === keys.length &&
              states.every(
                (s) =>
                  keys.includes(s.account_ref) &&
                  Number(s.revision) === row.checkpoints[s.account_ref] &&
                  s.session_id === row.session_id,
              );
            if (!exact) {
              prior = 'UNCLEAN';
              reason = `paper session ${row.session_id} ended CLEAN but its checkpoints do not exactly match the stored snapshots (missing, extra or changed rows); recovery required`;
            }
          }
        } else {
          const ids = tx.array([...p.accountIds]);
          const legacy = await tx<{ legacy: boolean }[]>`
            select (exists (select 1 from paper_broker_state where adapter_id = ${p.adapterId})
                 or exists (select 1 from orders where adapter_id = ${p.adapterId} or account_id = any(${ids}))
                 or exists (select 1 from exposure_reservations where account_id = any(${ids}))) as legacy`;
          if (legacy[0]?.legacy) {
            prior = 'UNCLEAN';
            reason =
              'legacy paper state (snapshots/orders/reservations) exists with NO ownership record: a pre-R004 session cannot be proven clean; recovery required';
          }
        }
        if (prior === 'UNCLEAN') {
          for (const accountId of p.accountIds) {
            await tx`
              insert into account_exposure_ledger (account_id, version, updated_at)
              values (${accountId}, 0, ${p.at}) on conflict (account_id) do nothing`;
            await tx`select version from account_exposure_ledger where account_id = ${accountId} for update`;
            const dup = await tx`
              select 1 from exposure_quarantines
               where account_id = ${accountId} and reason = ${reason} and cleared_at is null`;
            if (dup.length === 0) {
              await tx`
                insert into exposure_quarantines (id, account_id, client_order_id, reason, evidence, created_at)
                values (${newId('quarantine')}, ${accountId}, null, ${reason},
                        ${jsonb(tx, { priorSession: row?.session_id ?? null, priorState: row?.state ?? null, checkpoints: row?.checkpoints ?? null })}, ${p.at})`;
              await tx`
                update account_exposure_ledger set version = version + 1, updated_at = ${p.at}
                 where account_id = ${accountId}`;
            }
          }
        }
        await tx`
          insert into paper_owner (adapter_id, session_id, state, checkpoints, started_at, updated_at)
          values (${p.adapterId}, ${p.sessionId}, 'DIRTY', '{}'::jsonb, ${p.at}, ${p.at})
          on conflict (adapter_id) do update
            set session_id = excluded.session_id, state = 'DIRTY', checkpoints = '{}'::jsonb,
                started_at = excluded.started_at, updated_at = excluded.updated_at`;
        return { prior, priorSessionId: row?.session_id ?? null };
      });
      session = new PaperOwnerSession(
        this.sql,
        lock,
        p.adapterId,
        p.sessionId,
        prior,
        priorSessionId,
        got[0].pid,
      );
      if (closedEarly) session.markLost('the paper lock connection closed during acquisition');
      return session;
    } catch (err) {
      await lock.end({ timeout: 2 }).catch(() => undefined);
      throw err;
    }
  }
}
