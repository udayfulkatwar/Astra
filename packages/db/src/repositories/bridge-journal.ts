import { payloadHash, commandClass, BridgeOwnerError } from '@astra/execution';
import type {
  BeginOutcome,
  BridgeCommand,
  BridgeJournal,
  Fence,
  JournalRecord,
  JournalState,
  MarkerGuard,
  OwnerState,
  StoredResult,
  TakeoverEvidence,
} from '@astra/execution';
import type { Queryable, Sql } from '../client';
import { jsonb } from '../client';

interface CommandRow {
  account_ref: string;
  command_id: string;
  op: BridgeCommand['op'];
  cls: 'ENTRY' | 'PROTECTIVE';
  payload_hash: string;
  command: BridgeCommand;
  state: JournalState;
  result: StoredResult | null;
  owner_id: string;
  epoch: string;
}

const toRecord = (r: CommandRow): JournalRecord => ({
  accountRef: r.account_ref,
  commandId: r.command_id,
  op: r.op,
  cls: r.cls,
  payloadHash: r.payload_hash,
  command: r.command,
  state: r.state,
  result: r.result,
  ownerId: r.owner_id,
  epoch: String(r.epoch),
});

/**
 * PostgreSQL implementation of the offline bridge journal. Every promise resolves only after the
 * transaction COMMITS. Fence checks happen INSIDE the transaction, with the owner row locked, so an
 * ownership change is ordered before or after a write, never between the check and the write.
 */
export class PgBridgeJournal implements BridgeJournal {
  constructor(private readonly sql: Sql) {}

  async acquireOwner(accountRef: string, ownerId: string): Promise<Fence> {
    const rows = await this.sql<{ epoch: string }[]>`
      insert into bridge_owner (account_ref, owner_id, epoch, reconcile_required, updated_at)
      values (${accountRef}, ${ownerId}, 1, false, now())
      on conflict (account_ref) do nothing
      returning epoch`;
    if (!rows[0])
      throw new BridgeOwnerError('BUSY', 'account already has an owner (no handoff by expiry)');
    return { accountRef, ownerId, epoch: String(rows[0].epoch) };
  }

  async takeover(
    accountRef: string,
    newOwnerId: string,
    evidence: TakeoverEvidence,
  ): Promise<Fence> {
    if (!(evidence.oldWriterCannotAct as boolean) || evidence.note.trim() === '') {
      throw new BridgeOwnerError(
        'BUSY',
        'takeover requires explicit evidence that the old writer cannot act',
      );
    }
    const rows = await this.sql<{ epoch: string }[]>`
      update bridge_owner
         set owner_id = ${newOwnerId}, epoch = epoch + 1, reconcile_required = true,
             takeover_note = ${evidence.note}, updated_at = now()
       where account_ref = ${accountRef}
      returning epoch`;
    if (!rows[0]) throw new BridgeOwnerError('NO_OWNER', 'no owner to take over from');
    return { accountRef, ownerId: newOwnerId, epoch: String(rows[0].epoch) };
  }

  async completeReconcile(accountRef: string, fence: Fence): Promise<void> {
    await this.sql.begin(async (tx) => {
      await this.checkFence(tx, accountRef, fence, 'update');
      await tx`update bridge_owner set reconcile_required = false, updated_at = now()
                where account_ref = ${accountRef}`;
    });
  }

  async ownerState(accountRef: string): Promise<OwnerState | null> {
    const rows = await this.sql<{ owner_id: string; epoch: string; reconcile_required: boolean }[]>`
      select owner_id, epoch, reconcile_required from bridge_owner where account_ref = ${accountRef}`;
    const r = rows[0];
    return r
      ? { ownerId: r.owner_id, epoch: String(r.epoch), reconcileRequired: r.reconcile_required }
      : null;
  }

  async begin(fence: Fence, command: BridgeCommand): Promise<BeginOutcome> {
    const hash = payloadHash(command);
    return this.sql.begin(async (tx) => {
      // FOR UPDATE serialises every intent of this account.
      await this.checkFence(tx, command.accountRef, fence, 'update');
      const inserted = await tx<CommandRow[]>`
        insert into bridge_command
          (account_ref, command_id, op, cls, payload_hash, command, state, owner_id, epoch, created_at, updated_at)
        values (${command.accountRef}, ${command.commandId}, ${command.op}, ${commandClass(command)},
                ${hash}, ${jsonb(tx, command)}, 'INTENT', ${fence.ownerId}, ${fence.epoch}, now(), now())
        on conflict (account_ref, command_id) do nothing
        returning *`;
      if (inserted[0]) return { kind: 'NEW', record: toRecord(inserted[0]) } as const;
      const existing = await tx<CommandRow[]>`
        select * from bridge_command
         where account_ref = ${command.accountRef} and command_id = ${command.commandId}`;
      const row = existing[0];
      if (!row) throw new Error('bridge_command row vanished');
      return row.payload_hash === hash
        ? ({ kind: 'REPLAY', record: toRecord(row) } as const)
        : ({ kind: 'CONFLICT' } as const);
    });
  }

  async markSendMayHaveStarted(
    fence: Fence,
    accountRef: string,
    commandId: string,
    guard: MarkerGuard,
  ): Promise<'WON' | 'LOST_RACE' | 'ENTRY_BLOCKED'> {
    return this.sql.begin(async (tx) => {
      const owner = await this.checkFence(tx, accountRef, fence, 'share');
      // ENTRY commands are additionally guarded INSIDE the atomic step: current reconcile state and
      // expiry at the caller's fresh instant. Protective commands are never blocked by these.
      const rows = await tx<{ command_id: string }[]>`
        update bridge_command set state = 'SEND_MAY_HAVE_STARTED', updated_at = now()
         where account_ref = ${accountRef} and command_id = ${commandId} and state = 'INTENT'
           and not (cls = 'ENTRY' and (${owner.reconcile_required}
                    or (command->>'expiresAt')::timestamptz <= ${guard.nowIso}::timestamptz))
        returning command_id`;
      if (rows.length === 1) return 'WON' as const;
      const cur = await tx<{ state: string; cls: string }[]>`
        select state, cls from bridge_command where account_ref = ${accountRef} and command_id = ${commandId}`;
      return cur[0]?.state === 'INTENT' && cur[0].cls === 'ENTRY'
        ? ('ENTRY_BLOCKED' as const)
        : ('LOST_RACE' as const);
    });
  }

  async recordResult(
    fence: Fence,
    accountRef: string,
    commandId: string,
    state: 'RESOLVED' | 'UNKNOWN',
    result: StoredResult,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      await this.checkFence(tx, accountRef, fence, 'share');
      const rows = await tx<{ command_id: string }[]>`
        update bridge_command set state = ${state}, result = ${jsonb(tx, result)}, updated_at = now()
         where account_ref = ${accountRef} and command_id = ${commandId}
           and state = 'SEND_MAY_HAVE_STARTED'
        returning command_id`;
      if (rows.length !== 1) throw new Error('result refused: command is not awaiting a result');
    });
  }

  async refuse(fence: Fence, accountRef: string, commandId: string, note: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await this.checkFence(tx, accountRef, fence, 'share');
      const rows = await tx<{ command_id: string }[]>`
        update bridge_command set state = 'REFUSED', result = ${jsonb(tx, { transport: null, note })},
               updated_at = now()
         where account_ref = ${accountRef} and command_id = ${commandId} and state = 'INTENT'
        returning command_id`;
      if (rows.length !== 1) throw new Error('refuse failed: command is not an unsent intent');
    });
  }

  async get(accountRef: string, commandId: string): Promise<JournalRecord | null> {
    const rows = await this.sql<CommandRow[]>`
      select * from bridge_command where account_ref = ${accountRef} and command_id = ${commandId}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async pendingProtective(accountRef: string): Promise<JournalRecord[]> {
    const rows = await this.sql<CommandRow[]>`
      select * from bridge_command
       where account_ref = ${accountRef} and state = 'INTENT' and cls = 'PROTECTIVE'
       order by created_at, command_id`;
    return rows.map(toRecord);
  }

  private async checkFence(
    tx: Queryable,
    accountRef: string,
    fence: Fence,
    lock: 'update' | 'share',
  ): Promise<{ reconcile_required: boolean }> {
    // The fence names ONE account: the same owner id/epoch number never authorises another.
    if (fence.accountRef !== accountRef)
      throw new BridgeOwnerError('LOST', 'fence is bound to another account');
    const rows =
      lock === 'update'
        ? await tx<{ owner_id: string; epoch: string; reconcile_required: boolean }[]>`
            select owner_id, epoch, reconcile_required from bridge_owner
             where account_ref = ${accountRef} for update`
        : await tx<{ owner_id: string; epoch: string; reconcile_required: boolean }[]>`
            select owner_id, epoch, reconcile_required from bridge_owner
             where account_ref = ${accountRef} for share`;
    const r = rows[0];
    if (!r) throw new BridgeOwnerError('NO_OWNER', 'no owner for this account');
    if (r.owner_id !== fence.ownerId || String(r.epoch) !== fence.epoch) {
      throw new BridgeOwnerError('LOST', 'stale owner fence');
    }
    return r;
  }
}
