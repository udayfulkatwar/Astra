/**
 * Calendar provider port and poller. Calendars change slowly, so providers are PULLED: every
 * `intervalMs` the poller asks the adapter for [now − lookback, now + lookahead] with a timeout.
 * A failure keeps the previous window, which then ages into STALE — the gate stops new trades
 * rather than trading on an unknown calendar.
 */
import { errorMessage, type Clock, type DataSourceKind } from '@astra/core';
import type { CalendarChange, CalendarService } from './service';

export interface CalendarAdapter {
  readonly id: string;
  /** LIVE for a real provider's current data, MANUAL for operator-maintained, SIMULATED for tests. */
  readonly kind: DataSourceKind;
  /**
   * The provider's events for the range, as a window `{ from, to, events }` in which the provider
   * asserts completeness (validated by the service). Throws on failure; honours `signal`.
   */
  fetch(range: { from: Date; to: Date }, signal: AbortSignal): Promise<unknown>;
}

export interface CalendarPollerOptions {
  readonly adapter: CalendarAdapter;
  readonly service: CalendarService;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly lookbackMs: number;
  readonly lookaheadMs: number;
  readonly onResult?: ((result: PollResult) => void) | undefined;
}

export type PollResult =
  | {
      readonly ok: true;
      readonly at: string;
      readonly events: number;
      readonly changes: readonly CalendarChange[];
    }
  | { readonly ok: false; readonly at: string; readonly error: string; readonly failures: number };

export interface PollerStatus {
  readonly adapter: string;
  readonly kind: DataSourceKind;
  readonly running: boolean;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
}

export class CalendarPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<PollResult> | null = null;
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private failures = 0;

  constructor(private readonly opts: CalendarPollerOptions) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs);
    // Node: do not keep the process alive for the poller (no-op in browsers).
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One fetch → ingest. Never overlaps with itself and never throws. */
  poll(): Promise<PollResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  status(): PollerStatus {
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

  private async run(): Promise<PollResult> {
    const { adapter, service, clock } = this.opts;
    const now = clock.now();
    const at = now.toISOString();
    this.lastAttemptAt = at;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: PollResult;
    try {
      const raw = await Promise.race([
        adapter.fetch(
          {
            from: new Date(now.getTime() - this.opts.lookbackMs),
            to: new Date(now.getTime() + this.opts.lookaheadMs),
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new Error(
                `calendar provider ${adapter.id} timed out after ${this.opts.timeoutMs} ms`,
              ),
            );
          }, this.opts.timeoutMs);
        }),
      ]);
      const ingested = service.ingest(raw, adapter.id, adapter.kind);
      this.lastSuccessAt = at;
      this.lastError = null;
      this.failures = 0;
      result = { ok: true, at, events: ingested.events, changes: ingested.changes };
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
