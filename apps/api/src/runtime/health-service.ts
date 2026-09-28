/**
 * Component health: active probes (database, market-data and calendar freshness, execution adapters) +
 * passive reports.
 */
import { type Clock, type ComponentId, type HealthStatus } from '@astra/core';
import { pingDb, type HeartbeatRepository, type Sql } from '@astra/db';
import type { BrokerAdapter } from '@astra/execution';
import { ComponentHealthRegistry } from '@astra/safety';

export class HealthService {
  readonly registry: ComponentHealthRegistry;

  constructor(
    clock: Clock,
    staleAfterMs: Readonly<Record<ComponentId, number>>,
    private readonly deps: {
      sql: Sql;
      heartbeats: HeartbeatRepository;
      adapters: () => readonly BrokerAdapter[];
      /** MARKET_DATA from quote freshness of the traded instruments (all / some / none fresh). */
      marketData: () => { status: HealthStatus; detail: string };
      /** CALENDAR from calendar freshness (the gate's `calendarMaxAgeMs`). */
      calendar: () => { status: HealthStatus; detail: string };
      /** NEWS from news-feed freshness (the gate's `newsMaxAgeMs`). */
      news: () => { status: HealthStatus; detail: string };
    },
  ) {
    const policies = Object.fromEntries(
      Object.entries(staleAfterMs).map(([c, ms]) => [c, { staleAfterMs: ms }]),
    ) as Record<ComponentId, { staleAfterMs: number }>;
    this.registry = new ComponentHealthRegistry(clock, policies);
  }

  report(component: ComponentId, status: HealthStatus, detail: string): void {
    this.registry.report(component, status, detail);
  }

  /** Restores persisted heartbeats with their original timestamps (they decay normally). */
  async seedFromHeartbeats(): Promise<void> {
    for (const h of await this.deps.heartbeats.list()) {
      this.registry.report(h.component, h.status, `${h.detail} (restored)`, new Date(h.reportedAt));
    }
  }

  async probe(): Promise<void> {
    const dbOk = await pingDb(this.deps.sql);
    this.registry.report(
      'DATABASE',
      dbOk ? 'ONLINE' : 'ERROR',
      dbOk ? 'connected' : 'database unreachable',
    );

    const market = this.deps.marketData();
    this.registry.report('MARKET_DATA', market.status, market.detail);

    const calendar = this.deps.calendar();
    this.registry.report('CALENDAR', calendar.status, calendar.detail);

    const news = this.deps.news();
    this.registry.report('NEWS', news.status, news.detail);

    const adapters = this.deps.adapters();
    if (adapters.length === 0) {
      this.registry.report('EXECUTION', 'UNKNOWN', 'no execution adapters registered');
      return;
    }
    const results = await Promise.all(
      adapters.map(async (a) => {
        try {
          return { id: a.id, ...(await a.health()) };
        } catch (err) {
          return {
            id: a.id,
            status: 'ERROR' as const,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    const worst =
      results.find((r) => r.status === 'ERROR') ??
      results.find((r) => r.status !== 'ONLINE') ??
      results[0]!;
    this.registry.report(
      'EXECUTION',
      worst.status,
      results.map((r) => `${r.id}: ${r.status} ${r.detail}`).join('; '),
    );
  }
}
