/**
 * P002 offline bridge contract v1 (design: docs/ledger/P002_MT5_ROUTE.md §6). Pure validation of
 * the command wire format. Nothing here knows MT5, a terminal SDK or a network: it is the
 * protocol boundary the future bridge and the ASTRA adapter will both speak.
 *
 * - 64-bit identifiers cross the wire as DECIMAL STRINGS (never JS numbers).
 * - The account binding is a canonical encoding that cannot alias across separator characters.
 * - Validation is strict: unknown keys, non-canonical or non-finite values and unknown operations
 *   are rejected BEFORE anything is written.
 * - Operation statuses used by the fake are an abstract test model, not MT5 return codes.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@astra/core';
import { D } from '@astra/core';

export const PROTOCOL_VERSION = 1 as const;
const ULONG_MAX = 2n ** 64n - 1n;

export type CommandClass = 'ENTRY' | 'PROTECTIVE';
export type Side = 'BUY' | 'SELL';

interface CommandBase {
  readonly v: typeof PROTOCOL_VERSION;
  /** Idempotency key, unique per account. */
  readonly commandId: string;
  readonly accountRef: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface SubmitCommand extends CommandBase {
  readonly op: 'SUBMIT';
  readonly payload: {
    readonly symbol: string;
    readonly side: Side;
    /** Lots as a decimal string (never a float). */
    readonly lots: string;
    readonly stopLoss: string;
    readonly takeProfit: string;
  };
}
export interface CancelCommand extends CommandBase {
  readonly op: 'CANCEL';
  readonly payload: { readonly orderId: string };
}
export interface CloseCommand extends CommandBase {
  readonly op: 'CLOSE';
  readonly payload: {
    /** Stable position identity (decimal string), not a ticket. */
    readonly positionIdentifier: string;
    /** Lots to close; null = the whole position. */
    readonly lots: string | null;
  };
}
export type BridgeCommand = SubmitCommand | CancelCommand | CloseCommand;

export const commandClass = (c: { op: BridgeCommand['op'] }): CommandClass =>
  c.op === 'SUBMIT' ? 'ENTRY' : 'PROTECTIVE';

export type ParseResult =
  | { readonly ok: true; readonly command: BridgeCommand }
  | { readonly ok: false; readonly errors: readonly string[] };

const ULONG_RE = /^(0|[1-9][0-9]*)$/;
const DEC_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isUlongString(v: unknown): v is string {
  return typeof v === 'string' && ULONG_RE.test(v) && BigInt(v) <= ULONG_MAX;
}

/** Canonical account binding: `mt5:` + a JSON array [server, login]. */
export function encodeAccountRef(server: string, login: string): string {
  if (
    server.length === 0 ||
    server.length > 128 ||
    [...server].some((ch) => ch.charCodeAt(0) < 0x20)
  ) {
    throw new Error('invalid server name');
  }
  if (!isUlongString(login)) throw new Error('login must be a decimal ulong string');
  return `mt5:${JSON.stringify([server, login])}`;
}

export function decodeAccountRef(ref: string): { server: string; login: string } | null {
  if (!ref.startsWith('mt5:')) return null;
  try {
    const parsed: unknown = JSON.parse(ref.slice(4));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [server, login] = parsed as unknown[];
    if (typeof server !== 'string' || typeof login !== 'string') return null;
    return encodeAccountRef(server, login) === ref ? { server, login } : null;
  } catch {
    return null;
  }
}

function decimalOk(v: unknown, positive: boolean): v is string {
  if (typeof v !== 'string' || v.length > 40 || !DEC_RE.test(v)) return false;
  return positive ? new D(v).gt(0) : true;
}

function isoOk(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function exactKeys(
  o: Record<string, unknown>,
  keys: readonly string[],
  errors: string[],
  at: string,
) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${at}: unknown field ${k}`);
  for (const k of keys) if (!(k in o)) errors.push(`${at}: missing field ${k}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validates an untrusted wire value. Pure: never writes, never throws. */
export function parseCommand(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['command must be an object'] };
  exactKeys(
    raw,
    ['v', 'op', 'commandId', 'accountRef', 'issuedAt', 'expiresAt', 'payload'],
    errors,
    'command',
  );
  if (raw.v !== PROTOCOL_VERSION) errors.push('unsupported protocol version');
  if (raw.op !== 'SUBMIT' && raw.op !== 'CANCEL' && raw.op !== 'CLOSE')
    errors.push('unknown operation');
  if (typeof raw.commandId !== 'string' || !ID_RE.test(raw.commandId))
    errors.push('invalid commandId');
  if (typeof raw.accountRef !== 'string' || decodeAccountRef(raw.accountRef) === null) {
    errors.push('accountRef is not canonical');
  }
  if (!isoOk(raw.issuedAt)) errors.push('invalid issuedAt');
  if (!isoOk(raw.expiresAt)) errors.push('invalid expiresAt');
  else if (isoOk(raw.issuedAt) && Date.parse(raw.expiresAt) <= Date.parse(raw.issuedAt)) {
    errors.push('expiresAt must be after issuedAt');
  }
  const p = raw.payload;
  if (!isRecord(p)) errors.push('payload must be an object');
  else if (raw.op === 'SUBMIT') {
    exactKeys(p, ['symbol', 'side', 'lots', 'stopLoss', 'takeProfit'], errors, 'payload');
    if (typeof p.symbol !== 'string' || p.symbol.length === 0 || p.symbol.length > 64)
      errors.push('invalid symbol');
    if (p.side !== 'BUY' && p.side !== 'SELL') errors.push('invalid side');
    if (!decimalOk(p.lots, true)) errors.push('lots must be a positive decimal string');
    if (!decimalOk(p.stopLoss, true)) errors.push('stopLoss must be a positive decimal string');
    if (!decimalOk(p.takeProfit, true)) errors.push('takeProfit must be a positive decimal string');
  } else if (raw.op === 'CANCEL') {
    exactKeys(p, ['orderId'], errors, 'payload');
    if (!isUlongString(p.orderId)) errors.push('orderId must be a decimal ulong string');
  } else if (raw.op === 'CLOSE') {
    exactKeys(p, ['positionIdentifier', 'lots'], errors, 'payload');
    if (!isUlongString(p.positionIdentifier))
      errors.push('positionIdentifier must be a decimal ulong string');
    if (p.lots !== null && !decimalOk(p.lots, true))
      errors.push('lots must be null or a positive decimal string');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, command: raw as unknown as BridgeCommand };
}

/** Hash of what the command DOES (op, account, payload) — not its id or timing. */
export function payloadHash(c: BridgeCommand): string {
  return createHash('sha256')
    .update(canonicalJson({ op: c.op, accountRef: c.accountRef, payload: c.payload }))
    .digest('hex');
}

/** A tick as the (future) terminal bridge reports it: epoch ms in UTC, NO offset applied. */
export interface WireTick {
  readonly symbol: string;
  readonly bid: string;
  readonly ask: string;
  readonly timeMsc: string;
}

export function parseTick(
  raw: unknown,
): { asOf: string; bid: string; ask: string; symbol: string } | null {
  if (!isRecord(raw)) return null;
  const { symbol, bid, ask, timeMsc } = raw;
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  if (!decimalOk(bid, true) || !decimalOk(ask, true) || !isUlongString(timeMsc)) return null;
  if (new D(ask).lt(new D(bid))) return null;
  if (BigInt(timeMsc) > 8_640_000_000_000_000n) return null;
  return { symbol, bid, ask, asOf: new Date(Number(timeMsc)).toISOString() };
}
