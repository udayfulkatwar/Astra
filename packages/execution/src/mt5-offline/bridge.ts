/**
 * Offline bridge runner: validate → journal intent → (gates) → durable SEND_MAY_HAVE_STARTED →
 * fake transport → record. It decides nothing about trading; ASTRA's gateway does. Rules:
 *
 *  - Invalid input fails before any write.
 *  - The irreversible marker is COMMITTED before the transport is called; a failed persist means
 *    the transport is NOT invoked.
 *  - Same id + same payload replays; same id + different payload is refused; an intent that
 *    reached SEND_MAY_HAVE_STARTED is never resent (UNKNOWN is preserved).
 *  - Entry gates (expiry, reconcile-required, permission) apply to ENTRIES only. A protective
 *    command stays a durable pending INTENT when it cannot run now and is retried by
 *    drainProtective; it is never discarded because of an entry gate or an expired entry command.
 */
import { D } from '@astra/core';
import { commandClass, parseCommand, payloadHash, type BridgeCommand } from './contract';
import type { BridgeJournal, CloseStatus, JournalRecord, StoredResult } from './journal';
import type { BridgeTransport, Fence, TransportResult } from './transport';
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

export interface BridgeContext {
  readonly now: Date;
  /** ENTRY permission (trade-allowed, fresh quotes, …) decided by the caller; never affects protective. */
  readonly entryPermitted: boolean;
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
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'REJECTED':
    case 'FENCED':
      return 'REJECTED';
  }
}

export class OfflineBridge {
  constructor(
    private readonly journal: BridgeJournal,
    private readonly transport: BridgeTransport,
    private readonly fence: Fence,
  ) {}

  async execute(raw: unknown, ctx: BridgeContext): Promise<BridgeOutcome> {
    const parsed = parseCommand(raw);
    if (!parsed.ok) return { kind: 'INVALID', errors: parsed.errors };
    const command = parsed.command;
    const begun = await this.journal.begin(this.fence, command);
    if (begun.kind === 'CONFLICT') return { kind: 'CONFLICT' };
    return this.proceed(begun.record, ctx);
  }

  /** Retries durable pending protective intents (e.g. after a restart or a lifted block). */
  async drainProtective(accountRef: string, ctx: BridgeContext): Promise<BridgeOutcome[]> {
    const out: BridgeOutcome[] = [];
    for (const rec of await this.journal.pendingProtective(accountRef)) {
      out.push(await this.proceed(rec, ctx));
    }
    return out;
  }

  private async proceed(rec: JournalRecord, ctx: BridgeContext): Promise<BridgeOutcome> {
    switch (rec.state) {
      case 'RESOLVED':
        return { kind: 'RESOLVED', result: rec.result ?? { transport: null } };
      case 'REFUSED':
        return { kind: 'REFUSED', reason: rec.result?.note ?? 'refused' };
      case 'SEND_MAY_HAVE_STARTED':
        // Dispatched, no recorded result: never resend. Recorded UNKNOWN for the caller.
        return { kind: 'UNKNOWN', result: rec.result };
      case 'UNKNOWN':
        return { kind: 'UNKNOWN', result: rec.result };
      case 'INTENT':
        break;
    }
    const cls = commandClass(rec.command);
    const owner = await this.journal.ownerState(rec.accountRef);
    if (cls === 'ENTRY') {
      const expired = ctx.now.getTime() >= Date.parse(rec.command.expiresAt);
      const reason = expired
        ? 'entry command expired'
        : owner?.reconcileRequired
          ? 'reconciliation required'
          : !ctx.entryPermitted
            ? 'entry not permitted'
            : null;
      if (reason !== null) {
        await this.journal.refuse(this.fence, rec.accountRef, rec.commandId, reason);
        return { kind: 'REFUSED', reason };
      }
    } else if (owner?.reconcileRequired) {
      // Protective intent stays durably pending until ownership/reconciliation is safe.
      return { kind: 'PENDING', reason: 'reconciliation required' };
    }
    return this.dispatch(rec);
  }

  private async dispatch(rec: JournalRecord): Promise<BridgeOutcome> {
    let won: boolean;
    try {
      won = await this.journal.markSendMayHaveStarted(this.fence, rec.accountRef, rec.commandId);
    } catch (err) {
      // The marker is not durable: the terminal is NOT invoked.
      return { kind: 'NOT_SENT', reason: err instanceof Error ? err.message : 'persist failed' };
    }
    if (!won) return { kind: 'IN_FLIGHT' };

    let reply: unknown;
    try {
      reply = await this.transport.invoke(rec.command, this.fence);
    } catch {
      const result: StoredResult = { transport: null, note: 'transport error' };
      await this.recordSafely(rec, 'UNKNOWN', result);
      return { kind: 'UNKNOWN', result };
    }
    const validated = validateTransportResult(reply);
    if (validated === null) {
      const result: StoredResult = { transport: null, note: 'malformed reply' };
      await this.recordSafely(rec, 'UNKNOWN', result);
      return { kind: 'UNKNOWN', result };
    }
    if (rec.op === 'CLOSE') {
      const closeStatus = classifyClose(validated);
      if (closeStatus === null) {
        const result: StoredResult = { transport: validated, note: 'close remainder unproven' };
        await this.recordSafely(rec, 'UNKNOWN', result);
        return { kind: 'UNKNOWN', result };
      }
      const result: StoredResult = { transport: validated, closeStatus };
      await this.recordSafely(rec, 'RESOLVED', result);
      return { kind: 'RESOLVED', result };
    }
    const result: StoredResult = { transport: validated };
    await this.recordSafely(rec, 'RESOLVED', result);
    return { kind: 'RESOLVED', result };
  }

  /** A failed result write leaves SEND_MAY_HAVE_STARTED in place (still never resent). */
  private async recordSafely(
    rec: JournalRecord,
    state: 'RESOLVED' | 'UNKNOWN',
    result: StoredResult,
  ): Promise<void> {
    try {
      await this.journal.recordResult(this.fence, rec.accountRef, rec.commandId, state, result);
    } catch {
      /* state stays SEND_MAY_HAVE_STARTED: dispatched, never resent */
    }
  }
}

export { payloadHash };
export type { BridgeCommand };
