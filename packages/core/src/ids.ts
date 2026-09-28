/**
 * UUIDv7: time-ordered (48-bit ms timestamp) + 74 random bits. Sortable ids make audit trails
 * and logs easy to read in order.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  // Web Crypto: available in Node.js ≥ 19 and every browser (keeps core isomorphic).
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ts = BigInt(nowMs);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const ID_PREFIXES = {
  candidate: 'cand',
  decision: 'dec',
  approval: 'apr',
  order: 'ord',
  event: 'evt',
  signal: 'sig',
  killSwitchEvent: 'ksw',
  snapshot: 'snap',
  backtest: 'btr',
  aiAnalysis: 'aia',
  aiReview: 'air',
  aiCall: 'aic',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind, nowMs?: number): string {
  return `${ID_PREFIXES[kind]}_${uuidv7(nowMs)}`;
}
