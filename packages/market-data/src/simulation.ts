/**
 * SIMULATED quote feed for paper testing (spec §65). Every observation is labelled
 * sourceKind SIMULATED, which the decision gate refuses in SHADOW and LIVE. The random walk is a
 * simulator, not market data; its start prices are configuration seeds.
 */
import { dec, toNum, type Clock } from '@astra/core';
import type { AdapterHealth, MarketDataAdapter, QuoteSink } from './adapter';

export interface SimulatedInstrument {
  readonly startPrice: number;
  readonly volatilityTicks: number;
  readonly spreadTicks: number;
}

export interface SimulationAdapterOptions {
  readonly id?: string;
  readonly intervalMs: number;
  readonly instruments: Readonly<Record<string, SimulatedInstrument>>;
  /** Instrument tick size; symbols without one are skipped. */
  readonly tickSize: (symbol: string) => number | undefined;
  readonly clock: Clock;
  readonly random?: () => number;
  /** Called after every simulated tick (the API pushes its simulated calendar window here). */
  readonly onTick?: (now: Date) => void;
}

export class SimulationAdapter implements MarketDataAdapter {
  readonly id: string;
  readonly kind = 'SIMULATED' as const;
  private sink: QuoteSink | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly prices = new Map<string, number>();
  private readonly random: () => number;

  constructor(private readonly opts: SimulationAdapterOptions) {
    this.id = opts.id ?? 'simulation';
    this.random = opts.random ?? Math.random;
  }

  start(sink: QuoteSink): void {
    this.sink = sink;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    // Node: do not keep the process alive for the simulator (no-op in browsers).
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.sink = null;
  }

  health(): AdapterHealth {
    return this.sink
      ? {
          status: 'ONLINE',
          detail: `SIMULATED random walk for ${Object.keys(this.opts.instruments).length} instruments (refused in SHADOW/LIVE)`,
        }
      : { status: 'UNKNOWN', detail: 'simulation not running' };
  }

  /** One random-walk step for every simulated instrument (no-op when not started). */
  tick(): void {
    const sink = this.sink;
    if (!sink) return;
    const now = this.opts.clock.now();
    for (const [symbol, s] of Object.entries(this.opts.instruments)) {
      const tick = this.opts.tickSize(symbol);
      if (tick === undefined) continue;
      const prev = this.prices.get(symbol) ?? s.startPrice;
      const steps = Math.round((this.random() * 2 - 1) * s.volatilityTicks);
      const moved = dec(prev).plus(dec(steps).mul(tick)).div(tick).round().mul(tick);
      const bid = toNum(moved.lt(tick) ? dec(tick) : moved, 10);
      this.prices.set(symbol, bid);
      const ask = toNum(dec(bid).plus(dec(s.spreadTicks).mul(tick)), 10);
      sink({ symbol, bid, ask, asOf: now.toISOString() });
    }
    this.opts.onTick?.(now);
  }
}
