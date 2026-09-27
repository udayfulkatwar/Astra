/**
 * Maximum favourable / adverse excursion of open positions, from observed exit-side prices only
 * (LONG → bid, SHORT → ask). Tracking starts when a position is first seen; if that is later than
 * `fullCoverageGraceMs` after it opened, earlier prices were not observed and the excursion is
 * PARTIAL — never filled in.
 */
import type { Direction, Quote } from '@astra/core';

export interface TrackedPosition {
  readonly accountId: string;
  readonly positionId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly entryPrice: number;
  readonly openedAt: string;
}

export interface ExcursionRecord {
  /** Most favourable exit-side price seen (incl. the entry). */
  readonly bestPrice: number;
  /** Most adverse exit-side price seen (incl. the entry). */
  readonly worstPrice: number;
  readonly observedFrom: string;
  /** FULL: observed from (about) the open; PARTIAL: tracking began later. */
  readonly coverage: 'FULL' | 'PARTIAL';
  readonly quotes: number;
}

interface State extends TrackedPosition {
  best: number;
  worst: number;
  observedFrom: string;
  coverage: 'FULL' | 'PARTIAL';
  quotes: number;
}

export class ExcursionTracker {
  private readonly positions = new Map<string, State>();

  constructor(private readonly opts: { fullCoverageGraceMs?: number } = {}) {}

  /**
   * Registers the currently open positions (new ones start at their entry price). Positions that
   * are no longer open are NOT dropped here — `take()` collects them when the close is recorded;
   * `prune()` drops the ones nobody collected.
   */
  sync(open: readonly TrackedPosition[], now: Date): void {
    const grace = this.opts.fullCoverageGraceMs ?? 5_000;
    for (const p of open) {
      if (this.positions.has(p.positionId)) continue;
      const late = now.getTime() - Date.parse(p.openedAt) > grace;
      this.positions.set(p.positionId, {
        ...p,
        best: p.entryPrice,
        worst: p.entryPrice,
        observedFrom: late ? now.toISOString() : p.openedAt,
        coverage: late ? 'PARTIAL' : 'FULL',
        quotes: 0,
      });
    }
  }

  onQuote(quote: Quote): void {
    for (const s of this.positions.values()) {
      if (s.symbol !== quote.symbol) continue;
      const px = s.direction === 'LONG' ? quote.bid : quote.ask;
      const better = s.direction === 'LONG' ? px > s.best : px < s.best;
      const worse = s.direction === 'LONG' ? px < s.worst : px > s.worst;
      if (better) s.best = px;
      if (worse) s.worst = px;
      s.quotes++;
    }
  }

  /** Removes and returns a position's excursion (null if it was never seen open). */
  take(positionId: string): ExcursionRecord | null {
    const s = this.positions.get(positionId);
    if (!s) return null;
    this.positions.delete(positionId);
    return {
      bestPrice: s.best,
      worstPrice: s.worst,
      observedFrom: s.observedFrom,
      coverage: s.coverage,
      quotes: s.quotes,
    };
  }

  /**
   * Drops tracked positions that are not open anymore and were never collected — except those of
   * accounts for which `keepAccount` is true (e.g. accounts that could not be read this time).
   */
  prune(
    open: readonly { positionId: string }[],
    keepAccount: (accountId: string) => boolean = () => false,
  ): void {
    const ids = new Set(open.map((p) => p.positionId));
    for (const [id, s] of this.positions)
      if (!ids.has(id) && !keepAccount(s.accountId)) this.positions.delete(id);
  }

  size(): number {
    return this.positions.size;
  }
}
