/**
 * Fake-only transport port and the abstract result model. The statuses are a TEST MODEL; they are
 * NOT MT5 return codes and carry no claim about MT5 semantics (retcode mapping is a future gate).
 */
import { D } from '@astra/core';
import type { BridgeCommand } from './contract';
import { LIMITS, isUlongString } from './contract';

/** Binds a writer to ONE account: the same owner id/epoch number never authorises another account. */
export interface Fence {
  readonly accountRef: string;
  readonly ownerId: string;
  readonly epoch: string;
}

export type TransportResult =
  | { readonly status: 'DONE'; readonly ref: string | null; readonly remainingLots: string | null }
  | { readonly status: 'REJECTED'; readonly reason: string }
  | { readonly status: 'PARTIAL'; readonly doneLots: string; readonly remainingLots: string }
  | { readonly status: 'NOT_FOUND' }
  /** Model only: the fake's own boundary refused; no effect was applied. */
  | { readonly status: 'FENCED' }
  | { readonly status: 'BOUNDARY_REFUSED'; readonly reason: string };

export type BoundaryVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Re-read by the FAKE immediately before it would apply an effect (after every wait): current clock,
 * entry permission, and the AUTHORITATIVE current owner/epoch/reconcile state. A model of the
 * terminal write boundary — not proof about a real terminal.
 */
export interface WriteBoundary {
  check(): Promise<BoundaryVerdict>;
}

/** The only thing the bridge calls to "reach the terminal". May throw: the outcome is then unknown. */
export interface BridgeTransport {
  invoke(command: BridgeCommand, fence: Fence, boundary: WriteBoundary): Promise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const decOk = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= LIMITS.decimalChars &&
  /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v);
const keysAre = (o: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => k in o);
};

/**
 * Operation-specific, strict (exact keys, bounded strings) acceptance of a reply. A malformed,
 * incoherent or wrong-operation reply is NOT an outcome: it yields null and the bridge records
 * UNKNOWN. Quantities are checked against the request when it names them.
 */
export function validateTransportResult(
  raw: unknown,
  command: BridgeCommand,
): TransportResult | null {
  if (!isRecord(raw) || Object.keys(raw).length > 8) return null;
  const op = command.op;
  switch (raw.status) {
    case 'DONE': {
      if (!keysAre(raw, ['status', 'ref', 'remainingLots'])) return null;
      if (raw.ref !== null && !isUlongString(raw.ref)) return null;
      if (raw.remainingLots !== null && !decOk(raw.remainingLots)) return null;
      if (op === 'CLOSE') {
        if (raw.remainingLots === null) return null; // a close must state what remains
        const asked = command.payload.lots;
        if (asked !== null && new D(raw.remainingLots).gt(asked)) return null;
      } else if (raw.remainingLots !== null) return null;
      return { status: 'DONE', ref: raw.ref, remainingLots: raw.remainingLots };
    }
    case 'REJECTED':
      if (!keysAre(raw, ['status', 'reason'])) return null;
      return typeof raw.reason === 'string' && raw.reason.length <= LIMITS.replyStringChars
        ? { status: 'REJECTED', reason: raw.reason }
        : null;
    case 'PARTIAL': {
      if (op === 'CANCEL' || !keysAre(raw, ['status', 'doneLots', 'remainingLots'])) return null;
      if (!decOk(raw.doneLots) || !decOk(raw.remainingLots)) return null;
      const done = new D(raw.doneLots);
      const rest = new D(raw.remainingLots);
      if (!done.gt(0) || !rest.gt(0)) return null;
      const asked =
        op === 'SUBMIT'
          ? command.payload.lots
          : command.op === 'CLOSE'
            ? command.payload.lots
            : null;
      if (asked !== null && !done.plus(rest).eq(asked)) return null;
      return { status: 'PARTIAL', doneLots: raw.doneLots, remainingLots: raw.remainingLots };
    }
    case 'NOT_FOUND':
      // Only meaningful for operations on an existing broker object; incoherent for a new entry.
      if (op === 'SUBMIT' || !keysAre(raw, ['status'])) return null;
      return { status: 'NOT_FOUND' };
    case 'FENCED':
      return keysAre(raw, ['status']) ? { status: 'FENCED' } : null;
    case 'BOUNDARY_REFUSED':
      if (!keysAre(raw, ['status', 'reason'])) return null;
      return typeof raw.reason === 'string' && raw.reason.length <= LIMITS.replyStringChars
        ? { status: 'BOUNDARY_REFUSED', reason: raw.reason }
        : null;
    default:
      return null;
  }
}
