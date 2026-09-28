/**
 * News ingestion and state (ADR-0019). Items are validated one by one (a bad item is rejected and
 * reported; the rest are kept), de-duplicated (same provider id, or the same headline syndicated
 * by another source), classified, and kept for `retentionMs`.
 *
 * Freshness is about the FEED, not the items: a quiet market has no news, but a feed that has not
 * delivered (even an empty batch) within the freshness limit is STALE, and the gate then treats
 * news risk as unknown — no new trades. A source is bound to one data kind; the assessment reports
 * the least trustworthy kind among active sources (SIMULATED < MANUAL < HISTORICAL < LIVE).
 */
import {
  AstraError,
  applyFreshness,
  notObserved,
  observed,
  type Clock,
  type DataSourceKind,
  type FreshnessPolicy,
  type HealthStatus,
  type NewsRiskAssessment,
  type Observed,
} from '@astra/core';
import { z } from 'zod';
import {
  classifyNews,
  type ClassifiedNews,
  type InstrumentNewsProfile,
  type NewsCategory,
} from './classify';
import { NewsItemSchema, type NewsImpact } from './item';
import { assessNewsRisk, sentimentFor, type NewsRiskRule, type SentimentView } from './risk';

export interface NewsServiceOptions {
  readonly clock: Clock;
  /** The decision policy's `newsMaxAgeMs` and `maxFutureSkewMs`. */
  readonly freshness: FreshnessPolicy;
  readonly instruments: ReadonlyMap<string, InstrumentNewsProfile>;
  readonly risk: NewsRiskRule;
  /** Items older than this (by publication time) are dropped. */
  readonly retentionMs: number;
  /** Newly accepted items (not called when there are none). */
  readonly onItems?: ((added: readonly ClassifiedNews[], source: string) => void) | undefined;
}

export interface NewsIngestResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: { readonly index: number; readonly reason: string }[];
  readonly added: ClassifiedNews[];
}

export interface NewsFeedStatus {
  readonly sources: { source: string; kind: DataSourceKind; lastUpdateAt: string }[];
  readonly lastUpdateAt: string | null;
  readonly items: number;
}

export interface NewsQuery {
  readonly symbol?: string | undefined;
  readonly minImpact?: NewsImpact | undefined;
  readonly category?: NewsCategory | undefined;
  readonly limit?: number | undefined;
}

const TRUST: Record<DataSourceKind, number> = { SIMULATED: 0, MANUAL: 1, HISTORICAL: 2, LIVE: 3 };
const IMPACT_RANK: Record<NewsImpact, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const SYNDICATION_WINDOW_MS = 6 * 3_600_000;
const BatchSchema = z.object({ items: z.array(z.unknown()).max(5_000) });

const normalize = (headline: string) =>
  headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export class NewsService {
  private readonly items = new Map<string, ClassifiedNews>();
  /** Normalised headline → key of the first copy (syndication de-duplication). */
  private readonly headlines = new Map<string, string>();
  private readonly sources = new Map<string, { kind: DataSourceKind; lastUpdateAt: string }>();

  constructor(private readonly opts: NewsServiceOptions) {}

  /** Validates, de-duplicates, classifies and stores a batch `{ items: [...] }`. */
  ingest(raw: unknown, source: string, sourceKind: DataSourceKind): NewsIngestResult {
    const batch = BatchSchema.safeParse(raw);
    if (!batch.success)
      throw new AstraError(
        'VALIDATION',
        `invalid news batch from ${source}: ${z.prettifyError(batch.error)}`,
      );
    const bound = this.sources.get(source)?.kind;
    if (bound !== undefined && bound !== sourceKind)
      throw new AstraError(
        'VALIDATION',
        `news source ${source} delivers ${bound} data; refusing ${sourceKind}`,
      );
    const now = this.opts.clock.now();
    const nowIso = now.toISOString();
    const rejected: NewsIngestResult['rejected'] = [];
    const added: ClassifiedNews[] = [];
    let duplicates = 0;
    batch.data.items.forEach((rawItem, index) => {
      const parsed = NewsItemSchema.safeParse(rawItem);
      if (!parsed.success) {
        rejected.push({ index, reason: z.prettifyError(parsed.error).replace(/\n/g, '; ') });
        return;
      }
      const item = parsed.data;
      if (Date.parse(item.publishedAt) - now.getTime() > this.opts.freshness.maxFutureSkewMs) {
        rejected.push({ index, reason: `published in the future (${item.publishedAt})` });
        return;
      }
      const key = `${source}:${item.id}`;
      const norm = normalize(item.headline);
      const copyOf = this.headlines.get(norm);
      const copy = copyOf ? this.items.get(copyOf) : undefined;
      if (
        this.items.has(key) ||
        (copy &&
          Math.abs(Date.parse(copy.item.publishedAt) - Date.parse(item.publishedAt)) <
            SYNDICATION_WINDOW_MS)
      ) {
        duplicates++;
        return;
      }
      const n = classifyNews({
        item,
        source,
        sourceKind,
        receivedAt: nowIso,
        instruments: this.opts.instruments,
      });
      this.items.set(key, n);
      this.headlines.set(norm, key);
      added.push(n);
    });
    this.sources.set(source, { kind: sourceKind, lastUpdateAt: nowIso });
    this.prune(now);
    if (added.length > 0) this.opts.onItems?.(added, source);
    return { accepted: added.length, duplicates, rejected, added };
  }

  /** Restores stored items (e.g. after a restart). Does NOT make the feed fresh. */
  load(items: readonly ClassifiedNews[]): void {
    for (const n of items) {
      if (this.items.has(n.key)) continue;
      this.items.set(n.key, n);
      this.headlines.set(normalize(n.item.headline), n.key);
    }
    this.prune(this.opts.clock.now());
  }

  /** Newest first. */
  list(q: NewsQuery = {}): ClassifiedNews[] {
    const min = q.minImpact ? IMPACT_RANK[q.minImpact] : 0;
    return [...this.items.values()]
      .filter(
        (n) =>
          IMPACT_RANK[n.impact] >= min &&
          (!q.category || n.category === q.category) &&
          (!q.symbol || n.affected.some((a) => a.symbol === q.symbol)),
      )
      .sort(
        (a, b) =>
          b.item.publishedAt.localeCompare(a.item.publishedAt) || a.key.localeCompare(b.key),
      )
      .slice(0, Math.min(Math.max(q.limit ?? 100, 1), 1_000));
  }

  feedStatus(): NewsFeedStatus {
    const sources = [...this.sources.entries()]
      .map(([source, s]) => ({ source, kind: s.kind, lastUpdateAt: s.lastUpdateAt }))
      .sort((a, b) => b.lastUpdateAt.localeCompare(a.lastUpdateAt));
    return { sources, lastUpdateAt: sources[0]?.lastUpdateAt ?? null, items: this.items.size };
  }

  /**
   * News risk for one instrument, observed as of the feed's last delivery (freshness is applied
   * by the gate). UNAVAILABLE until a feed has delivered.
   */
  risk(symbol: string): Observed<NewsRiskAssessment> {
    const feed = this.activeFeed();
    if (!feed) return notObserved('UNAVAILABLE', 'no news feed has delivered yet', 'news');
    const now = this.opts.clock.now();
    const r = assessNewsRisk([...this.items.values()], symbol, now, this.opts.risk);
    return observed<NewsRiskAssessment>(
      {
        symbol,
        level: r.level,
        assessedAt: now.toISOString(),
        reasons: r.reasons,
        items: r.items,
        clearsAt: r.clearsAt,
      },
      { source: feed.source, sourceKind: feed.kind, asOf: feed.asOf },
    );
  }

  /** News risk with freshness applied now (for views; the gate applies its own). */
  freshRisk(symbol: string): Observed<NewsRiskAssessment> {
    return applyFreshness(this.risk(symbol), this.opts.clock.now(), this.opts.freshness);
  }

  sentiment(symbol: string): SentimentView {
    return sentimentFor([...this.items.values()], symbol, this.opts.clock.now());
  }

  /** NEWS component health: ONLINE only while a feed is fresh. */
  health(): { status: HealthStatus; detail: string } {
    const feed = this.activeFeed();
    if (!feed) return { status: 'UNKNOWN', detail: 'no news feed has delivered yet' };
    const age = this.opts.clock.now().getTime() - Date.parse(feed.asOf);
    if (age > this.opts.freshness.maxAgeMs)
      return {
        status: 'DEGRADED',
        detail: `news feed STALE: last delivery ${Math.round(age / 1000)} s ago from ${feed.source}`,
      };
    return {
      status: 'ONLINE',
      detail: `${this.items.size} items; last delivery from ${feed.source} (${feed.kind})`,
    };
  }

  /** The latest delivery, labelled with the least trustworthy kind among recently active sources. */
  private activeFeed(): { source: string; kind: DataSourceKind; asOf: string } | null {
    const list = this.feedStatus().sources;
    const latest = list[0];
    if (!latest) return null;
    const cutoff = Date.parse(latest.lastUpdateAt) - this.opts.freshness.maxAgeMs;
    const active = list.filter((s) => Date.parse(s.lastUpdateAt) >= cutoff);
    const weakest = active.reduce((w, s) => (TRUST[s.kind] < TRUST[w.kind] ? s : w), latest);
    return {
      source: active.length > 1 ? active.map((s) => s.source).join('+') : latest.source,
      kind: weakest.kind,
      asOf: latest.lastUpdateAt,
    };
  }

  private prune(now: Date): void {
    const cutoff = now.getTime() - this.opts.retentionMs;
    for (const [key, n] of this.items) {
      if (Date.parse(n.item.publishedAt) >= cutoff) continue;
      this.items.delete(key);
      const norm = normalize(n.item.headline);
      if (this.headlines.get(norm) === key) this.headlines.delete(norm);
    }
  }
}
