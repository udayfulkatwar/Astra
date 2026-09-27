/**
 * Quote data-quality monitor. Per symbol it tracks the last quote time, the spread in ticks and
 * the quote-to-quote move of the mid. A move larger than the instrument's `maxQuoteJumpTicks`
 * marks the symbol SUSPECT for a cooldown; while suspect, the market-data service reports its
 * quote as INVALID, so the `data.quote` gate check rejects every trade on it.
 *
 * Both sides of a jump are suspect (a bad tick, or the return from one, or a genuine gap), so the
 * newest quote always becomes the reference and every further abnormal move restarts the
 * cooldown. A gap after a market closure is treated the same way (fail-closed at the reopen).
 * Instruments without `maxQuoteJumpTicks` get no jump detection — the gap is reported by
 * `jumpGuard: false` in the state rather than silently assumed safe.
 */
import type { Quote } from '@astra/core';
import { quoteMid, spreadTicks, ticksBetween } from './price';

export const DEFAULT_SUSPECT_COOLDOWN_MS = 60_000;

export interface QualitySpec {
  readonly tickSize: number;
  readonly maxQuoteJumpTicks?: number | undefined;
}

export interface QuoteQuality {
  /** Source time of the last accepted quote. */
  readonly lastQuoteAt: string | null;
  readonly spreadTicks: number | null;
  /** Mid move from the previous quote, in ticks. */
  readonly lastMoveTicks: number | null;
  /** Source time of the last ABNORMAL jump. */
  readonly lastJumpAt: string | null;
  /** Whether jump detection is configured for the instrument. */
  readonly jumpGuard: boolean;
  readonly suspect: boolean;
  readonly suspectUntil: string | null;
  /** Why the symbol is suspect (null when it is not). */
  readonly reason: string | null;
}

interface SymbolState {
  lastQuoteAt: string;
  mid: number;
  spreadTicks: number;
  lastMoveTicks: number | null;
  lastJumpAt: string | null;
  suspectUntilMs: number;
  reason: string | null;
  jumpGuard: boolean;
}

export class QuoteQualityMonitor {
  private readonly state = new Map<string, SymbolState>();
  private readonly cooldownMs: number;

  constructor(opts: { cooldownMs?: number } = {}) {
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_SUSPECT_COOLDOWN_MS;
  }

  /** Records an accepted quote; returns true when it moved abnormally far. */
  observe(quote: Quote, spec: QualitySpec, nowMs: number): boolean {
    const mid = quoteMid(quote);
    const prev = this.state.get(quote.symbol);
    const move = prev ? ticksBetween(mid, prev.mid, spec.tickSize) : null;
    const limit = spec.maxQuoteJumpTicks;
    const abnormal = move !== null && limit !== undefined && move > limit;
    const next: SymbolState = {
      lastQuoteAt: quote.asOf,
      mid,
      spreadTicks: spreadTicks(quote, spec.tickSize),
      lastMoveTicks: move,
      lastJumpAt: prev?.lastJumpAt ?? null,
      suspectUntilMs: prev?.suspectUntilMs ?? Number.NEGATIVE_INFINITY,
      reason: prev?.reason ?? null,
      jumpGuard: limit !== undefined,
    };
    if (abnormal) {
      next.lastJumpAt = quote.asOf;
      next.suspectUntilMs = nowMs + this.cooldownMs;
      next.reason =
        `abnormal price jump of ${move} ticks (limit ${limit}) at ${quote.asOf}; ` +
        `quotes treated as INVALID until ${new Date(next.suspectUntilMs).toISOString()}`;
    }
    this.state.set(quote.symbol, next);
    return abnormal;
  }

  quality(symbol: string, nowMs: number): QuoteQuality {
    const s = this.state.get(symbol);
    if (!s) {
      return {
        lastQuoteAt: null,
        spreadTicks: null,
        lastMoveTicks: null,
        lastJumpAt: null,
        jumpGuard: false,
        suspect: false,
        suspectUntil: null,
        reason: null,
      };
    }
    const suspect = nowMs < s.suspectUntilMs;
    return {
      lastQuoteAt: s.lastQuoteAt,
      spreadTicks: s.spreadTicks,
      lastMoveTicks: s.lastMoveTicks,
      lastJumpAt: s.lastJumpAt,
      jumpGuard: s.jumpGuard,
      suspect,
      suspectUntil: suspect ? new Date(s.suspectUntilMs).toISOString() : null,
      reason: suspect ? s.reason : null,
    };
  }
}
