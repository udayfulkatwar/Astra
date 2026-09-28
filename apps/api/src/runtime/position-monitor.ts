/**
 * Position monitor loop (Phase 8): after each account sync, evaluates every ACTIVE account's open
 * positions and limit buffers (@astra/risk `monitorAccount`) and records alert transitions as
 * system events. It observes and warns only — it never modifies orders or closes positions.
 */
import type { AstraConfig } from '@astra/config';
import type { Clock } from '@astra/core';
import type { MarketDataService } from '@astra/market-data';
import {
  DEFAULT_MONITOR_POLICY,
  MonitorAlertTracker,
  monitorAccount,
  type AccountMonitorView,
  type MonitorAlert,
  type MonitorPolicy,
} from '@astra/risk';
import type { AccountService } from './account-service';
import type { EventBus } from './event-bus';
import { marketValuation } from './valuation';

export interface PositionMonitorSnapshot {
  readonly asOf: string | null;
  readonly policy: MonitorPolicy;
  readonly accounts: AccountMonitorView[];
  readonly alerts: MonitorAlert[];
}

export class PositionMonitorService {
  readonly policy: MonitorPolicy;
  private readonly tracker: MonitorAlertTracker;
  private views: AccountMonitorView[] = [];
  private asOf: string | null = null;

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      accounts: AccountService;
      market: MarketDataService;
      events: EventBus;
    },
  ) {
    this.policy = deps.config.system.monitors.positions ?? DEFAULT_MONITOR_POLICY;
    this.tracker = new MonitorAlertTracker(this.policy);
  }

  async evaluate(): Promise<void> {
    const { config, clock, accounts, market, events } = this.deps;
    const valuation = marketValuation(config, market);
    const now = clock.now();
    this.views = accounts
      .views()
      .filter((v) => v.account.status === 'ACTIVE')
      .map((v) =>
        monitorAccount({
          accountId: v.account.id,
          now,
          snapshot: v.snapshot,
          state: v.state,
          drawdownRule: config.profiles.get(v.account.propFirmProfileId)!.maxDrawdown,
          instruments: valuation(v.account.currency),
          quote: (s) => market.fresh(s),
          policy: this.policy,
        }),
      );
    this.asOf = now.toISOString();
    for (const c of this.tracker.update(this.views, now)) {
      const a = c.alert;
      await events.emit({
        level: c.change === 'CLEARED' ? 'INFO' : a.level,
        component: 'position-monitor',
        type: `POSITION_${a.kind}_${c.change}`,
        message: c.change === 'CLEARED' ? `cleared: ${a.message}` : a.message,
        accountId: a.accountId,
        data: { key: a.key, positionId: a.positionId, symbol: a.symbol, level: a.level },
      });
    }
  }

  snapshot(): PositionMonitorSnapshot {
    return {
      asOf: this.asOf,
      policy: this.policy,
      accounts: this.views,
      alerts: this.tracker.list(),
    };
  }
}
