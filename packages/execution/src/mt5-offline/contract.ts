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

/** Raw-size bounds applied BEFORE any BigInt/JSON/regex work, so hostile input stays cheap. */
export const LIMITS = {
  ulongChars: 20,
  decimalChars: 40,
  accountRefChars: 300,
  symbolChars: 64,
  timeChars: 24,
  maxKeys: 16,
  replyStringChars: 256,
} as const;

export function isUlongString(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= LIMITS.ulongChars &&
    ULONG_RE.test(v) &&
    BigInt(v) <= ULONG_MAX
  );
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
  if (ref.length > LIMITS.accountRefChars || !ref.startsWith('mt5:')) return null;
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
  if (typeof v !== 'string' || v.length > LIMITS.decimalChars || !DEC_RE.test(v)) return false;
  return positive ? new D(v).gt(0) : true;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Strict Gregorian validation: Date.parse would normalise impossible dates (D001 lesson). */
function isoOk(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > LIMITS.timeChars) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false;
  const dim = mo === 2 && isLeap(y) ? 29 : DAYS[mo - 1];
  return d >= 1 && d <= (dim ?? 0);
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

const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Reads OWN enumerable data properties exactly once into a detached record (no prototype keys). */
function own(v: Record<string, unknown>): Record<string, unknown> | null {
  const keys = Object.keys(v);
  if (keys.length > LIMITS.maxKeys) return null;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of keys) out[k] = v[k];
  return out;
}

/**
 * Validates an untrusted wire value and returns a DETACHED, deeply frozen snapshot built from
 * single reads of its own properties: later caller mutation (or a getter that changes) can
 * never alter what is hashed, persisted or sent. Pure: never writes, never throws.
 */
export function parseCommand(rawInput: unknown): ParseResult {
  const errors: string[] = [];
  if (!isRecord(rawInput)) return { ok: false, errors: ['command must be an object'] };
  let raw: Record<string, unknown> | null;
  try {
    raw = own(rawInput);
  } catch {
    return { ok: false, errors: ['command is not readable'] };
  }
  if (raw === null) return { ok: false, errors: ['too many fields'] };
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
  let p: Record<string, unknown> | null = null;
  if (!isRecord(raw.payload)) errors.push('payload must be an object');
  else {
    try {
      p = own(raw.payload);
    } catch {
      p = null;
    }
    if (p === null) errors.push('payload is not readable');
  }
  let payload: BridgeCommand['payload'] | null = null;
  if (p !== null) {
    if (raw.op === 'SUBMIT') {
      exactKeys(p, ['symbol', 'side', 'lots', 'stopLoss', 'takeProfit'], errors, 'payload');
      if (
        typeof p.symbol !== 'string' ||
        p.symbol.length === 0 ||
        p.symbol.length > LIMITS.symbolChars
      ) {
        errors.push('invalid symbol');
      }
      if (p.side !== 'BUY' && p.side !== 'SELL') errors.push('invalid side');
      if (!decimalOk(p.lots, true)) errors.push('lots must be a positive decimal string');
      if (!decimalOk(p.stopLoss, true)) errors.push('stopLoss must be a positive decimal string');
      if (!decimalOk(p.takeProfit, true))
        errors.push('takeProfit must be a positive decimal string');
      if (errors.length === 0) {
        payload = {
          symbol: p.symbol as string,
          side: p.side as Side,
          lots: p.lots as string,
          stopLoss: p.stopLoss as string,
          takeProfit: p.takeProfit as string,
        };
      }
    } else if (raw.op === 'CANCEL') {
      exactKeys(p, ['orderId'], errors, 'payload');
      if (!isUlongString(p.orderId)) errors.push('orderId must be a decimal ulong string');
      if (errors.length === 0) payload = { orderId: p.orderId as string };
    } else if (raw.op === 'CLOSE') {
      exactKeys(p, ['positionIdentifier', 'lots'], errors, 'payload');
      if (!isUlongString(p.positionIdentifier))
        errors.push('positionIdentifier must be a decimal ulong string');
      if (p.lots !== null && !decimalOk(p.lots, true))
        errors.push('lots must be null or a positive decimal string');
      if (errors.length === 0) {
        payload = {
          positionIdentifier: p.positionIdentifier as string,
          lots: p.lots as string | null,
        };
      }
    }
  }
  if (errors.length > 0 || payload === null) return { ok: false, errors };
  const command = {
    v: PROTOCOL_VERSION,
    op: raw.op as BridgeCommand['op'],
    commandId: raw.commandId as string,
    accountRef: raw.accountRef as string,
    issuedAt: raw.issuedAt as string,
    expiresAt: raw.expiresAt as string,
    payload: Object.freeze(payload),
  } as BridgeCommand;
  return { ok: true, command: Object.freeze(command) };
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
  rawInput: unknown,
): { asOf: string; bid: string; ask: string; symbol: string } | null {
  if (!isRecord(rawInput)) return null;
  const { symbol, bid, ask, timeMsc } = rawInput;
  if (typeof symbol !== 'string' || symbol.length === 0 || symbol.length > LIMITS.symbolChars)
    return null;
  if (!decimalOk(bid, true) || !decimalOk(ask, true) || !isUlongString(timeMsc)) return null;
  if (new D(ask).lt(new D(bid))) return null;
  if (BigInt(timeMsc) > 8_640_000_000_000_000n) return null;
  return { symbol, bid, ask, asOf: new Date(Number(timeMsc)).toISOString() };
}
