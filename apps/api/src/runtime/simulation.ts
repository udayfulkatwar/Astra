/**
 * SIMULATED feeds for paper testing (spec §65). Enabled only with ASTRA_SIMULATION=true.
 * Every observation is labelled sourceKind SIMULATED, which the decision gate refuses in
 * SHADOW and LIVE. The random walk is a simulator, not market data.
 */
import type { Clock } from '@astra/core';
import type { CalendarService } from './calendar';
import type { MarketDataService } from './market-data';

export interface SimulationConfig {
  readonly quoteIntervalMs: number;
  readonly instruments: Readonly<
    Record<string, { startPrice: number; volatilityTicks: number; spreadTicks: number }>
  >;
}

export class SimulationFeed {
  private timer: NodeJS.Timeout | undefined;
  private readonly prices = new Map<string, number>();

  constructor(
    private readonly cfg: SimulationConfig,
    private readonly tickSize: (symbol: string) => number | undefined,
    private readonly market: MarketDataService,
    private readonly calendar: CalendarService,
    private readonly clock: Clock,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.cfg.quoteIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  tick(): void {
    const now = this.clock.now();
    for (const [symbol, s] of Object.entries(this.cfg.instruments)) {
      const tick = this.tickSize(symbol);
      if (tick === undefined) continue;
      const prev = this.prices.get(symbol) ?? s.startPrice;
      const steps = Math.round((this.random() * 2 - 1) * s.volatilityTicks);
      const mid = Math.max(tick, Math.round((prev + steps * tick) / tick) * tick);
      this.prices.set(symbol, mid);
      const bid = Number(mid.toFixed(10));
      const ask = Number((mid + s.spreadTicks * tick).toFixed(10));
      this.market.ingest({ symbol, bid, ask, asOf: now.toISOString() }, 'simulation', 'SIMULATED');
    }
    // Simulated calendar: asserts coverage with no events. Only meaningful for paper tests.
    this.calendar.ingest(
      {
        from: new Date(now.getTime() - 24 * 3_600_000).toISOString(),
        to: new Date(now.getTime() + 7 * 24 * 3_600_000).toISOString(),
        events: [],
      },
      'simulation',
      'SIMULATED',
      now.toISOString(),
    );
  }
}
