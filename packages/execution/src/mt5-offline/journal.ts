/**
 * Durable bridge journal PORT. An implementation is durable only if a returned promise means the
 * write is COMMITTED to storage that survives a process crash (packages/db implements it on
 * PostgreSQL). An in-memory object must never be passed off as this port in a durability claim.
 */
import type { BridgeCommand, CommandClass } from './contract';
import type { Fence, TransportResult } from './transport';

export type JournalState = 'INTENT' | 'SEND_MAY_HAVE_STARTED' | 'RESOLVED' | 'UNKNOWN' | 'REFUSED';

export type CloseStatus = 'CLOSED' | 'PARTIAL' | 'NOT_FOUND' | 'REJECTED';

export interface StoredResult {
  readonly transport: TransportResult | null;
  /** CLOSE only: CLOSED only when nothing remains open; a partial close is never CLOSED. */
  readonly closeStatus?: CloseStatus;
  readonly note?: string;
}

export interface JournalRecord {
  readonly accountRef: string;
  readonly commandId: string;
  readonly op: BridgeCommand['op'];
  readonly cls: CommandClass;
  readonly payloadHash: string;
  readonly command: BridgeCommand;
  readonly state: JournalState;
  readonly result: StoredResult | null;
  readonly ownerId: string;
  readonly epoch: string;
}

export type BeginOutcome =
  | { readonly kind: 'NEW'; readonly record: JournalRecord }
  | { readonly kind: 'REPLAY'; readonly record: JournalRecord }
  | { readonly kind: 'CONFLICT' };

/** Evaluated inside the atomic marker step; only ENTRY commands are subject to it. */
export interface MarkerGuard {
  /** A fresh, valid UTC instant (ISO) read immediately before the call. */
  readonly nowIso: string;
}

export interface OwnerState {
  readonly ownerId: string;
  readonly epoch: string;
  readonly reconcileRequired: boolean;
}

/** Raised when the caller's fence is not the account's current owner fence (or the owner is busy). */
export class BridgeOwnerError extends Error {
  constructor(
    readonly code: 'BUSY' | 'LOST' | 'NO_OWNER',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeOwnerError';
  }
}

export interface TakeoverEvidence {
  /** The caller asserts, with evidence recorded in `note`, that the old writer CANNOT act. */
  readonly oldWriterCannotAct: true;
  readonly note: string;
}

export interface BridgeJournal {
  /** First owner only. An existing owner row ⇒ BUSY, however old it is (no handoff by expiry). The fence is bound to `accountRef`. */
  acquireOwner(accountRef: string, ownerId: string): Promise<Fence>;
  /** Explicit evidence-based handoff: bumps the epoch and requires reconciliation before entries. */
  takeover(accountRef: string, newOwnerId: string, evidence: TakeoverEvidence): Promise<Fence>;
  completeReconcile(accountRef: string, fence: Fence): Promise<void>;
  ownerState(accountRef: string): Promise<OwnerState | null>;

  /** Atomic per account: records INTENT, or reports the existing record (REPLAY / CONFLICT). */
  begin(fence: Fence, command: BridgeCommand): Promise<BeginOutcome>;
  /**
   * Compare-and-swap INTENT → SEND_MAY_HAVE_STARTED, committed before the transport is called.
   * LOST_RACE: another caller already moved it (the loser must not invoke). ENTRY_BLOCKED: for an
   * ENTRY the guard failed INSIDE the atomic step (reconciliation required, or expired at `nowIso`);
   * the row stays an unsent INTENT.
   */
  markSendMayHaveStarted(
    fence: Fence,
    accountRef: string,
    commandId: string,
    guard: MarkerGuard,
  ): Promise<'WON' | 'LOST_RACE' | 'ENTRY_BLOCKED'>;
  recordResult(
    fence: Fence,
    accountRef: string,
    commandId: string,
    state: 'RESOLVED' | 'UNKNOWN',
    result: StoredResult,
  ): Promise<void>;
  /** INTENT → REFUSED (never sent). */
  refuse(fence: Fence, accountRef: string, commandId: string, note: string): Promise<void>;

  get(accountRef: string, commandId: string): Promise<JournalRecord | null>;
  /** Protective INTENT records not yet dispatched, oldest first. */
  pendingProtective(accountRef: string): Promise<JournalRecord[]>;
}
