/**
 * Decoder for Yahoo Finance's streaming `PricingData` protobuf message (proto3). The schema is
 * the one published in the open-source yfinance project (Apache-2.0,
 * https://github.com/ranaroussi/yfinance, `yfinance/pricing.proto`); only the fields ASTRA
 * reads are kept. Dependency-free and isomorphic (Node and browsers).
 *
 * Floats are proto `float` (32-bit): each is returned as the shortest decimal that round-trips
 * to the same float32, as protobuf's JSON mapping does (1.5344921, not 1.534492135047913).
 */

export interface PricingData {
  readonly id: string;
  readonly price: number | null;
  /** Epoch milliseconds (sint64). */
  readonly time: number | null;
  readonly currency: string | null;
  readonly exchange: string | null;
  readonly quoteType: number | null;
  /** Yahoo's market-hours code (0 pre, 1 regular, 2 post, 3 extended — per Yahoo, not verified). */
  readonly marketHours: number | null;
  readonly dayHigh: number | null;
  readonly dayLow: number | null;
  readonly dayVolume: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly bidSize: number | null;
  readonly askSize: number | null;
  readonly lastSize: number | null;
  readonly priceHint: number | null;
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint');
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  }

  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('truncated field');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Shortest decimal that is the same float32 (protobuf JSON's rendering of `float`). */
export function shortestFloat32(f: number): number {
  if (!Number.isFinite(f) || f === 0) return f;
  for (let p = 1; p <= 9; p++) {
    const v = Number(f.toPrecision(p));
    if (Math.fround(v) === f) return v;
  }
  return f;
}

const zigzag = (n: bigint): bigint => (n >> 1n) ^ -(n & 1n);

function safe(n: bigint): number {
  const v = Number(n);
  if (!Number.isSafeInteger(v)) throw new Error(`integer out of range: ${n}`);
  return v;
}

const decoder = new TextDecoder();

/** Decodes one PricingData message. Throws on malformed input (the caller rejects the message). */
export function decodePricingData(bytes: Uint8Array): PricingData {
  const r = new Reader(bytes);
  const out: { -readonly [K in keyof PricingData]: PricingData[K] } = {
    id: '',
    price: null,
    time: null,
    currency: null,
    exchange: null,
    quoteType: null,
    marketHours: null,
    dayHigh: null,
    dayLow: null,
    dayVolume: null,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    lastSize: null,
    priceHint: null,
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (!r.done) {
    const key = safe(r.varint());
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 0) throw new Error('field number 0');
    if (wire === 0) {
      const v = r.varint();
      switch (field) {
        case 3:
          out.time = safe(zigzag(v));
          break;
        case 6:
          out.quoteType = Number(BigInt.asIntN(32, v));
          break;
        case 7:
          out.marketHours = Number(BigInt.asIntN(32, v));
          break;
        case 9:
          out.dayVolume = safe(zigzag(v));
          break;
        case 22:
          out.lastSize = safe(zigzag(v));
          break;
        case 24:
          out.bidSize = safe(zigzag(v));
          break;
        case 26:
          out.askSize = safe(zigzag(v));
          break;
        case 27:
          out.priceHint = safe(zigzag(v));
          break;
        default:
          break; // fields ASTRA does not read
      }
    } else if (wire === 5) {
      const at = r.pos;
      r.bytes(4);
      const f = shortestFloat32(view.getFloat32(at, true));
      switch (field) {
        case 2:
          out.price = f;
          break;
        case 10:
          out.dayHigh = f;
          break;
        case 11:
          out.dayLow = f;
          break;
        case 23:
          out.bid = f;
          break;
        case 25:
          out.ask = f;
          break;
        default:
          break;
      }
    } else if (wire === 1) {
      r.bytes(8); // doubles (circulating supply, market cap): not read
    } else if (wire === 2) {
      const len = safe(r.varint());
      const b = r.bytes(len);
      const text = () => decoder.decode(b);
      switch (field) {
        case 1:
          out.id = text();
          break;
        case 4:
          out.currency = text();
          break;
        case 5:
          out.exchange = text();
          break;
        default:
          break;
      }
    } else {
      throw new Error(`unsupported wire type ${wire} (field ${field})`);
    }
  }
  if (out.id === '') throw new Error('PricingData without an id');
  return out;
}

/** Base64 (standard alphabet) → bytes; throws on invalid input. */
export function base64Bytes(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1)
    throw new Error('invalid base64');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
