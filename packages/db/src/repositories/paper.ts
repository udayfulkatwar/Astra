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
   * committed. Refuses (throws) when the caller's session is not the DIRTY owner or a newer
   * revision is already stored; re-sending the same revision of the same session is idempotent
   * (the acknowledgement of an earlier attempt may have been lost).
   */
  async save(
    adapterId: string,
    accountRef: string,
    state: PaperAccountState,
    at: string,
    fence: PaperFence,
  ): Promise<void> {
    const rows = await this.sql<{ revision: string }[]>`
      insert into paper_broker_state (adapter_id, account_ref, state, updated_at, revision, session_id)
      select ${adapterId}, ${accountRef}, ${jsonb(this.sql, state)}, ${at}, ${fence.revision}, ${fence.sessionId}
       where exists (select 1 from paper_owner
                      where adapter_id = ${adapterId} and session_id = ${fence.sessionId}
                        and state = 'DIRTY')
      on conflict (adapter_id, account_ref) do update
        set state = excluded.state, updated_at = excluded.updated_at,
            revision = excluded.revision, session_id = excluded.session_id
        where paper_broker_state.revision < excluded.revision
      returning revision`;
    if (rows.length > 0) return;
    const cur = await this.sql<{ revision: string; session_id: string | null }[]>`
      select revision, session_id from paper_broker_state
       where adapter_id = ${adapterId} and account_ref = ${accountRef}`;
    if (
      cur[0] &&
      Number(cur[0].revision) === fence.revision &&
      cur[0].session_id === fence.sessionId
    )
      return; // an earlier attempt of the same revision was committed
    const owner = await this.sql<{ session_id: string; state: string }[]>`
      select session_id, state from paper_owner where adapter_id = ${adapterId}`;
    if (owner[0]?.session_id !== fence.sessionId || owner[0]?.state !== 'DIRTY')
      throw new PaperOwnershipError('LOST', 'this process is not the DIRTY paper owner');
    throw new PaperOwnershipError(
      'STALE',
      `paper snapshot revision ${fence.revision} is not newer than the stored ${cur[0]?.revision}`,
    );
  }
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
    /** Postgres backend holding the advisory lock (diagnostics / crash tests). */
    readonly backendPid: number,
  ) {}

  /** Synchronous: true until a check or a fenced write proved ownership gone. */
  get ownerLost(): string | null {
    return this.lost;
  }

  markLost(reason: string): void {
    this.lost ??= reason;
  }

  /** Proves, now, that the lock connection is alive and the DIRTY row is still ours. */
  async verify(): Promise<void> {
    if (this.lost) throw new PaperOwnershipError('LOST', this.lost);
    try {
      await this.lock`select 1`;
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
   * CLEAN only if every checkpoint revision is the stored one, written by this session. The
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
      for (const [ref, revision] of Object.entries(checkpoints)) {
        const r = await tx<{ revision: string; session_id: string | null }[]>`
          select revision, session_id from paper_broker_state
           where adapter_id = ${this.adapterId} and account_ref = ${ref}`;
        if (!r[0] || Number(r[0].revision) !== revision || r[0].session_id !== this.sessionId)
          throw new PaperOwnershipError(
            'STALE',
            `checkpoint ${ref}@${revision} is not the stored one`,
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
   * Becomes the exclusive paper owner or throws. Takes the advisory lock on a dedicated
   * connection (BUSY if another live process holds it), then commits the DIRTY session row. When
   * the previous session did not end CLEAN with matching checkpoints, EVERY listed account gets
   * an active quarantine and a ledger bump in the same transaction. Nothing may touch paper
   * state before this resolves.
   */
  async acquire(p: {
    adapterId: string;
    sessionId: string;
    accountIds: readonly string[];
    at: string;
  }): Promise<PaperOwnerSession> {
    const reserved = dedicatedClient(this.sql, 'astra-paper-owner');
    try {
      const got = await reserved<{ ok: boolean; pid: number }[]>`
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
        if (row) {
          prior = row.state === 'CLEAN' ? 'CLEAN' : 'UNCLEAN';
          if (prior === 'CLEAN') {
            const states = await tx<
              { account_ref: string; revision: string; session_id: string | null }[]
            >`
              select account_ref, revision, session_id from paper_broker_state where adapter_id = ${p.adapterId}`;
            const ok = states.every(
              (s) =>
                row.checkpoints[s.account_ref] !== undefined &&
                Number(s.revision) === row.checkpoints[s.account_ref] &&
                s.session_id === row.session_id,
            );
            if (!ok) prior = 'UNCLEAN';
          }
        }
        if (prior === 'UNCLEAN') {
          const reason = `paper session ${row!.session_id} did not end cleanly (state ${row!.state}); recovery required — a stale snapshot cannot prove no mutation was lost`;
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
                        ${jsonb(tx, { priorSession: row!.session_id, priorState: row!.state, checkpoints: row!.checkpoints })}, ${p.at})`;
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
      return new PaperOwnerSession(
        this.sql,
        reserved,
        p.adapterId,
        p.sessionId,
        prior,
        priorSessionId,
        got[0].pid,
      );
    } catch (err) {
      await reserved.end({ timeout: 2 }).catch(() => undefined);
      throw err;
    }
  }
}
