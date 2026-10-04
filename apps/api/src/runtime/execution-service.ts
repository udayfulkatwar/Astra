/**
 * Execution wiring: broker adapters, the execution gateway, startup reconciliation (spec §18:
 * open orders are reconciled with the broker before new trades are allowed) and persistence of
 * paper-broker state.
 */
import {
  AstraError,
  errorMessage,
  newId,
  type AccountDefinition,
  type Clock,
  type InstrumentSpec,
  type Quote,
} from '@astra/core';
import type { AstraConfig } from '@astra/config';
import type {
  ExecutionRepository,
  PaperBrokerStateRepository,
  PaperOwnerRepository,
  PaperOwnerSession,
  PaperPriorSession,
} from '@astra/db';
import type { EntryRevalidation, ExecutionReadiness } from '@astra/decision';
import {
  ExecutionGateway,
  PaperBrokerAdapter,
  isTerminal,
  isWorking,
  type BrokerAdapter,
  type CancelResult,
  type EntryRevalidationRequest,
  type ExecutionResult,
} from '@astra/execution';
import type { KillSwitchEvaluation } from '@astra/safety';
import type { Logger } from 'pino';
import type { EventBus } from './event-bus';
import type { HealthService } from './health-service';
import type { KillSwitchService } from './kill-switch-service';
import type { ModeService } from './mode-service';

export class ExecutionService {
  readonly adapters = new Map<string, BrokerAdapter>();
  readonly gateway: ExecutionGateway;
  private readonly reconciled = new Set<string>();
  private readonly pendingSaves = new Map<string, Promise<void>>();
  /** Newest captured / durably ACKed snapshot revision per paper account. */
  private readonly revisions = new Map<string, number>();
  private readonly acked = new Map<string, number>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly sessionId = newId('paperSession');
  private session: PaperOwnerSession | null = null;
  private keepalive: ReturnType<typeof setInterval> | undefined;
  private persistenceError: string | null = null;
  private closing = false;
  private recovery: PaperPriorSession = 'NONE';

  constructor(
    private readonly deps: {
      config: AstraConfig;
      store: ExecutionRepository;
      paperState: PaperBrokerStateRepository;
      paperOwner: PaperOwnerRepository;
      /** Ownership re-check interval (ms); 0 disables the timer (boundary checks still run). */
      ownerKeepaliveMs?: number;
      mode: ModeService;
      killSwitches: KillSwitchService;
      health: HealthService;
      events: EventBus;
      clock: Clock;
      log: Logger;
      liveTradingEnvironmentAuthorized: boolean;
      /** Required deterministic pre-submit revalidation (see PreSubmitValidator). */
      revalidate: (req: EntryRevalidationRequest) => Promise<EntryRevalidation>;
    },
  ) {
    const { config, clock } = deps;
    const instruments = (s: string): InstrumentSpec | undefined => config.instruments.get(s);
    const paper: PaperBrokerAdapter = new PaperBrokerAdapter({
      id: 'paper',
      clock,
      instruments,
      onChange: (ref) => this.persistPaper(paper, ref),
      blocked: () => this.blockReason(),
    });
    this.adapters.set(paper.id, paper);

    this.gateway = new ExecutionGateway({
      store: this.ownedStore(deps.store),
      adapter: (id) => this.adapters.get(id),
      account: (id) => config.accounts.get(id),
      mode: () => deps.mode.current(),
      killSwitches: (ctx) => this.withOwnership(deps.killSwitches.evaluate(ctx)),
      liveTradingEnvironmentAuthorized: () => deps.liveTradingEnvironmentAuthorized,
      onExecutionUnknown: async (accountId, clientOrderId, reason) => {
        this.reconciled.delete(accountId);
        await deps.killSwitches.activate({
          scope: 'EXECUTION',
          target: accountId,
          reason: `order ${clientOrderId} state unknown: ${reason}`,
          actor: { type: 'SYSTEM', id: 'execution-gateway' },
        });
      },
      revalidate: (req) => deps.revalidate(req),
      // Providers run in parallel under their own timeout; this bounds the whole revalidation.
      revalidationTimeoutMs: config.system.assembler.providerTimeoutMs * 4,
      clock,
      confirmation: {
        timeoutMs: config.system.execution.confirmationTimeoutMs,
        pollIntervalMs: config.system.execution.confirmationPollIntervalMs,
      },
    });
  }

  paper(): PaperBrokerAdapter {
    return this.adapters.get('paper') as PaperBrokerAdapter;
  }

  /** Why paper state must not be touched or admitted right now (null = this process may). */
  private blockReason(): string | null {
    if (!this.session) return 'paper ownership not acquired (no DIRTY session ACKed yet)';
    if (this.session.ownerLost) return this.session.ownerLost;
    if (this.persistenceError)
      return `paper state could not be persisted: ${this.persistenceError}`;
    if (this.closing) return 'execution is shutting down';
    return null;
  }

  private withOwnership(ev: KillSwitchEvaluation): KillSwitchEvaluation {
    const why = this.blockReason();
    return why ? { ...ev, blocked: true, reasons: [...ev.reasons, `[paper-owner] ${why}`] } : ev;
  }

  /** Re-proves ownership before the durable steps of an entry (reserve, dispatch intent). */
  private ownedStore(store: ExecutionRepository): ExecutionRepository {
    const owned = Object.create(store) as ExecutionRepository;
    const guard = async () => {
      if (!this.session) throw new Error('paper ownership not acquired');
      await this.session.verify();
      const why = this.blockReason();
      if (why) throw new Error(why);
    };
    owned.reserveAndConsume = async (req) => {
      await guard();
      return store.reserveAndConsume(req);
    };
    owned.markDispatching = async (id, at) => {
      await guard();
      return store.markDispatching(id, at);
    };
    return owned;
  }

  /**
   * Becomes the single paper owner and ACKs the DIRTY session BEFORE any paper state is restored,
   * mutated or read. Throws (startup stays fail-closed) when another live process owns paper or
   * the DIRTY write cannot be acknowledged. An unclean prior session quarantines every paper
   * account inside the same transaction.
   */
  async acquireOwnership(): Promise<void> {
    if (this.session && !this.session.ownerLost) return;
    const paper = this.paper();
    const accountIds = [...this.deps.config.accounts.values()]
      .filter((a) => a.broker.adapterId === paper.id)
      .map((a) => a.id);
    this.session = await this.deps.paperOwner.acquire({
      adapterId: paper.id,
      sessionId: this.sessionId,
      accountIds,
      at: this.deps.clock.now().toISOString(),
    });
    this.recovery = this.session.prior;
    if (this.recovery === 'UNCLEAN')
      this.deps.log.error(
        { priorSession: this.session.priorSessionId },
        'previous paper session did not end cleanly: paper accounts are quarantined pending recovery',
      );
    const every = this.deps.ownerKeepaliveMs ?? 2_000;
    if (every > 0) {
      this.keepalive = setInterval(() => void this.verifyOwnership().catch(() => undefined), every);
      this.keepalive.unref();
    }
  }

  /** Proves ownership now; on failure local admission and paper actions halt immediately. */
  async verifyOwnership(): Promise<void> {
    if (!this.session) throw new Error('paper ownership not acquired');
    try {
      await this.session.verify();
    } catch (err) {
      this.reconciled.clear();
      this.deps.log.error({ err: errorMessage(err) }, 'paper ownership lost: execution halted');
      throw err;
    }
  }

  /** Test/diagnostic: the Postgres backend holding the ownership lock. */
  ownerBackendPid(): number | null {
    return this.session?.backendPid ?? null;
  }

  recoveryState(): PaperPriorSession {
    return this.recovery;
  }

  /** Quotes reach the paper broker only while this process is the DIRTY owner. */
  onQuote(q: Quote): void {
    this.paper().onQuote(q); // the broker ignores it while blocked
  }

  /** Restores (or opens) paper accounts from persisted state. Requires acquired ownership. */
  async restorePaperAccounts(): Promise<void> {
    if (!this.session) throw new Error('paper ownership must be acquired before restoring state');
    const paper = this.paper();
    for (const a of this.deps.config.accounts.values()) {
      if (a.broker.adapterId !== paper.id || paper.hasAccount(a.broker.accountRef)) continue;
      const ref = a.broker.accountRef;
      const saved = await this.deps.paperState.loadWithRevision(paper.id, ref);
      if (saved) {
        this.revisions.set(ref, saved.revision);
        this.acked.set(ref, saved.revision);
        paper.importAccount(ref, saved.state);
      } else {
        const profile = this.deps.config.profiles.get(a.propFirmProfileId)!;
        paper.openAccount(ref, profile.accountSize, a.currency);
        this.persistPaper(paper, ref);
        await this.flush(); // the opening snapshot must be durable (throws otherwise)
      }
    }
  }

  /** Reconciles every non-terminal order with its broker; unresolvable orders halt execution. */
  async reconcileAll(): Promise<void> {
    for (const account of this.deps.config.accounts.values()) {
      await this.reconcile(account);
    }
  }

  private async reconcile(account: AccountDefinition): Promise<void> {
    const adapter = this.adapters.get(account.broker.adapterId);
    if (!adapter) return;
    const at = () => this.deps.clock.now().toISOString();
    // Orders that were reserved but never marked dispatched were provably never sent (the intent
    // is written before the adapter is called, and a released order can no longer be dispatched):
    // release them. Anything dispatched stays reserved and is polled below.
    const exposure = await this.deps.store.accountExposure(account.id);
    for (const r of exposure.reservations) {
      if (r.dispatched || r.orderStatus !== 'PENDING_SUBMIT') continue;
      const released = await this.deps.store.releaseUntransmitted(
        r.clientOrderId,
        'restart: the submit call was never dispatched',
        at(),
        { onlyIfUndispatched: true },
      );
      if (released)
        this.deps.log.warn({ order: r.clientOrderId }, 'released never-dispatched order');
    }
    let unresolved = 0;
    if (this.recovery === 'UNCLEAN') unresolved += await this.recoverEndedOrders(account, adapter);
    const working = await this.deps.store.workingOrdersForAccount(account.id);
    for (const o of working) {
      try {
        const state = await adapter.getOrder(account.broker.accountRef, o.clientOrderId);
        // A resting LIMIT the broker still holds is a known state (the safety loop tracks it).
        if (state && (isTerminal(state.status) || isWorking(state))) {
          const applied = await this.deps.store.updateOrder(o.clientOrderId, state);
          if (applied.contradiction) unresolved++; // contradictory evidence is never resolution
          await this.deps.store.appendOrderEvent({
            clientOrderId: o.clientOrderId,
            at: this.deps.clock.now().toISOString(),
            type: 'RECONCILED',
            detail: { ...state },
          });
        } else {
          unresolved++;
        }
      } catch (err) {
        this.deps.log.error(
          { err: errorMessage(err), order: o.clientOrderId },
          'reconciliation failed',
        );
        unresolved++;
      }
    }
    if (unresolved > 0) {
      await this.deps.killSwitches.activate({
        scope: 'EXECUTION',
        target: account.id,
        reason: `${unresolved} order(s) could not be reconciled with the broker at startup`,
        actor: { type: 'SYSTEM', id: 'reconciliation' },
      });
      return;
    }
    // Exposure of ended orders is released only on closure linked to the same order.
    await this.deps.store.reconcileReservations(account.id, at());
    // A durable quarantine (contradictory evidence after a release, unrepresentable legacy
    // exposure) is never resolved by a restart: the account stays unreconciled and halted. The
    // gate and the reservation step refuse on it in every process regardless.
    const { quarantines } = await this.deps.store.accountExposure(account.id);
    if (quarantines.length > 0) {
      // Never overwrite an active switch (e.g. an operator's reason); the account stays halted.
      if (this.deps.killSwitches.registry.get('EXECUTION', account.id)?.active) return;
      await this.deps.killSwitches.activate({
        scope: 'EXECUTION',
        target: account.id,
        reason: `account quarantined: ${quarantines.map((q) => q.reason).join('; ')}`,
        actor: { type: 'SYSTEM', id: 'reconciliation' },
      });
      return;
    }
    this.reconciled.add(account.id);
  }

  /**
   * After an unclean session the restored snapshot cannot prove which mutations were lost, so the
   * evidence of orders that look ENDED (terminal or released) is read from the restored broker and
   * judged by the store against its tombstones: a late fill or a different ending quarantines (it
   * never re-opens or releases anything), a consistent repeat changes nothing, and an order the
   * restored broker no longer knows is recorded as lost evidence. Nothing is ever resent.
   */
  private async recoverEndedOrders(
    account: AccountDefinition,
    adapter: BrokerAdapter,
  ): Promise<number> {
    let unresolved = 0;
    const ended = (
      await this.deps.store.listOrders({ accountId: account.id, limit: 1_000 })
    ).filter((o) => isTerminal(o.status));
    for (const o of ended) {
      try {
        const state = await adapter.getOrder(account.broker.accountRef, o.clientOrderId);
        if (!state) {
          unresolved++;
          await this.deps.store.appendOrderEvent({
            clientOrderId: o.clientOrderId,
            at: this.deps.clock.now().toISOString(),
            type: 'RECOVERY_EVIDENCE_MISSING',
            detail: { recoveredSession: this.session?.priorSessionId ?? null },
          });
          continue;
        }
        const applied = await this.deps.store.updateOrder(o.clientOrderId, state);
        if (applied.contradiction) unresolved++;
      } catch (err) {
        unresolved++;
        this.deps.log.error(
          { err: errorMessage(err), order: o.clientOrderId },
          'recovery evidence read failed',
        );
      }
    }
    return unresolved;
  }

  readiness(account: AccountDefinition | null): ExecutionReadiness {
    const adapter = account ? this.adapters.get(account.broker.adapterId) : undefined;
    const health = this.deps.health.registry.get('EXECUTION').status;
    return {
      adapterId: adapter?.id ?? null,
      adapterKind: adapter?.kind ?? null,
      health,
      reconciled: account ? this.reconciled.has(account.id) && this.blockReason() === null : false,
      supportedEntryTypes: adapter?.supportedEntryTypes ?? [],
    };
  }

  /** Tracks an operation so a clean stop can drain it; refuses once ownership is gone. */
  private async track<T>(op: () => Promise<T>): Promise<T> {
    const run = (async () => {
      await this.verifyOwnership();
      return op();
    })();
    this.inflight.add(run);
    try {
      return await run;
    } finally {
      this.inflight.delete(run);
    }
  }

  async execute(approvalId: string, actor: string): Promise<ExecutionResult> {
    let result: ExecutionResult;
    try {
      result = await this.track(() => this.gateway.execute(approvalId));
    } catch (err) {
      result = {
        outcome: 'REJECTED',
        reasons: [`[paper-owner] ${errorMessage(err)}; nothing was transmitted`],
        order: null,
        brokerState: null,
      };
    }
    const order = result.order;
    await this.deps.events.emit({
      level:
        result.outcome === 'UNKNOWN' ? 'CRITICAL' : result.outcome === 'REJECTED' ? 'WARN' : 'INFO',
      component: 'execution',
      type: `EXECUTION_${result.outcome}`,
      message: `${order ? `${order.direction} ${order.quantity} ${order.symbol}` : `approval ${approvalId}`}: ${result.outcome} — ${result.reasons.join('; ')}`,
      accountId: order?.accountId ?? null,
      data: { approvalId, actor, clientOrderId: order?.clientOrderId ?? null },
    });
    return result;
  }

  /** Operator cancel of a resting LIMIT entry (risk-reducing; audited as an order event). */
  async cancel(clientOrderId: string, actor: string): Promise<CancelResult> {
    const order = await this.deps.store.orderByClientId(clientOrderId);
    if (!order) throw new AstraError('NOT_FOUND', `order ${clientOrderId} not found`);
    const result = await this.track(() =>
      this.gateway.cancelWorking({
        accountId: order.accountId,
        clientOrderId,
        reason: `cancelled by ${actor}`,
      }),
    );
    await this.deps.events.emit({
      level: result.outcome === 'CANCELLED' || result.outcome === 'ALREADY_FINAL' ? 'INFO' : 'WARN',
      component: 'execution',
      type: `ORDER_CANCEL_${result.outcome}`,
      message: `${order.direction} ${order.entryType} ${order.quantity} ${order.symbol}: cancel ${result.outcome} — ${result.reason}`,
      accountId: order.accountId,
      data: { clientOrderId, actor },
    });
    return result;
  }

  /**
   * Captures an IMMUTABLE, revisioned snapshot now (synchronously, at the mutation) and queues its
   * durable save. The save outcome is never absorbed: a failure halts readiness and every later
   * `flush()` rejects. The ACKed revision is what a clean checkpoint verifies.
   */
  private persistPaper(paper: PaperBrokerAdapter, ref: string): void {
    const revision = (this.revisions.get(ref) ?? 0) + 1;
    this.revisions.set(ref, revision);
    const snapshot = structuredClone(paper.exportAccount(ref));
    const at = this.deps.clock.now().toISOString();
    const previous = this.pendingSaves.get(ref) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.persistenceError) return; // no newer revision may be ACKed after a failed one
      try {
        await this.deps.paperState.save(paper.id, ref, snapshot, at, {
          sessionId: this.sessionId,
          revision,
        });
        this.acked.set(ref, revision);
      } catch (err) {
        this.persistenceError ??= `${ref}@${revision}: ${errorMessage(err)}`;
        this.reconciled.clear();
        this.session?.markLost(`paper snapshot ${ref}@${revision} not acknowledged`);
        this.deps.log.error(
          { err: errorMessage(err), ref, revision },
          'failed to persist paper broker state; execution halted',
        );
      }
    });
    this.pendingSaves.set(ref, next);
  }

  /** Waits for every queued save and REJECTS if any save failed (never reports durability falsely). */
  async flush(): Promise<void> {
    await Promise.all(this.pendingSaves.values());
    if (this.persistenceError)
      throw new Error(`paper state is not durable: ${this.persistenceError}`);
  }

  /**
   * Clean stop: stop new actions and quotes, drain in-flight operations and saves, persist one
   * final consistent checkpoint per account and mark the session CLEAN only after those
   * checkpoints were ACKed. Any failure leaves the session DIRTY (the next start quarantines). A
   * CLEAN commit whose acknowledgement is lost may still be persisted; the next start verifies
   * the matching checkpoints, so this never claims more than it knows.
   */
  async shutdown(): Promise<void> {
    clearInterval(this.keepalive);
    if (!this.session) return;
    this.closing = true; // paper broker rejects new actions and ignores quotes from here on
    try {
      await Promise.allSettled([...this.inflight]);
      await this.flush();
      await this.verifyOwnership();
      const paper = this.paper();
      const refs = [...this.deps.config.accounts.values()]
        .filter((a) => a.broker.adapterId === paper.id && paper.hasAccount(a.broker.accountRef))
        .map((a) => a.broker.accountRef);
      for (const ref of refs) this.persistPaper(paper, ref);
      await this.flush();
      const checkpoints = Object.fromEntries(refs.map((r) => [r, this.acked.get(r) ?? -1]));
      try {
        await this.session.markClean(checkpoints, this.deps.clock.now().toISOString());
      } catch (err) {
        throw new Error(
          `CLEAN transition not acknowledged (it may or may not be committed; the next start verifies the checkpoints): ${errorMessage(err)}`,
        );
      }
    } finally {
      await this.session.release();
    }
  }
}
