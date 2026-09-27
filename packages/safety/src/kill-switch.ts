/**
 * Kill switches (spec §24, §76). Any active switch whose scope matches a candidate blocks it.
 * The registry is FAIL-CLOSED: until state has been loaded from persistent storage, everything
 * is blocked (spec §18 startup sequence).
 */
import { AstraError, IsoDateTimeSchema, type Clock } from '@astra/core';
import { z } from 'zod';

export const KILL_SWITCH_SCOPES = [
  'GLOBAL',
  'ACCOUNT',
  'STRATEGY',
  'INSTRUMENT',
  'EXECUTION',
  'AI',
  'NEWS',
] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

/** Scopes that require a target (account id, strategy id, symbol). */
const TARGET_REQUIRED: ReadonlySet<KillSwitchScope> = new Set([
  'ACCOUNT',
  'STRATEGY',
  'INSTRUMENT',
]);
/** Scopes that never take a target. */
const TARGET_FORBIDDEN: ReadonlySet<KillSwitchScope> = new Set(['GLOBAL', 'AI']);

export const ActorSchema = z.object({
  type: z.enum(['HUMAN', 'SYSTEM']),
  /** Operator identity or system component name. */
  id: z.string().min(1).max(100),
});
export type Actor = z.infer<typeof ActorSchema>;

export const KillSwitchStateSchema = z.object({
  scope: z.enum(KILL_SWITCH_SCOPES),
  target: z.string().min(1).nullable(),
  active: z.boolean(),
  reason: z.string().min(1),
  changedBy: ActorSchema,
  changedAt: IsoDateTimeSchema,
  /** MANUAL: only a human clears it. NEXT_TRADING_DAY: the system clears it at autoClearAt. */
  clearPolicy: z.enum(['MANUAL', 'NEXT_TRADING_DAY']),
  autoClearAt: IsoDateTimeSchema.nullable(),
});
export type KillSwitchState = z.infer<typeof KillSwitchStateSchema>;

export interface KillSwitchChange {
  readonly previous: KillSwitchState | null;
  readonly next: KillSwitchState;
}

export interface KillSwitchContext {
  readonly accountId?: string;
  readonly strategyId?: string;
  readonly symbol?: string;
  /** Whether the candidate depends on AI analysis (the AI switch only blocks those). */
  readonly requiresAi?: boolean;
}

export interface KillSwitchEvaluation {
  readonly blocked: boolean;
  readonly loaded: boolean;
  readonly blocking: readonly KillSwitchState[];
  readonly reasons: readonly string[];
}

export function killSwitchKey(scope: KillSwitchScope, target: string | null): string {
  return `${scope}:${target ?? '*'}`;
}

export function validateKillSwitchTarget(scope: KillSwitchScope, target: string | null): void {
  if (TARGET_REQUIRED.has(scope) && target === null) {
    throw new AstraError('VALIDATION', `${scope} kill switch requires a target`);
  }
  if (TARGET_FORBIDDEN.has(scope) && target !== null) {
    throw new AstraError('VALIDATION', `${scope} kill switch does not take a target`);
  }
}

function matches(s: KillSwitchState, ctx: KillSwitchContext): boolean {
  switch (s.scope) {
    case 'GLOBAL':
      return true;
    case 'ACCOUNT':
      return s.target === ctx.accountId;
    case 'STRATEGY':
      return s.target === ctx.strategyId;
    case 'INSTRUMENT':
      return s.target === ctx.symbol;
    case 'EXECUTION':
      return s.target === null || s.target === ctx.accountId;
    case 'AI':
      return ctx.requiresAi === true;
    case 'NEWS':
      return s.target === null || s.target === ctx.symbol;
  }
}

export class KillSwitchRegistry {
  private readonly states = new Map<string, KillSwitchState>();
  private loaded = false;

  constructor(private readonly clock: Clock) {}

  /** Replaces in-memory state with persisted state and opens the registry. */
  load(states: readonly KillSwitchState[]): void {
    this.states.clear();
    for (const s of states) {
      const parsed = KillSwitchStateSchema.parse(s);
      this.states.set(killSwitchKey(parsed.scope, parsed.target), parsed);
    }
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  list(): KillSwitchState[] {
    return [...this.states.values()];
  }

  active(): KillSwitchState[] {
    return this.list().filter((s) => s.active);
  }

  get(scope: KillSwitchScope, target: string | null): KillSwitchState | null {
    return this.states.get(killSwitchKey(scope, target)) ?? null;
  }

  /** Activation takes effect in memory immediately (fail-safe); the caller persists the change. */
  activate(params: {
    scope: KillSwitchScope;
    target: string | null;
    reason: string;
    actor: Actor;
    clearPolicy?: KillSwitchState['clearPolicy'];
    autoClearAt?: string | null;
  }): KillSwitchChange {
    validateKillSwitchTarget(params.scope, params.target);
    const clearPolicy = params.clearPolicy ?? 'MANUAL';
    if (clearPolicy === 'NEXT_TRADING_DAY' && !params.autoClearAt) {
      throw new AstraError('VALIDATION', 'NEXT_TRADING_DAY kill switch requires autoClearAt');
    }
    const previous = this.get(params.scope, params.target);
    const next: KillSwitchState = {
      scope: params.scope,
      target: params.target,
      active: true,
      reason: params.reason,
      changedBy: params.actor,
      changedAt: this.clock.now().toISOString(),
      clearPolicy,
      autoClearAt: clearPolicy === 'NEXT_TRADING_DAY' ? (params.autoClearAt ?? null) : null,
    };
    this.states.set(killSwitchKey(next.scope, next.target), next);
    return { previous, next };
  }

  /**
   * Computes a deactivation WITHOUT applying it. The caller persists the change first and then
   * calls `apply` — so a failed write leaves the switch active (fail-safe).
   * A system actor may only clear NEXT_TRADING_DAY switches whose autoClearAt has passed.
   */
  planDeactivation(params: {
    scope: KillSwitchScope;
    target: string | null;
    reason: string;
    actor: Actor;
  }): KillSwitchChange {
    const previous = this.get(params.scope, params.target);
    if (!previous?.active) {
      throw new AstraError(
        'NOT_FOUND',
        `kill switch ${killSwitchKey(params.scope, params.target)} is not active`,
      );
    }
    if (params.actor.type === 'SYSTEM') {
      const due =
        previous.clearPolicy === 'NEXT_TRADING_DAY' &&
        previous.autoClearAt !== null &&
        Date.parse(previous.autoClearAt) <= this.clock.now().getTime();
      if (!due) {
        throw new AstraError('FORBIDDEN', 'only a human operator may clear this kill switch');
      }
    }
    return {
      previous,
      next: {
        ...previous,
        active: false,
        reason: params.reason,
        changedBy: params.actor,
        changedAt: this.clock.now().toISOString(),
      },
    };
  }

  apply(change: KillSwitchChange): void {
    this.states.set(killSwitchKey(change.next.scope, change.next.target), change.next);
  }

  /** NEXT_TRADING_DAY switches whose auto-clear time has passed. */
  dueForAutoClear(): KillSwitchState[] {
    const now = this.clock.now().getTime();
    return this.active().filter(
      (s) =>
        s.clearPolicy === 'NEXT_TRADING_DAY' &&
        s.autoClearAt !== null &&
        Date.parse(s.autoClearAt) <= now,
    );
  }

  evaluate(ctx: KillSwitchContext): KillSwitchEvaluation {
    if (!this.loaded) {
      return {
        blocked: true,
        loaded: false,
        blocking: [],
        reasons: ['kill-switch state not loaded (fail-closed until persisted state is restored)'],
      };
    }
    const blocking = this.active().filter((s) => matches(s, ctx));
    return {
      blocked: blocking.length > 0,
      loaded: true,
      blocking,
      reasons: blocking.map(
        (s) => `${s.scope} kill switch${s.target ? ` (${s.target})` : ''} active: ${s.reason}`,
      ),
    };
  }
}
