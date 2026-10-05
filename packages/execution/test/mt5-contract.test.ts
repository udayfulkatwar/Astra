import { describe, expect, it } from 'vitest';
import {
  classifyClose,
  decodeAccountRef,
  encodeAccountRef,
  isUlongString,
  parseCommand,
  parseTick,
  payloadHash,
  validateTransportResult,
  type BridgeCommand,
} from '../src';

const ACCOUNT = encodeAccountRef('Demo-Server', '12345678901234567890');
const base = {
  v: 1,
  commandId: 'cmd-1',
  accountRef: ACCOUNT,
  issuedAt: '2026-10-05T10:00:00.000Z',
  expiresAt: '2026-10-05T10:00:30.000Z',
};
const cmd = (raw: unknown): BridgeCommand => {
  const p = parseCommand(raw);
  if (!p.ok) throw new Error(p.errors.join(';'));
  return p.command;
};
const submit = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  ...base,
  op: 'SUBMIT',
  payload: {
    symbol: 'US30',
    side: 'BUY',
    lots: '0.10',
    stopLoss: '38000.5',
    takeProfit: '39000',
    ...payload,
  },
  ...over,
});

describe('P002 offline contract v1 (pure validation; no terminal, no network)', () => {
  it('accepts well-formed commands of every operation', () => {
    expect(parseCommand(submit()).ok).toBe(true);
    expect(
      parseCommand({ ...base, op: 'CANCEL', payload: { orderId: '18446744073709551615' } }).ok,
    ).toBe(true);
    expect(
      parseCommand({ ...base, op: 'CLOSE', payload: { positionIdentifier: '9', lots: null } }).ok,
    ).toBe(true);
    expect(
      parseCommand({ ...base, op: 'CLOSE', payload: { positionIdentifier: '9', lots: '0.05' } }).ok,
    ).toBe(true);
  });

  it.each([
    ['unknown operation', submit({ op: 'MODIFY' })],
    ['unknown top-level field', submit({ extra: 1 })],
    ['unknown payload field', submit({}, { comment: 'x' })],
    ['wrong version', submit({ v: 2 })],
    ['numeric (non-string) lots', submit({}, { lots: 0.1 })],
    ['NaN lots', submit({}, { lots: NaN })],
    ['"NaN" lots', submit({}, { lots: 'NaN' })],
    ['Infinity lots', submit({}, { lots: 'Infinity' })],
    ['exponent lots', submit({}, { lots: '1e2' })],
    ['zero lots', submit({}, { lots: '0' })],
    ['negative stop', submit({}, { stopLoss: '-1' })],
    ['bad side', submit({}, { side: 'LONG' })],
    ['non-canonical accountRef', submit({ accountRef: 'mt5:["Demo-Server", "1"]' })],
    ['accountRef with numeric login', submit({ accountRef: 'mt5:["S",1]' })],
    ['expiry before issue', submit({ expiresAt: '2026-10-05T09:00:00.000Z' })],
    ['non-UTC timestamp', submit({ issuedAt: '2026-10-05T10:00:00+05:30' })],
    ['bad commandId', submit({ commandId: 'has space' })],
    ['not an object', 42],
    ['null', null],
  ])('rejects %s', (_name, raw) => {
    expect(parseCommand(raw).ok).toBe(false);
  });

  it('rejects ulong identifiers that are not exact decimal strings or exceed 2^64-1', () => {
    for (const bad of [
      '18446744073709551616',
      '-1',
      '01',
      '1.0',
      1,
      12345678901234567890n,
      '0x10',
      '',
    ])
      expect(isUlongString(bad)).toBe(false);
    expect(parseCommand({ ...base, op: 'CANCEL', payload: { orderId: 123 } }).ok).toBe(false);
    expect(
      parseCommand({ ...base, op: 'CANCEL', payload: { orderId: '18446744073709551616' } }).ok,
    ).toBe(false);
  });

  it('keeps ulong identifiers above 2^53 exact through a JSON round trip', () => {
    const id = '9007199254740993'; // 2^53 + 1: a JS number cannot hold it
    const wire = JSON.stringify({ ...base, op: 'CANCEL', payload: { orderId: id } });
    const parsed = parseCommand(JSON.parse(wire));
    expect(parsed.ok && parsed.command.op === 'CANCEL' && parsed.command.payload.orderId).toBe(id);
    expect(Number(id).toString()).not.toBe(id);
  });

  it('account binding is canonical and cannot alias across separator characters', () => {
    const a = encodeAccountRef('A:1', '2');
    const b = encodeAccountRef('A', '2');
    expect(a).not.toBe(b);
    expect(decodeAccountRef(a)).toEqual({ server: 'A:1', login: '2' });
    expect(decodeAccountRef(encodeAccountRef('X","1","', '5'))).toEqual({
      server: 'X","1","',
      login: '5',
    });
    expect(() => encodeAccountRef('S', '1:2')).toThrow();
    expect(() => encodeAccountRef('', '1')).toThrow();
    expect(decodeAccountRef('mt5:["S","1"] ')).toBeNull();
    expect(decodeAccountRef('mt5:["S","01"]')).toBeNull();
  });

  it('payload hash covers what the command does, not its id or timing', () => {
    const one = parseCommand(submit());
    const retimed = parseCommand(
      submit({ commandId: 'cmd-2', expiresAt: '2026-10-05T11:00:00.000Z' }),
    );
    const other = parseCommand(submit({}, { lots: '0.20' }));
    if (!one.ok || !retimed.ok || !other.ok) throw new Error('fixture invalid');
    expect(payloadHash(one.command)).toBe(payloadHash(retimed.command));
    expect(payloadHash(one.command)).not.toBe(payloadHash(other.command));
  });

  it('tick timestamps are UTC epoch milliseconds with NO offset applied', () => {
    const t = parseTick({
      symbol: 'US30',
      bid: '38000.1',
      ask: '38000.6',
      timeMsc: '1759658400123',
    });
    expect(t?.asOf).toBe('2025-10-05T10:00:00.123Z');
    expect(parseTick({ symbol: 'US30', bid: '1', ask: '2', timeMsc: 1759658400123 })).toBeNull();
    expect(parseTick({ symbol: 'US30', bid: '2', ask: '1', timeMsc: '1' })).toBeNull();
    expect(parseTick({ symbol: 'US30', bid: '0', ask: '1', timeMsc: '1' })).toBeNull();
    expect(
      parseTick({ symbol: 'US30', bid: '1', ask: '2', timeMsc: '99999999999999999' }),
    ).toBeNull();
  });

  it('replies are validated per operation, with exact keys, bounds and coherent quantities', () => {
    const sub = cmd(submit());
    const cls = cmd({ ...base, op: 'CLOSE', payload: { positionIdentifier: '9', lots: '0.10' } });
    const cnl = cmd({ ...base, op: 'CANCEL', payload: { orderId: '9' } });
    const v = validateTransportResult;
    expect(v({ status: 'WAT' }, sub)).toBeNull();
    expect(v(null, sub)).toBeNull();
    expect(v({ status: 'DONE', ref: 5, remainingLots: null }, sub)).toBeNull();
    expect(v({ status: 'DONE', ref: '5', remainingLots: null, x: 1 }, sub)).toBeNull();
    expect(v({ status: 'DONE', ref: '5', remainingLots: '0' }, sub)).toBeNull();
    expect(v({ status: 'DONE', ref: '5', remainingLots: null }, sub)).not.toBeNull();
    expect(v({ status: 'NOT_FOUND' }, sub)).toBeNull();
    expect(v({ status: 'NOT_FOUND' }, cnl)).toEqual({ status: 'NOT_FOUND' });
    expect(v({ status: 'PARTIAL', doneLots: '0.05', remainingLots: '0.05' }, cnl)).toBeNull();
    expect(v({ status: 'PARTIAL', doneLots: '1', remainingLots: '0' }, cls)).toBeNull();
    expect(v({ status: 'PARTIAL', doneLots: '0', remainingLots: '0.10' }, cls)).toBeNull();
    expect(v({ status: 'PARTIAL', doneLots: '0.04', remainingLots: '0.07' }, cls)).toBeNull();
    expect(v({ status: 'PARTIAL', doneLots: '0.04', remainingLots: '0.06' }, cls)).not.toBeNull();
    expect(v({ status: 'DONE', ref: null, remainingLots: null }, cls)).toBeNull();
    expect(v({ status: 'DONE', ref: null, remainingLots: '0.20' }, cls)).toBeNull();
    expect(v({ status: 'REJECTED', reason: 'x'.repeat(10_000) }, sub)).toBeNull();
  });

  it('parseCommand returns a detached, frozen snapshot: later caller mutation cannot change it', () => {
    const raw = submit();
    const r = parseCommand(raw);
    if (!r.ok) throw new Error('fixture invalid');
    (raw.payload as Record<string, string>).lots = '99';
    raw.expiresAt = '2030-01-01T00:00:00.000Z';
    expect(r.command.payload).toMatchObject({ lots: '0.10' });
    expect(r.command.expiresAt).toBe('2026-10-05T10:00:30.000Z');
    expect(Object.isFrozen(r.command)).toBe(true);
    expect(Object.isFrozen(r.command.payload)).toBe(true);
    expect(r.command).not.toBe(raw);
  });

  it('rejects impossible calendar dates, bad times, inherited keys and oversized raw input cheaply', () => {
    const far = '2030-01-01T00:00:00.000Z';
    for (const t of [
      '2026-02-30',
      '2025-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-01-00',
    ])
      expect(parseCommand(submit({ issuedAt: `${t}T10:00:00.000Z`, expiresAt: far })).ok).toBe(
        false,
      );
    for (const t of [
      '2026-01-01T24:00:00.000Z',
      '2026-01-01T10:60:00.000Z',
      '2026-01-01T10:00:60.000Z',
    ])
      expect(parseCommand(submit({ issuedAt: t, expiresAt: far })).ok).toBe(false);
    expect(parseCommand(submit({ issuedAt: '2024-02-29T10:00:00.000Z', expiresAt: far })).ok).toBe(
      true,
    );
    expect(parseCommand(submit({ issuedAt: '2000-02-29T10:00:00.000Z', expiresAt: far })).ok).toBe(
      true,
    );
    expect(parseCommand(submit({ issuedAt: '1900-02-29T10:00:00.000Z', expiresAt: far })).ok).toBe(
      false,
    );
    expect(parseCommand(Object.assign(Object.create({ v: 1 }) as object, submit())).ok).toBe(false);
    expect(parseCommand(submit({ accountRef: 'mt5:' + 'x'.repeat(100_000) })).ok).toBe(false);
    expect(isUlongString('9'.repeat(100_000))).toBe(false);
    expect(decodeAccountRef('mt5:' + '['.repeat(100_000))).toBeNull();
  });

  it('a partial close is never CLOSED; an unproven remainder is not CLOSED either', () => {
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: '0' })).toBe('CLOSED');
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: '0.00' })).toBe('CLOSED');
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: '0.05' })).toBe('PARTIAL');
    expect(classifyClose({ status: 'PARTIAL', doneLots: '0.05', remainingLots: '0.05' })).toBe(
      'PARTIAL',
    );
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: null })).toBeNull();
    expect(classifyClose({ status: 'NOT_FOUND' })).toBeNull(); // absence is not closure proof
    expect(classifyClose(null)).toBeNull();
    const c = parseCommand({
      ...base,
      op: 'CLOSE',
      payload: { positionIdentifier: '1', lots: null },
    });
    expect((c.ok ? c.command : (null as unknown as BridgeCommand)).op).toBe('CLOSE');
  });
});
