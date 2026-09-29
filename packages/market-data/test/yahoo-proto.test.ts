import { describe, expect, it } from 'vitest';
import { base64Bytes, decodePricingData, shortestFloat32 } from '../src/feeds/yahoo-proto';
import { YFINANCE_BTC_MESSAGE, encodePricingData } from './yahoo-fixtures';

describe('Yahoo PricingData decoder', () => {
  it("reads Yahoo's real wire format (the yfinance test message, same values)", () => {
    const d = decodePricingData(base64Bytes(YFINANCE_BTC_MESSAGE));
    expect(d).toMatchObject({
      id: 'BTC-USD',
      price: 94745.08,
      time: 1736509140000,
      currency: 'USD',
      exchange: 'CCC',
      quoteType: 41,
      marketHours: 1,
      dayHigh: 95227.555,
      dayLow: 92517.22,
      dayVolume: 59712028672,
      lastSize: 59712028672,
      priceHint: 2,
      // This message has no bid / ask: a price only, never a tradable quote.
      bid: null,
      ask: null,
    });
  });

  it('reads bid, ask and sizes when present; negative sint64 values survive zigzag', () => {
    const d = decodePricingData(
      encodePricingData({
        id: 'EURUSD=X',
        price: 1.0855,
        time: 1_790_000_000_000,
        bid: 1.0854,
        ask: 1.0856,
        bidSize: 3,
        askSize: -1,
      }),
    );
    expect(d).toMatchObject({
      id: 'EURUSD=X',
      price: 1.0855,
      time: 1_790_000_000_000,
      bid: 1.0854,
      ask: 1.0856,
      bidSize: 3,
      askSize: -1,
    });
  });

  it('skips fields it does not read (doubles, unknown varints and strings)', () => {
    const double32 = [0x81, 0x02, 1, 2, 3, 4, 5, 6, 7, 8]; // field 32, 8-byte double
    const lastSize = [0xb0, 0x01, 0x05]; // field 22, sint64 zigzag(5) = -3
    const string30 = [0xf2, 0x01, 0x03, 0x42, 0x54, 0x43]; // field 30, "BTC"
    const extra = Uint8Array.from([
      ...encodePricingData({ id: 'NQ=F', price: 20000 }),
      ...double32,
      ...lastSize,
      ...string30,
    ]);
    const d = decodePricingData(extra);
    expect(d.id).toBe('NQ=F');
    expect(d.price).toBe(20000);
    expect(d.lastSize).toBe(-3);
  });

  it('rejects malformed input instead of guessing', () => {
    expect(() => decodePricingData(Uint8Array.from([0x0a, 0x05, 0x41]))).toThrow(/truncated/);
    expect(() => decodePricingData(Uint8Array.from([0x15, 0x00]))).toThrow(/truncated/);
    expect(() => decodePricingData(encodePricingData({ price: 1 }))).toThrow(/without an id/);
    expect(() => decodePricingData(Uint8Array.from([0x0b]))).toThrow(/unsupported wire type/);
    expect(() => decodePricingData(Uint8Array.from([0x02, 0x00]))).toThrow(/field number 0/);
    expect(() => base64Bytes('invalid_base64_string')).toThrow(/invalid base64/);
    expect(() => base64Bytes('abcde')).toThrow(/invalid base64/);
  });

  it('renders float32 values as their shortest round-tripping decimal', () => {
    expect(shortestFloat32(Math.fround(1.0855))).toBe(1.0855);
    expect(shortestFloat32(Math.fround(94745.08))).toBe(94745.08);
    expect(shortestFloat32(0)).toBe(0);
    expect(Number.isNaN(shortestFloat32(NaN))).toBe(true);
  });
});
