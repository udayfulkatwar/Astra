/**
 * Resting LIMIT entries (ADR-0023). A LIMIT order can fill at the broker without asking ASTRA
 * again, so every safety-loop cycle:
 *
 * 1. reads each non-final order from its broker and records fills, expiries and cancellations;
 * 2. cancels a still-resting order as soon as something the gate relied on no longer holds:
 *    the mode or a kill switch forbids new trades, the economic calendar or news feed is not
 *    fresh, a restricted event now falls inside the order's blackout window, or news risk blocks.
 *
 * Cancelling only removes exposure. A failed or unknown cancel is reported (and an unknown
 * outcome halts execution for the account, like any unconfirmed order).
 */
import type { CalendarService } from '@astra/calendar';
import type { AstraConfig } from '@astra/config';
import { applyFreshness, assessBlackout, describeNotOk, modePolicy, type Clock } from '@astra/core';
import type { ExecutionRepository } from '@astra/db';
import { mergedBlackout } from '@astra/decision';
import { isWorking, type ExecutionGateway, type OrderRecord } from '@astra/execution';
import type { NewsService } from '@astra/news';
import type { Logger } from 'pino';
import type { EventBus } from './event-bus';
import type { KillSwitchService } from './kill-switch-service';
import type { ModeService } from './mode-service';

export class WorkingOrderService {
  /** Cancel attempts already reported for an order (reported once, retried every cycle). */
  private readonly reported = new Set<string>();

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      store: ExecutionRepository;
      gateway: ExecutionGateway;
      mode: ModeService;
      killSwitches: KillSwitchService;
      calendar: CalendarService;
      news: NewsService;
      events: EventBus;
      log: Logger;
    },
  ) {}

  async run(): Promise<void> {
    for (const account of this.deps.config.accounts.values()) {
      const orders = await this.deps.store.workingOrdersForAccount(account.id);
      for (const o of orders) {
        if (!o.adapterId) continue;
        const r = await this.deps.gateway.refresh(o);
        if (r.changed && r.state) await this.reportChange(o, r.state.status, r.state);
        if (!r.state || !isWorking(r.state)) continue;
        const why = this.cancelReason(o);
        if (why) await this.cancel(o, why);
      }
    }
  }

  /** Why a resting order must go now, or null while everything the gate checked still holds. */
  cancelReason(o: OrderRecord): string | null {
    const { config, clock } = this.deps;
    const now = clock.now();
    const mode = this.deps.mode.current();
    if (!modePolicy(mode).newTradesAllowed) return `mode ${mode} does not permit new trades`;
    const ks = this.deps.killSwitches.evaluate({
      accountId: o.accountId,
      strategyId: o.strategyId,
      symbol: o.symbol,
    });
    if (ks.blocked) return `kill switch: ${ks.reasons.join('; ')}`;

    const policy = config.system.decision;
    const f = policy.freshness;
    const skew = { maxFutureSkewMs: f.maxFutureSkewMs };
    const cal = applyFreshness(this.deps.calendar.current(), now, {
      maxAgeMs: f.calendarMaxAgeMs,
      ...skew,
    });
    if (cal.status !== 'OK') return describeNotOk('economic calendar', cal);
    const account = config.accounts.get(o.accountId);
    const firm = account ? config.profiles.get(account.propFirmProfileId)?.news : undefined;
    const strategy = config.strategies.get(o.strategyId)?.eventBlackout;
    // The most restrictive of the global, strategy and firm windows (as at the gate).
    let rule = mergedBlackout(policy.eventBlackout, strategy ?? undefined);
    if (firm) rule = mergedBlackout(rule, firm);
    const until = o.expiresAt ? new Date(o.expiresAt) : now;
    const blackout = assessBlackout(cal.value, o.symbol, now, rule, until);
    if (blackout.state === 'UNCOVERED')
      return 'economic calendar does not cover the rest of the order’s window';
    if (blackout.state === 'BLACKOUT') {
      const e = blackout.blocking[0]!;
      return `${e.impact}-impact event "${e.title}" at ${e.scheduledAt} is inside the order’s blackout window`;
    }

    if (policy.news.required) {
      const n = applyFreshness(this.deps.news.risk(o.symbol), now, {
        maxAgeMs: f.newsMaxAgeMs,
        ...skew,
      });
      if (n.status !== 'OK') return describeNotOk('news risk', n);
      if (policy.news.blockLevels.includes(n.value.level))
        return `news risk ${n.value.level}: ${n.value.reasons.join('; ') || 'no detail'}`;
    }
    return null;
  }

  private async cancel(o: OrderRecord, reason: string): Promise<void> {
    const c = await this.deps.gateway.cancelWorking({
      accountId: o.accountId,
      clientOrderId: o.clientOrderId,
      reason,
    });
    const key = `${o.clientOrderId}:${c.outcome}`;
    if (c.outcome === 'CANCELLED') {
      await this.deps.events.emit({
        level: 'WARN',
        component: 'execution',
        type: 'ORDER_CANCELLED',
        message: `resting ${o.direction} LIMIT ${o.quantity} ${o.symbol} @ ${o.plannedEntry} cancelled: ${reason}`,
        accountId: o.accountId,
        data: { clientOrderId: o.clientOrderId, reason },
      });
    } else if (c.outcome === 'FILLED') {
      await this.reportChange(o, 'FILLED', c.state);
    } else if (!this.reported.has(key)) {
      this.reported.add(key);
      await this.deps.events.emit({
        level: 'CRITICAL',
        component: 'execution',
        type: `ORDER_CANCEL_${c.outcome}`,
        message: `could not cancel resting ${o.symbol} LIMIT ${o.clientOrderId} (${reason}): ${c.reason}`,
        accountId: o.accountId,
        data: { clientOrderId: o.clientOrderId, reason, outcome: c.outcome },
      });
    }
  }

  private async reportChange(
    o: OrderRecord,
    status: string,
    state: { averageFillPrice: number | null; rejectReason: string | null } | null,
  ): Promise<void> {
    const what = `${o.direction} ${o.entryType} ${o.quantity} ${o.symbol} @ ${o.plannedEntry}`;
    const message =
      status === 'FILLED'
        ? `${what} filled at ${state?.averageFillPrice}`
        : status === 'EXPIRED'
          ? `${what} expired unfilled (${state?.rejectReason ?? 'limit not reached'}): missed entry, no trade`
          : `${what} is now ${status}`;
    await this.deps.events.emit({
      level: 'INFO',
      component: 'execution',
      type: `ORDER_${status}`,
      message,
      accountId: o.accountId,
      data: { clientOrderId: o.clientOrderId, status },
    });
  }
}
