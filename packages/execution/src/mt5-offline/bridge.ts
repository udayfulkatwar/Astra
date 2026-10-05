/**
 * Offline bridge runner: validate → journal intent → (gates) → durable SEND_MAY_HAVE_STARTED →
 * fake transport (re-reading the gates at its write boundary) → record. It decides nothing about
 * trading; ASTRA's gateway does. Rules:
 *
 *  - Invalid input fails before any write; the command is dispatched from the detached, persisted
 *    snapshot, never from caller-owned memory.
 *  - The irreversible marker is COMMITTED before the transport is called; a failed persist means
 *    the transport is NOT invoked.
 *  - Same id + same payload replays; same id + different payload is refused; an intent that
 *    reached SEND_MAY_HAVE_STARTED is never resent (UNKNOWN is preserved).
 *  - The clock and the entry gate are INJECTED suppliers read fresh at each decision point and
 *    again at the write boundary. Entry gates (invalid clock, issuedAt in the future, expiry,
 *    reconcile-required, permission !== true) apply to ENTRIES only. A protective command stays a
 *    durable pending INTENT when it cannot run now and is retried by drainProtective.
 *  - A result that cannot be persisted is reported UNKNOWN, never RESOLVED.
 */
import { D } from '@astra/core';
import { commandClass, parseCommand, type BridgeCommand } from './contract';
import type { BridgeJournal, CloseStatus, JournalRecord, StoredResult } from './journal';
import type {
  BoundaryVerdict,
  BridgeTransport,
  Fence,
  TransportResult,
  WriteBoundary,
} from './transport';
import { validateTransportResult } from './transport';

export type BridgeOutcome =
  | { readonly kind: 'INVALID'; readonly errors: readonly string[] }
  | { readonly kind: 'CONFLICT' }
  | { readonly kind: 'REFUSED'; readonly reason: string }
  | { readonly kind: 'PENDING'; readonly reason: string }
  | { readonly kind: 'IN_FLIGHT' }
  | { readonly kind: 'RESOLVED'; readonly result: StoredResult }
  | { readonly kind: 'UNKNOWN'; readonly result: StoredResult | null }
  | { readonly kind: 'NOT_SENT'; readonly reason: string };

/** Injected suppliers, read fresh every time (never a value captured before an await). */
export interface BridgeRuntime {
  readonly clock: () => Date;
  /** ENTRY permission only (trade-allowed, fresh quotes, …). Anything but `true` denies. */
  readonly entryPermitted: () => boolean | Promise<boolean>;
}

export function classifyClose(r: TransportResult | null): CloseStatus | null {
  if (r === null) return null;
  switch (r.status) {
    case 'DONE':
      // Only a reply that PROVES nothing remains is CLOSED; a missing remainder is not evidence.
      if (r.remainingLots === null) return null;
      return new D(r.remainingLots).isZero() ? 'CLOSED' : 'PARTIAL';
    case 'PARTIAL':
      return 'PARTIAL';
    case 'REJECTED':
      return 'REJECTED';
    case 'NOT_FOUND': // absence is not closure proof in this model
    case 'FENCED':
    case 'BOUNDARY_REFUSED':
      return null;
  }
}

function validNow(runtime: BridgeRuntime): Date | null {
  let t: unknown;
  try {
    t = runtime.clock();
  } catch {
    return null;
  }
  return t instanceof Date && Number.isFinite(t.getTime()) ? t : null;
}

async function permitted(runtime: BridgeRuntime): Promise<boolean> {
  try {
    return (await runtime.entryPermitted()) === true;
  } catch {
    return false;
  }
}

/** Synchronous fresh-clock gate for an ENTRY: valid clock, issuedAt not in the future, not expired. */
function clockReason(command: BridgeCommand, runtime: BridgeRuntime): string | null {
  const now = validNow(runtime);
  if (now === null) return 'invalid clock';
  if (Date.parse(command.issuedAt) > now.getTime()) return 'issuedAt is in the future';
  if (now.getTime() >= Date.parse(command.expiresAt)) return 'entry command expired';
  return null;
}

export class OfflineBridge {
  constructor(
    private readonly journal: BridgeJournal,
    private readonly transport: BridgeTransport,
    private readonly fence: Fence,
  ) {}

  async execute(raw: unknown, runtime: BridgeRuntime): Promise<BridgeOutcome> {
    const parsed = parseCommand(raw);
    if (!parsed.ok) return { kind: 'INVALID', errors: parsed.errors };
    // From here on only the detached snapshot exists; `raw` is never read again.
    const begun = await this.journal.begin(this.fence, parsed.command);
    if (begun.kind === 'CONFLICT') return { kind: 'CONFLICT' };
    return this.proceed(begun.record, runtime);
  }

  /** Retries durable pending protective intents (e.g. after a restart or a lifted block). */
  async drainProtective(accountRef: string, runtime: BridgeRuntime): Promise<BridgeOutcome[]> {
    const out: BridgeOutcome[] = [];
    for (const rec of await this.journal.pendingProtective(accountRef)) {
      out.push(await this.proceed(rec, runtime));
    }
    return out;
  }

  /** The write-boundary re-read the fake performs just before applying an effect. */
  boundaryFor(command: BridgeCommand, runtime: BridgeRuntime): WriteBoundary {
    return { check: () => this.checkBoundary(command, runtime) };
  }

  /**
   * Final write-boundary verdict. Order matters: the ONLY async gate (entry permission, ENTRY only)
   * is awaited FIRST; then the authoritative owner/fence/reconcile state is read; and the clock is
   * read LAST, synchronously, with no await between it and the verdict. A slow permission supplier
   * therefore cannot let the clock pass expiry, or ownership/reconcile change, unnoticed. Protective
   * commands never consult entry permission but keep the current owner/fence/reconcile safety.
   * MODEL LIMIT: this narrows, and in the single-threaded fake closes, the check→effect gap; a real
   * terminal's race between the verdict and the broker applying the order is NOT solved here.
   */
  private async checkBoundary(
    command: BridgeCommand,
    runtime: BridgeRuntime,
  ): Promise<BoundaryVerdict> {
    const isEntry = commandClass(command) === 'ENTRY';
    const allowed = isEntry ? await permitted(runtime) : true;
    const owner = await this.journal.ownerState(command.accountRef);
    if (owner === null) return { ok: false, reason: 'no owner' };
    if (
      this.fence.accountRef !== command.accountRef ||
      owner.ownerId !== this.fence.ownerId ||
      owner.epoch !== this.fence.epoch
    ) {
      return { ok: false, reason: 'stale owner fence' };
    }
    if (owner.reconcileRequired) return { ok: false, reason: 'reconciliation required' };
    if (isEntry) {
      if (!allowed) return { ok: false, reason: 'entry not permitted' };
      const reason = clockReason(command, runtime); // synchronous, last, no await after
      if (reason !== null) return { ok: false, reason };
    }
    return { ok: true };
  }

  /** ENTRY pre-marker gate: permission first (the only await), then owner, then the clock last. */
  private async entryReason(
    command: BridgeCommand,
    runtime: BridgeRuntime,
  ): Promise<string | null> {
    const allowed = await permitted(runtime);
    const owner = await this.journal.ownerState(command.accountRef);
    if (owner === null || owner.reconcileRequired) return 'reconciliation required';
    if (!allowed) return 'entry not permitted';
    return clockReason(command, runtime);
  }

  private async proceed(rec: JournalRecord, runtime: BridgeRuntime): Promise<BridgeOutcome> {
    switch (rec.state) {
      case 'RESOLVED':
        // A RESOLVED row without a result is corrupt evidence: never fabricate one.
        return rec.result === null
          ? {
              kind: 'UNKNOWN',
              result: { transport: null, note: 'corrupt: resolved without a result' },
            }
          : { kind: 'RESOLVED', result: rec.result };
      case 'REFUSED':
        return { kind: 'REFUSED', reason: rec.result?.note ?? 'refused' };
      case 'SEND_MAY_HAVE_STARTED':
        // Dispatched, no recorded result: never resend.
        return { kind: 'UNKNOWN', result: rec.result };
      case 'UNKNOWN':
        return { kind: 'UNKNOWN', result: rec.result };
      case 'INTENT':
        break;
    }
    if (commandClass(rec.command) === 'ENTRY') {
      const reason = await this.entryReason(rec.command, runtime);
      if (reason !== null) return this.refuse(rec, reason);
    } else {
      const owner = await this.journal.ownerState(rec.accountRef);
      if (owner?.reconcileRequired ?? true) {
        // Protective intent stays durably pending until ownership/reconciliation is safe.
        return { kind: 'PENDING', reason: 'reconciliation required' };
      }
    }
    return this.dispatch(rec, runtime);
  }

  private async refuse(rec: JournalRecord, reason: string): Promise<BridgeOutcome> {
    try {
      await this.journal.refuse(this.fence, rec.accountRef, rec.commandId, reason);
    } catch (err) {
      return { kind: 'NOT_SENT', reason: err instanceof Error ? err.message : 'refuse failed' };
    }
    return { kind: 'REFUSED', reason };
  }

  private async dispatch(rec: JournalRecord, runtime: BridgeRuntime): Promise<BridgeOutcome> {
    const cmd = rec.command;
    const nowForMarker = validNow(runtime);
    if (commandClass(cmd) === 'ENTRY' && nowForMarker === null)
      return this.refuse(rec, 'invalid clock');
    let marked: 'WON' | 'LOST_RACE' | 'ENTRY_BLOCKED';
    try {
      marked = await this.journal.markSendMayHaveStarted(
        this.fence,
        rec.accountRef,
        rec.commandId,
        {
          nowIso: (nowForMarker ?? new Date(0)).toISOString(),
        },
      );
    } catch (err) {
      // The marker is not durable: the terminal is NOT invoked.
      return { kind: 'NOT_SENT', reason: err instanceof Error ? err.message : 'persist failed' };
    }
    if (marked === 'LOST_RACE') return { kind: 'IN_FLIGHT' };
    if (marked === 'ENTRY_BLOCKED') return this.refuse(rec, 'entry blocked at the marker');

    let reply: unknown;
    try {
      reply = await this.transport.invoke(cmd, this.fence, this.boundaryFor(cmd, runtime));
    } catch {
      return this.settle(rec, 'UNKNOWN', { transport: null, note: 'transport error' });
    }
    const validated = validateTransportResult(reply, cmd);
    if (validated === null) {
      return this.settle(rec, 'UNKNOWN', {
        transport: null,
        note: 'malformed or incoherent reply',
      });
    }
    if (validated.status === 'FENCED' || validated.status === 'BOUNDARY_REFUSED') {
      // The marker is committed, so the row stays conservative (UNKNOWN) and is never resent.
      const note = validated.status === 'FENCED' ? 'fenced at the boundary' : validated.reason;
      return this.settle(rec, 'UNKNOWN', { transport: validated, note });
    }
    if (rec.op === 'CLOSE') {
      const closeStatus = classifyClose(validated);
      if (closeStatus === null) {
        return this.settle(rec, 'UNKNOWN', {
          transport: validated,
          note: 'close outcome unproven',
        });
      }
      return this.settle(rec, 'RESOLVED', { transport: validated, closeStatus });
    }
    return this.settle(rec, 'RESOLVED', { transport: validated });
  }

  /** The outcome is reported only if it was durably recorded; otherwise it is UNKNOWN. */
  private async settle(
    rec: JournalRecord,
    state: 'RESOLVED' | 'UNKNOWN',
    result: StoredResult,
  ): Promise<BridgeOutcome> {
    try {
      await this.journal.recordResult(this.fence, rec.accountRef, rec.commandId, state, result);
    } catch {
      // The row stays SEND_MAY_HAVE_STARTED (dispatched, never resent); the caller learns UNKNOWN.
      return {
        kind: 'UNKNOWN',
        result: { transport: null, note: 'result could not be persisted' },
      };
    }
    return state === 'RESOLVED' ? { kind: 'RESOLVED', result } : { kind: 'UNKNOWN', result };
  }
}
