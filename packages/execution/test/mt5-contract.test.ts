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

  it('a malformed fake-terminal reply is not an outcome', () => {
    expect(validateTransportResult({ status: 'WAT' })).toBeNull();
    expect(validateTransportResult({ status: 'DONE', ref: 5, remainingLots: null })).toBeNull();
    expect(
      validateTransportResult({ status: 'PARTIAL', doneLots: '1', remainingLots: '0' }),
    ).toBeNull();
    expect(validateTransportResult(null)).toBeNull();
    expect(validateTransportResult({ status: 'NOT_FOUND' })).toEqual({ status: 'NOT_FOUND' });
  });

  it('a partial close is never CLOSED; an unproven remainder is not CLOSED either', () => {
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: '0' })).toBe('CLOSED');
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: '0.00' })).toBe('CLOSED');
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: '0.05' })).toBe('PARTIAL');
    expect(classifyClose({ status: 'PARTIAL', doneLots: '0.05', remainingLots: '0.05' })).toBe(
      'PARTIAL',
    );
    expect(classifyClose({ status: 'DONE', ref: '1', remainingLots: null })).toBeNull();
    expect(classifyClose(null)).toBeNull();
    const c = parseCommand({
      ...base,
      op: 'CLOSE',
      payload: { positionIdentifier: '1', lots: null },
    });
    expect((c.ok ? c.command : (null as unknown as BridgeCommand)).op).toBe('CLOSE');
  });
});
