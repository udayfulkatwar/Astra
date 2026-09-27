/**
 * Automatic protection (ADR-0014; owner-authorised): after every position-monitor pass, closes
 * positions when a deterministic trigger fires (@astra/risk `ProtectionEvaluator`) through the
 * execution gateway's risk-reducing `protectiveClose`. Every attempt is audited and raised as an
 * event; a failure is retried up to `maxCloseAttempts`, then a human is asked to act.
 */
import type { AstraConfig } from '@astra/config';
import { tradingDayWindow, type Clock } from '@astra/core';
import type { AuditRepository } from '@astra/db';
import type { ExecutionGateway } from '@astra/execution';
import {
  DEFAULT_PROTECTION_POLICY,
  ProtectionEvaluator,
  type AccountMonitorView,
  type ProtectionPolicy,
  type ProtectionStatus,
  type ProtectiveAction,
  type ProtectiveActionRecord,
} from '@astra/risk';
import type { EventBus } from './event-bus';
import type { KillSwitchService } from './kill-switch-service';

const RECENT = 50;
const ACTOR = { type: 'SYSTEM' as const, id: 'protection' };

export class ProtectionService {
  readonly policy: ProtectionPolicy;
  private readonly evaluator: ProtectionEvaluator;
  /** accountId:positionId → failed attempts (REJECTED). */
  private readonly attempts = new Map<string, number>();
  /** Positions already closed or found flat — never acted on again. */
  private readonly done = new Set<string>();
  /** Skips / give-ups already reported (reported once, not every cycle). */
  private readonly reported = new Set<string>();
  private readonly recent: ProtectiveActionRecord[] = [];

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      gateway: ExecutionGateway;
      killSwitches: KillSwitchService;
      events: EventBus;
      audit: AuditRepository;
    },
  ) {
    this.policy = deps.config.system.protection ?? DEFAULT_PROTECTION_POLICY;
    this.evaluator = new ProtectionEvaluator(this.policy);
  }

  async run(views: readonly AccountMonitorView[]): Promise<void> {
    const { config, clock } = this.deps;
    const now = clock.now();
    const actions = this.evaluator.evaluate(views, {
      now,
      holding: (id) => {
        const a = config.accounts.get(id);
        return (a && config.profiles.get(a.propFirmProfileId)?.holding) ?? null;
      },
    });
    for (const a of actions) {
      const key = `${a.accountId}:${a.positionId}`;
      if (this.done.has(key)) continue;
      if (a.blockAccount) await this.blockAccount(a);
      await this.close(a, key);
    }
  }

  status(): ProtectionStatus {
    return { enabled: this.policy.enabled, policy: this.policy, recent: [...this.recent] };
  }

  /** Blocks new trades on the account before closing (no-op when already blocked). */
  private async blockAccount(a: ProtectiveAction): Promise<void> {
    const { config, clock, killSwitches } = this.deps;
    if (
      killSwitches.list().some((s) => s.active && s.scope === 'ACCOUNT' && s.target === a.accountId)
    )
      return;
    const account = config.accounts.get(a.accountId);
    const profile = account && config.profiles.get(account.propFirmProfileId);
    const nextDay =
      a.blockAccount === 'NEXT_TRADING_DAY' && profile
        ? tradingDayWindow(clock.now(), profile.tradingDayReset).end.toISOString()
        : null;
    await killSwitches.activate({
      scope: 'ACCOUNT',
      target: a.accountId,
      reason: `automatic protection: ${a.reason}`,
      actor: ACTOR,
      ...(nextDay
        ? { clearPolicy: 'NEXT_TRADING_DAY' as const, autoClearAt: nextDay }
        : { clearPolicy: 'MANUAL' as const }),
    });
  }

  private async close(a: ProtectiveAction, key: string): Promise<void> {
    const failed = this.attempts.get(key) ?? 0;
    if (failed >= this.policy.maxCloseAttempts) {
      await this.reportOnce(`${key}:GAVE_UP`, a, 'GAVE_UP', failed, {
        detail: `${failed} close attempts failed — MANUAL ACTION REQUIRED`,
      });
      return;
    }
    const attempt = failed + 1;
    const r = await this.deps.gateway.protectiveClose({
      accountId: a.accountId,
      positionId: a.positionId,
      clientCloseId: `protect-${a.trigger}-${a.positionId}-${attempt}`,
      reason: `automatic protection (${a.trigger}): ${a.reason}`,
    });
    const fields = {
      detail: r.reason,
      exitPrice: r.exitPrice,
      realizedPnl: r.realizedPnl,
    };
    switch (r.outcome) {
      case 'SKIPPED':
        await this.reportOnce(`${key}:SKIPPED:${r.reason}`, a, 'SKIPPED', attempt, fields);
        return;
      case 'CLOSED':
      case 'ALREADY_FLAT':
        this.done.add(key);
        this.attempts.delete(key);
        break;
      case 'REJECTED':
        this.attempts.set(key, attempt);
        break;
      case 'UNKNOWN':
        // The gateway halted execution for the account; nothing more is sent automatically.
        this.done.add(key);
        break;
    }
    await this.record(a, r.outcome, attempt, fields);
  }

  private async reportOnce(
    id: string,
    a: ProtectiveAction,
    outcome: ProtectiveActionRecord['outcome'],
    attempt: number,
    fields: { detail: string; exitPrice?: number | null; realizedPnl?: number | null },
  ): Promise<void> {
    if (this.reported.has(id)) return;
    this.reported.add(id);
    await this.record(a, outcome, attempt, fields);
  }

  private async record(
    a: ProtectiveAction,
    outcome: ProtectiveActionRecord['outcome'],
    attempt: number,
    fields: { detail: string; exitPrice?: number | null; realizedPnl?: number | null },
  ): Promise<void> {
    const at = this.deps.clock.now().toISOString();
    const rec: ProtectiveActionRecord = {
      at,
      trigger: a.trigger,
      accountId: a.accountId,
      positionId: a.positionId,
      symbol: a.symbol,
      reason: a.reason,
      outcome,
      detail: fields.detail,
      exitPrice: fields.exitPrice ?? null,
      realizedPnl: fields.realizedPnl ?? null,
      attempt,
    };
    this.recent.unshift(rec);
    if (this.recent.length > RECENT) this.recent.pop();
    const message =
      outcome === 'CLOSED'
        ? `ASTRA closed ${a.reason} — automatic protection (${a.trigger}) at ${rec.exitPrice}, P&L ${rec.realizedPnl}`
        : outcome === 'ALREADY_FLAT'
          ? `automatic protection (${a.trigger}): ${a.positionId} already flat`
          : `automatic protection (${a.trigger}) could not close ${a.reason}: ${outcome} — ${fields.detail}`;
    await this.deps.events.emit({
      level: outcome === 'ALREADY_FLAT' ? 'INFO' : 'CRITICAL',
      component: 'protection',
      type: `PROTECTIVE_CLOSE_${outcome}`,
      message,
      accountId: a.accountId,
      data: { ...rec },
    });
    try {
      await this.deps.audit.append({
        actor: ACTOR,
        category: 'PROTECTION',
        action: `PROTECTIVE_CLOSE_${outcome}`,
        entityType: 'position',
        entityId: a.positionId,
        payload: { ...rec },
        at,
      });
    } catch (err) {
      await this.deps.events.emit({
        level: 'CRITICAL',
        component: 'protection',
        type: 'PROTECTION_AUDIT_FAILED',
        message: `protective action not audited: ${err instanceof Error ? err.message : String(err)}`,
        accountId: a.accountId,
      });
    }
  }
}
