/**
 * News provider port and poller. Providers are PULLED every `intervalMs` for items published since
 * the last successful poll (minus an overlap; de-duplication absorbs repeats), with a timeout. A
 * failure leaves the feed un-refreshed, so it ages into STALE and the gate stops new trades.
 */
import { errorMessage, type Clock, type DataSourceKind } from '@astra/core';
import type { NewsIngestResult, NewsService } from './service';

export interface NewsAdapter {
  readonly id: string;
  /** LIVE for a real provider, MANUAL for operator-maintained, SIMULATED for tests. */
  readonly kind: DataSourceKind;
  /** Items published in [since, until] as `{ items: [...] }`. Throws on failure; honours `signal`. */
  fetch(range: { since: Date; until: Date }, signal: AbortSignal): Promise<unknown>;
}

export interface NewsPollerOptions {
  readonly adapter: NewsAdapter;
  readonly service: NewsService;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  /** How far back the first poll reaches. */
  readonly lookbackMs: number;
  readonly onResult?: ((result: NewsPollResult) => void) | undefined;
}

export type NewsPollResult =
  | ({ readonly ok: true; readonly at: string } & Omit<NewsIngestResult, 'added'>)
  | { readonly ok: false; readonly at: string; readonly error: string; readonly failures: number };

export interface NewsPollerStatus {
  readonly adapter: string;
  readonly kind: DataSourceKind;
  readonly running: boolean;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
}

const OVERLAP_MS = 5 * 60_000;

export class NewsPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<NewsPollResult> | null = null;
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private failures = 0;

  constructor(private readonly opts: NewsPollerOptions) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One fetch → ingest. Never overlaps with itself and never throws. */
  poll(): Promise<NewsPollResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  status(): NewsPollerStatus {
    return {
      adapter: this.opts.adapter.id,
      kind: this.opts.adapter.kind,
      running: this.timer !== undefined,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      consecutiveFailures: this.failures,
    };
  }

  private async run(): Promise<NewsPollResult> {
    const { adapter, service, clock } = this.opts;
    const now = clock.now();
    const at = now.toISOString();
    this.lastAttemptAt = at;
    const since = this.lastSuccessAt
      ? new Date(Date.parse(this.lastSuccessAt) - OVERLAP_MS)
      : new Date(now.getTime() - this.opts.lookbackMs);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: NewsPollResult;
    try {
      const raw = await Promise.race([
        adapter.fetch({ since, until: now }, controller.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new Error(`news provider ${adapter.id} timed out after ${this.opts.timeoutMs} ms`),
            );
          }, this.opts.timeoutMs);
        }),
      ]);
      const r = service.ingest(raw, adapter.id, adapter.kind);
      this.lastSuccessAt = at;
      this.lastError = null;
      this.failures = 0;
      result = {
        ok: true,
        at,
        accepted: r.accepted,
        duplicates: r.duplicates,
        rejected: r.rejected,
      };
    } catch (err) {
      this.failures++;
      this.lastError = errorMessage(err);
      result = { ok: false, at, error: this.lastError, failures: this.failures };
    } finally {
      clearTimeout(timeout);
    }
    this.opts.onResult?.(result);
    return result;
  }
}
