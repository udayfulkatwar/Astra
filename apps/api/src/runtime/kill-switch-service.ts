/**
 * Kill-switch service. Ordering is chosen for safety:
 *  - activation: in memory FIRST (blocks immediately), then persisted; a persistence failure
 *    keeps the switch active and raises a CRITICAL event.
 *  - deactivation: persisted FIRST, then applied; a persistence failure leaves it active.
 */
import type { Clock } from '@astra/core';
import type { KillSwitchRepository } from '@astra/db';
import {
  KillSwitchRegistry,
  type Actor,
  type KillSwitchContext,
  type KillSwitchEvaluation,
  type KillSwitchScope,
  type KillSwitchState,
} from '@astra/safety';
import type { EventBus } from './event-bus';

export class KillSwitchService {
  readonly registry: KillSwitchRegistry;

  constructor(
    private readonly repo: KillSwitchRepository,
    clock: Clock,
    private readonly events: EventBus,
  ) {
    this.registry = new KillSwitchRegistry(clock);
  }

  async load(): Promise<void> {
    this.registry.load(await this.repo.loadAll());
  }

  evaluate(ctx: KillSwitchContext): KillSwitchEvaluation {
    return this.registry.evaluate(ctx);
  }

  list(): KillSwitchState[] {
    return this.registry.list();
  }

  async activate(params: {
    scope: KillSwitchScope;
    target: string | null;
    reason: string;
    actor: Actor;
    clearPolicy?: KillSwitchState['clearPolicy'];
    autoClearAt?: string | null;
  }): Promise<{ state: KillSwitchState; persisted: boolean }> {
    const change = this.registry.activate(params);
    let persisted = true;
    try {
      await this.repo.persist(change);
    } catch (err) {
      persisted = false;
      await this.events.emit({
        level: 'CRITICAL',
        component: 'kill-switch',
        type: 'KILL_SWITCH_PERSIST_FAILED',
        message: `${params.scope} kill switch active in memory but NOT persisted: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    await this.events.emit({
      level: 'CRITICAL',
      component: 'kill-switch',
      type: 'KILL_SWITCH_ACTIVATED',
      message: `${params.scope}${params.target ? ` (${params.target})` : ''} kill switch activated by ${params.actor.type}:${params.actor.id}: ${params.reason}`,
      accountId: params.scope === 'ACCOUNT' || params.scope === 'EXECUTION' ? params.target : null,
      data: { scope: params.scope, target: params.target },
    });
    return { state: change.next, persisted };
  }

  async deactivate(params: {
    scope: KillSwitchScope;
    target: string | null;
    reason: string;
    actor: Actor;
  }): Promise<KillSwitchState> {
    const change = this.registry.planDeactivation(params);
    await this.repo.persist(change);
    this.registry.apply(change);
    await this.events.emit({
      level: 'WARN',
      component: 'kill-switch',
      type: 'KILL_SWITCH_DEACTIVATED',
      message: `${params.scope}${params.target ? ` (${params.target})` : ''} kill switch cleared by ${params.actor.type}:${params.actor.id}: ${params.reason}`,
      data: { scope: params.scope, target: params.target },
    });
    return change.next;
  }

  /** Clears NEXT_TRADING_DAY switches whose time has come (system actor). */
  async autoClearDue(): Promise<void> {
    for (const s of this.registry.dueForAutoClear()) {
      await this.deactivate({
        scope: s.scope,
        target: s.target,
        reason: 'new trading day',
        actor: { type: 'SYSTEM', id: 'halt-monitor' },
      });
    }
  }
}
