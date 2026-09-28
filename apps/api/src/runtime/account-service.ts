/**
 * Account monitor (spec §9, §25, §28): for every configured account, pull a snapshot from its
 * broker adapter, advance tracking (peaks, day-start values), compute the prop-firm account
 * state and risk health, record closed trades, and apply automatic halt conditions.
 * Runs inside the core so it keeps working when n8n is down (ADR-0005).
 */
import {
  errorMessage,
  notObserved,
  observeWithTimeout,
  observed,
  tradingDayWindow,
  type AccountActivity,
  type AccountDefinition,
  type AccountSnapshot,
  type Clock,
  type Observed,
} from '@astra/core';
import type { AstraConfig } from '@astra/config';
import type { AccountRepository, ClosedTradeRecord } from '@astra/db';
import { PaperBrokerAdapter, type BrokerAdapter } from '@astra/execution';
import {
  computeAccountState,
  initAccountTracking,
  updateAccountTracking,
  type AccountState,
  type AccountTracking,
} from '@astra/prop-firm';
import { classifyAccountHealth, type AccountHealthAssessment } from '@astra/risk';
import { evaluateAccountHaltConditions } from '@astra/safety';
import type { Logger } from 'pino';
import type { EventBus } from './event-bus';
import type { Valuation } from './valuation';
import type { HealthService } from './health-service';
import type { KillSwitchService } from './kill-switch-service';

export interface AccountView {
  readonly account: AccountDefinition;
  readonly snapshot: Observed<AccountSnapshot>;
  readonly tracking: AccountTracking | null;
  readonly state: AccountState | null;
  readonly health: AccountHealthAssessment | null;
  readonly activity: AccountActivity | null;
  readonly error: string | null;
  readonly syncedAt: string | null;
}

interface Entry {
  snapshot: Observed<AccountSnapshot>;
  tracking: AccountTracking | null;
  state: AccountState | null;
  health: AccountHealthAssessment | null;
  activity: AccountActivity | null;
  error: string | null;
  syncedAt: string | null;
  lastPersistedAt: number;
  lastPersistedHealth: string | null;
  closedSynced: number;
}

export class AccountService {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly deps: {
      config: AstraConfig;
      repo: AccountRepository;
      adapter: (adapterId: string) => BrokerAdapter | undefined;
      clock: Clock;
      events: EventBus;
      health: HealthService;
      killSwitches: KillSwitchService;
      log: Logger;
      providerTimeoutMs: number;
      /** Account-currency specs (converted with live quotes when an instrument needs it). */
      valuation: Valuation;
      /** Called once per newly recorded closed trade (trade journal). Must not throw. */
      onClosedTrade?: (accountId: string, trade: ClosedTradeRecord) => Promise<void>;
    },
  ) {
    for (const id of deps.config.accounts.keys()) {
      this.entries.set(id, {
        snapshot: notObserved('UNKNOWN', 'account not synced yet', 'account-monitor'),
        tracking: null,
        state: null,
        health: null,
        activity: null,
        error: null,
        syncedAt: null,
        lastPersistedAt: 0,
        lastPersistedHealth: null,
        closedSynced: 0,
      });
    }
  }

  snapshot(accountId: string): Observed<AccountSnapshot> {
    return (
      this.entries.get(accountId)?.snapshot ??
      notObserved('UNAVAILABLE', `unknown account ${accountId}`, 'account-monitor')
    );
  }

  tracking(accountId: string): Observed<AccountTracking> {
    const e = this.entries.get(accountId);
    if (!e?.tracking || e.snapshot.status !== 'OK') {
      return notObserved('UNAVAILABLE', 'account tracking not available', 'account-monitor');
    }
    return observed(e.tracking, {
      source: 'astra-account-tracking',
      sourceKind: e.snapshot.sourceKind,
      asOf: e.tracking.updatedAt,
    });
  }

  async activity(accountId: string): Promise<Observed<AccountActivity>> {
    const account = this.deps.config.accounts.get(accountId);
    const profile = account && this.deps.config.profiles.get(account.propFirmProfileId);
    if (!account || !profile)
      return notObserved('UNAVAILABLE', `unknown account ${accountId}`, 'account-activity');
    const now = this.deps.clock.now();
    const w = tradingDayWindow(now, profile.tradingDayReset);
    const a = await this.deps.repo.activity(accountId, {
      key: w.key,
      start: w.start.toISOString(),
      end: w.end.toISOString(),
    });
    return observed(a, { source: 'astra-db', sourceKind: 'LIVE', asOf: now.toISOString() });
  }

  view(accountId: string): AccountView | null {
    const account = this.deps.config.accounts.get(accountId);
    const e = this.entries.get(accountId);
    if (!account || !e) return null;
    return {
      account,
      snapshot: e.snapshot,
      tracking: e.tracking,
      state: e.state,
      health: e.health,
      activity: e.activity,
      error: e.error,
      syncedAt: e.syncedAt,
    };
  }

  views(): AccountView[] {
    return [...this.deps.config.accounts.keys()].map((id) => this.view(id)!);
  }

  async syncAll(): Promise<void> {
    let ok = 0;
    for (const account of this.deps.config.accounts.values()) {
      if (await this.sync(account)) ok++;
    }
    const total = this.deps.config.accounts.size;
    this.deps.health.report(
      'PROP_FIRM_ADAPTER',
      total === 0 ? 'UNKNOWN' : ok === total ? 'ONLINE' : ok > 0 ? 'DEGRADED' : 'ERROR',
      `${ok}/${total} accounts synced`,
    );
  }

  private async sync(account: AccountDefinition): Promise<boolean> {
    const entry = this.entries.get(account.id)!;
    const { config, clock, repo } = this.deps;
    const profile = config.profiles.get(account.propFirmProfileId)!;
    const policy = config.riskPolicies.get(account.riskPolicyId)!;
    const adapter = this.deps.adapter(account.broker.adapterId);
    try {
      if (!adapter) throw new Error(`execution adapter ${account.broker.adapterId} not registered`);
      const snap = await observeWithTimeout<AccountSnapshot>(
        `broker:${adapter.id}`,
        this.deps.providerTimeoutMs,
        async () => {
          const s = await adapter.getAccountSnapshot(account.broker.accountRef, account.id);
          return observed(s, {
            source: `broker:${adapter.id}`,
            sourceKind: adapter.kind === 'PAPER' ? 'SIMULATED' : 'LIVE',
            asOf: s.asOf,
          });
        },
      );
      entry.snapshot = snap;
      if (snap.status !== 'OK') throw new Error(`${snap.status}: ${snap.reason}`);

      await this.syncClosedTrades(account, adapter, entry);
      const activityObs = await this.activity(account.id);
      const activity = activityObs.status === 'OK' ? activityObs.value : null;
      entry.activity = activity;

      const trackingOpts = {
        reset: profile.tradingDayReset,
        tradedToday: (activity?.tradesToday ?? 0) > 0,
        lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
      };
      let tracking = entry.tracking ?? (await repo.getTracking(account.id));
      tracking = tracking
        ? updateAccountTracking(tracking, snap.value, trackingOpts)
        : initAccountTracking({
            accountId: account.id,
            initialBalance: profile.accountSize,
            snapshot: snap.value,
            reset: profile.tradingDayReset,
          });
      await repo.saveTracking(tracking);
      entry.tracking = tracking;

      const lookup = this.deps.valuation(account.currency);
      const state = computeAccountState({
        profile,
        tracking,
        snapshot: snap.value,
        instruments: lookup,
      });
      const health = activity
        ? classifyAccountHealth({ state, policy, activity, accountStatus: account.status })
        : null;
      const previousHealth = entry.health?.health ?? null;
      entry.state = state;
      entry.health = health;
      entry.error = null;
      entry.syncedAt = clock.now().toISOString();

      if (health && previousHealth !== null && previousHealth !== health.health) {
        await this.deps.events.emit({
          level: ['HALTED', 'BREACH_RISK'].includes(health.health)
            ? 'CRITICAL'
            : health.health === 'SAFE'
              ? 'INFO'
              : 'WARN',
          component: 'risk-engine',
          type: 'ACCOUNT_HEALTH_CHANGED',
          message: `${account.id} health ${previousHealth} → ${health.health}${health.reasons.length ? `: ${health.reasons.join('; ')}` : ''}`,
          accountId: account.id,
        });
      }

      const now = clock.now().getTime();
      if (
        now - entry.lastPersistedAt >= config.system.monitors.snapshotPersistIntervalMs ||
        entry.lastPersistedHealth !== (health?.health ?? null)
      ) {
        await repo.appendSnapshot(
          snap.value,
          state,
          health?.health ?? null,
          clock.now().toISOString(),
        );
        entry.lastPersistedAt = now;
        entry.lastPersistedHealth = health?.health ?? null;
      }

      await this.applyHalts(account, state, profile.tradingDayReset);
      return true;
    } catch (err) {
      entry.error = errorMessage(err);
      this.deps.log.warn({ accountId: account.id, err: entry.error }, 'account sync failed');
      return false;
    }
  }

  private async syncClosedTrades(
    account: AccountDefinition,
    adapter: BrokerAdapter,
    entry: Entry,
  ): Promise<void> {
    if (!(adapter instanceof PaperBrokerAdapter)) return;
    const closed = adapter.closedTrades(account.broker.accountRef);
    for (const t of closed.slice(entry.closedSynced)) {
      const record: ClosedTradeRecord = {
        id: t.positionId,
        accountId: account.id,
        clientOrderId: t.clientOrderId,
        symbol: t.symbol,
        direction: t.direction,
        quantity: t.quantity,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason,
        realizedPnl: t.realizedPnl,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      };
      const isNew = await this.deps.repo.recordClosedTrade(record);
      if (isNew) await this.deps.onClosedTrade?.(account.id, record);
      if (isNew) {
        await this.deps.events.emit({
          level: 'INFO',
          component: 'position-monitor',
          type: 'POSITION_CLOSED',
          message: `${t.symbol} ${t.direction} ${t.quantity} closed at ${t.exitPrice} (${t.exitReason}), P&L ${t.realizedPnl}`,
          accountId: account.id,
          data: { ...t },
        });
      }
    }
    entry.closedSynced = closed.length;
  }

  private async applyHalts(
    account: AccountDefinition,
    state: AccountState,
    reset: { timeZone: string; time: string },
  ): Promise<void> {
    const window = tradingDayWindow(this.deps.clock.now(), reset);
    const actions = evaluateAccountHaltConditions({
      accountId: account.id,
      breached: state.breached,
      dayLocked: state.dayLocked,
      nextTradingDayStart: window.end.toISOString(),
      unprotectedPositions: state.openRisk.positions
        .filter((p) => p.riskToStop === null)
        .map((p) => p.positionId),
    });
    for (const a of actions) {
      const existing = this.deps.killSwitches.registry.get(a.scope, a.target);
      if (existing?.active) continue; // never overwrite an active switch (e.g. a human's reason)
      await this.deps.killSwitches.activate({
        scope: a.scope,
        target: a.target,
        reason: a.reason,
        actor: { type: 'SYSTEM', id: 'halt-monitor' },
        clearPolicy: a.clearPolicy,
        autoClearAt: a.autoClearAt,
      });
    }
  }
}
