/**
 * Core wiring of @astra/market-data: persistence of completed bars.
 *
 * Bars are queued as they complete and written in batches by the safety loop (and on shutdown).
 * A failed write is logged and retried on the next flush — it never throws into quote ingestion
 * or the loop. The queue is bounded: during a long database outage the oldest unpersisted bars
 * are dropped (logged); they stay in the in-memory windows until evicted.
 */
import { errorMessage } from '@astra/core';
import type { Bar, BarStore } from '@astra/market-data';
import type { Logger } from 'pino';

const FLUSH_BATCH = 500;

export class BarPersister {
  private pending: Bar[] = [];
  private inFlight: Promise<void> | null = null;
  private persistedCount = 0;
  private droppedCount = 0;

  constructor(
    private readonly store: BarStore,
    private readonly log: Logger,
    private readonly maxPending = 20_000,
  ) {}

  enqueue(bars: readonly Bar[]): void {
    this.pending.push(...bars);
    const excess = this.pending.length - this.maxPending;
    if (excess > 0) {
      this.pending.splice(0, excess);
      this.droppedCount += excess;
      this.log.error(
        { dropped: excess, totalDropped: this.droppedCount },
        'market bar queue full (database unavailable?): oldest unpersisted bars dropped',
      );
    }
  }

  /** Writes every queued bar; resolves (never rejects) when done or after a failed batch. */
  flush(): Promise<void> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  stats(): { pending: number; persisted: number; dropped: number } {
    return {
      pending: this.pending.length,
      persisted: this.persistedCount,
      dropped: this.droppedCount,
    };
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, FLUSH_BATCH);
      try {
        await this.store.upsert(batch);
      } catch (err) {
        this.log.error(
          { err: errorMessage(err), bars: batch.length, pending: this.pending.length },
          'failed to persist market bars; will retry',
        );
        return;
      }
      this.pending.splice(0, batch.length);
      this.persistedCount += batch.length;
    }
  }
}
