/**
 * Fake-only transport port and the abstract result model. The statuses are a TEST MODEL; they are
 * NOT MT5 return codes and carry no claim about MT5 semantics (retcode mapping is a future gate).
 */
import type { BridgeCommand } from './contract';
import { isUlongString } from './contract';
import { D } from '@astra/core';

export interface Fence {
  readonly ownerId: string;
  readonly epoch: string;
}

export type TransportResult =
  | { readonly status: 'DONE'; readonly ref: string | null; readonly remainingLots: string | null }
  | { readonly status: 'REJECTED'; readonly reason: string }
  | { readonly status: 'PARTIAL'; readonly doneLots: string; readonly remainingLots: string }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'FENCED' };

/** The only thing the bridge calls to "reach the terminal". May throw: the outcome is then unknown. */
export interface BridgeTransport {
  invoke(command: BridgeCommand, fence: Fence): Promise<unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const decOk = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v);

/** A malformed reply is NOT an outcome: it yields null and the bridge records UNKNOWN. */
export function validateTransportResult(raw: unknown): TransportResult | null {
  if (!isRecord(raw)) return null;
  switch (raw.status) {
    case 'DONE':
      if (raw.ref !== null && !isUlongString(raw.ref)) return null;
      if (raw.remainingLots !== null && !decOk(raw.remainingLots)) return null;
      return { status: 'DONE', ref: raw.ref, remainingLots: raw.remainingLots };
    case 'REJECTED':
      return typeof raw.reason === 'string' ? { status: 'REJECTED', reason: raw.reason } : null;
    case 'PARTIAL':
      return decOk(raw.doneLots) && decOk(raw.remainingLots) && new D(raw.remainingLots).gt(0)
        ? { status: 'PARTIAL', doneLots: raw.doneLots, remainingLots: raw.remainingLots }
        : null;
    case 'NOT_FOUND':
      return { status: 'NOT_FOUND' };
    case 'FENCED':
      return { status: 'FENCED' };
    default:
      return null;
  }
}
