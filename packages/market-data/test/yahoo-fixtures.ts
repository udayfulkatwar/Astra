/**
 * Test helpers for the Yahoo feed: a minimal PricingData ENCODER (the inverse of the decoder, for
 * building test messages), a fake socket and fake timers. Test-only; nothing here is market data.
 */
import type { SocketLike, Timers } from '../src/feeds/yahoo-stream';

/**
 * A genuine message from the yfinance test suite (Apache-2.0, https://github.com/ranaroussi/yfinance,
 * `tests/test_live.py`, `test_decode_message_valid`, commit 0c5a6c49), with the values that test
 * expects. Used only to prove the decoder reads Yahoo's real wire format.
 */
export const YFINANCE_BTC_MESSAGE =
  'CgdCVEMtVVNEFYoMuUcYwLCVgIplIgNVU0QqA0NDQzApOAFFPWrEP0iAgOrxvANVx/25R12csrRHZYD8skR9/' +
  '7i0R7ABgIDq8bwD2AEE4AGAgOrxvAPoAYCA6vG8A/IBA0JUQ4ECAAAAwPrjckGJAgAA2P5ZT3tC';

export interface EncodeFields {
  id?: string;
  price?: number;
  time?: number;
  currency?: string;
  marketHours?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
}

function varint(n: bigint): number[] {
  const out: number[] = [];
  let v = BigInt.asUintN(64, n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}

const key = (field: number, wire: number) => varint(BigInt((field << 3) | wire));
const zig = (n: number) => varint((BigInt(n) << 1n) ^ (BigInt(n) >> 63n));

function float32(field: number, v: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return [...key(field, 5), ...b];
}

function text(field: number, s: string): number[] {
  const b = new TextEncoder().encode(s);
  return [...key(field, 2), ...varint(BigInt(b.length)), ...b];
}

export function encodePricingData(f: EncodeFields): Uint8Array {
  const out: number[] = [];
  if (f.id !== undefined) out.push(...text(1, f.id));
  if (f.price !== undefined) out.push(...float32(2, f.price));
  if (f.time !== undefined) out.push(...key(3, 0), ...zig(f.time));
  if (f.currency !== undefined) out.push(...text(4, f.currency));
  if (f.marketHours !== undefined) out.push(...key(7, 0), ...varint(BigInt(f.marketHours)));
  if (f.bid !== undefined) out.push(...float32(23, f.bid));
  if (f.bidSize !== undefined) out.push(...key(24, 0), ...zig(f.bidSize));
  if (f.ask !== undefined) out.push(...float32(25, f.ask));
  if (f.askSize !== undefined) out.push(...key(26, 0), ...zig(f.askSize));
  return Uint8Array.from(out);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A stream frame as Yahoo sends it: JSON text whose `message` is the base64 protobuf. */
export const frame = (f: EncodeFields): string =>
  JSON.stringify({ type: 'pricing', message: toBase64(encodePricingData(f)) });

export class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.onclose?.({});
  }
  /** An error event (Node's WebSocket sends no close after a failed handshake). */
  fail(message?: string): void {
    this.onerror?.(message === undefined ? {} : { message });
  }
}

/** Timers driven by the test: `run(ms)` fires what is due, in order. */
export class FakeTimers implements Timers {
  private nextId = 1;
  private now = 0;
  private readonly pending = new Map<
    number,
    { at: number; fn: () => void; every: number | null }
  >();

  constructor(private readonly onAdvance: (ms: number) => void = () => {}) {}

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, fn, every: null });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Delays of the pending one-shot timers (reconnect backoff). */
  timeouts(): number[] {
    return [...this.pending.values()].filter((t) => t.every === null).map((t) => t.at - this.now);
  }

  get count(): number {
    return this.pending.size;
  }

  run(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      this.onAdvance(t.at - this.now);
      this.now = t.at;
      if (t.every === null) this.pending.delete(id);
      else t.at += t.every;
      t.fn();
    }
    this.onAdvance(end - this.now);
    this.now = end;
  }
}
