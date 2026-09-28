/**
 * SIMULATED news feed for paper tests, the demo and backtests: a deterministic stream (the same
 * time range always yields the same items) of placeholder headlines, every one prefixed
 * "SIMULATED —", with simulated provider sentiment. Its data kind is SIMULATED, which the gate
 * refuses in SHADOW and LIVE. It is not news and says nothing about any market.
 */
import type { NewsItem } from './item';
import type { NewsAdapter } from './poller';

type Template = Omit<NewsItem, 'id' | 'publishedAt'>;

const s = (headline: string) => `SIMULATED — ${headline}`;

const ROUTINE: readonly Template[] = [
  {
    headline: s('Tech shares extend gains in early trading'),
    providerSentiment: { label: 'BULLISH', confidence: 0.6 },
  },
  {
    headline: s('US inflation data comes in above expectations'),
    providerSentiment: { label: 'BEARISH', confidence: 0.7 },
  },
  {
    headline: s('Fed officials signal patience on rates'),
    providerSentiment: { label: 'NEUTRAL', confidence: 0.5 },
  },
  {
    headline: s('Gold edges higher as the dollar softens'),
    providerSentiment: { label: 'BULLISH', confidence: 0.6 },
  },
  {
    headline: s('Oil slips on supply outlook'),
    providerSentiment: { label: 'BEARISH', confidence: 0.4 },
  },
  {
    headline: s('Weekly jobless claims little changed'),
    currencies: ['USD'],
    providerSentiment: { label: 'NEUTRAL', confidence: 0.5 },
  },
  {
    headline: s('European shares mixed ahead of ECB meeting'),
    providerSentiment: { label: 'NEUTRAL', confidence: 0.4 },
  },
  {
    headline: s('Chip maker earnings beat estimates'),
    symbols: ['NQ', 'MNQ'],
    providerSentiment: { label: 'BULLISH', confidence: 0.7 },
  },
  {
    headline: s('Bitcoin volatility rises'),
    providerSentiment: { label: 'NEUTRAL', confidence: 0.3 },
  },
  {
    headline: s('Bond yields climb after Treasury auction'),
    providerSentiment: { label: 'BEARISH', confidence: 0.5 },
  },
  {
    headline: s('Gold slips as yields rise'),
    providerSentiment: { label: 'BEARISH', confidence: 0.6 },
  },
  {
    headline: s('Nasdaq futures steady before data'),
    providerSentiment: { label: 'NEUTRAL', confidence: 0.5 },
  },
  {
    headline: s('Trade tariffs back in focus'),
    countries: ['US', 'CN'],
    providerSentiment: { label: 'BEARISH', confidence: 0.5 },
  },
];

const HIGH_IMPACT: readonly Template[] = [
  {
    headline: s('Emergency rate meeting announced (test of high-impact handling)'),
    currencies: ['USD'],
    providerSentiment: { label: 'VERY_BEARISH', confidence: 0.6 },
  },
  {
    headline: s('Exchange reports trading halt in index futures (test of high-impact handling)'),
    providerSentiment: { label: 'BEARISH', confidence: 0.5 },
  },
];

/** Small integer hash (deterministic across platforms). */
function hash(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export class SimulatedNewsAdapter implements NewsAdapter {
  readonly id: string;
  readonly kind = 'SIMULATED' as const;
  private readonly seed: number;
  private readonly slotMs: number;

  constructor(opts: { id?: string; seed?: number; slotMinutes?: number } = {}) {
    this.id = opts.id ?? 'simulation';
    this.seed = opts.seed ?? 1;
    this.slotMs = (opts.slotMinutes ?? 20) * 60_000;
  }

  /** Items published in [since, until] — a pure function of the range. */
  itemsBetween(since: Date, until: Date): NewsItem[] {
    const out: NewsItem[] = [];
    const first = Math.floor(since.getTime() / this.slotMs);
    const last = Math.floor(until.getTime() / this.slotMs);
    for (let slot = first; slot <= last; slot++) {
      const r = hash(this.seed, slot);
      if (r % 100 >= 35) continue; // about one item per hour on average
      const pick = hash(this.seed + 1, slot);
      const high = pick % 100 < 4;
      const list = high ? HIGH_IMPACT : ROUTINE;
      const template = list[(pick >>> 8) % list.length]!;
      const at = slot * this.slotMs + (hash(this.seed + 2, slot) % this.slotMs);
      if (at < since.getTime() || at > until.getTime()) continue;
      out.push({ ...template, id: `sim-${slot}`, publishedAt: new Date(at).toISOString() });
    }
    return out;
  }

  fetch(range: { since: Date; until: Date }): Promise<unknown> {
    return Promise.resolve({ items: this.itemsBetween(range.since, range.until) });
  }

  /** A HIGH-impact placeholder item at `at` (the demo's "breaking news" button). */
  breaking(at: Date): NewsItem {
    return {
      ...HIGH_IMPACT[0]!,
      id: `sim-breaking-${at.getTime()}`,
      publishedAt: at.toISOString(),
    };
  }
}
