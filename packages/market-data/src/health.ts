/** Feed health from per-instrument quote freshness (the MARKET_DATA component). */
import type { Observed, Quote } from '@astra/core';
import type { AdapterHealth } from './adapter';

/**
 * ONLINE when every instrument has a fresh, valid quote; DEGRADED when only some do; UNKNOWN
 * when none do or nothing needs quotes. Silence is never reported as healthy.
 */
export function feedHealth(
  symbols: readonly string[],
  fresh: (symbol: string) => Observed<Quote>,
): AdapterHealth {
  if (symbols.length === 0) {
    return { status: 'UNKNOWN', detail: 'no instruments are traded by active accounts' };
  }
  const ok: string[] = [];
  const bad: string[] = [];
  for (const symbol of symbols) {
    const q = fresh(symbol);
    if (q.status === 'OK') ok.push(`${symbol} (${q.source})`);
    else bad.push(`${symbol} ${q.status}: ${q.reason}`);
  }
  if (bad.length === 0) {
    return {
      status: 'ONLINE',
      detail: `fresh quotes for ${ok.length}/${symbols.length}: ${ok.join(', ')}`,
    };
  }
  if (ok.length === 0) return { status: 'UNKNOWN', detail: `no fresh quotes — ${bad.join('; ')}` };
  return {
    status: 'DEGRADED',
    detail: `fresh quotes for ${ok.length}/${symbols.length}: ${ok.join(', ')}; not fresh — ${bad.join('; ')}`,
  };
}
