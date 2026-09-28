/**
 * Execution wiring: broker adapters, the execution gateway, startup reconciliation (spec §18:
 * open orders are reconciled with the broker before new trades are allowed) and persistence of
 * paper-broker state.
 */
import {
  AstraError,
  errorMessage,
  type AccountDefinition,
  type Clock,
  type InstrumentSpec,
} from '@astra/core';
import type { AstraConfig } from '@astra/config';
import type { ExecutionRepository, PaperBrokerStateRepository } from '@astra/db';
import type { ExecutionReadiness } from '@astra/decision';
import {
  ExecutionGateway,
  PaperBrokerAdapter,
  isTerminal,
  isWorking,
  type BrokerAdapter,
  type CancelResult,
  type ExecutionResult,
} from '@astra/execution';
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

  constructor(
    private readonly deps: {
      config: AstraConfig;
      store: ExecutionRepository;
      paperState: PaperBrokerStateRepository;
      mode: ModeService;
      killSwitches: KillSwitchService;
      health: HealthService;
      events: EventBus;
      clock: Clock;
      log: Logger;
      liveTradingEnvironmentAuthorized: boolean;
    },
  ) {
    const { config, clock } = deps;
    const instruments = (s: string): InstrumentSpec | undefined => config.instruments.get(s);
    const paper: PaperBrokerAdapter = new PaperBrokerAdapter({
      id: 'paper',
      clock,
      instruments,
      onChange: (ref) => this.persistPaper(paper, ref),
    });
    this.adapters.set(paper.id, paper);

    this.gateway = new ExecutionGateway({
      store: deps.store,
      adapter: (id) => this.adapters.get(id),
      account: (id) => config.accounts.get(id),
      mode: () => deps.mode.current(),
      killSwitches: (ctx) => deps.killSwitches.evaluate(ctx),
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

  /** Restores (or opens) paper accounts from persisted state. */
  async restorePaperAccounts(): Promise<void> {
    const paper = this.paper();
    for (const a of this.deps.config.accounts.values()) {
      if (a.broker.adapterId !== paper.id || paper.hasAccount(a.broker.accountRef)) continue;
      const saved = await this.deps.paperState.load(paper.id, a.broker.accountRef);
      if (saved) {
        paper.importAccount(a.broker.accountRef, saved);
      } else {
        const profile = this.deps.config.profiles.get(a.propFirmProfileId)!;
        paper.openAccount(a.broker.accountRef, profile.accountSize, a.currency);
        await this.deps.paperState.save(
          paper.id,
          a.broker.accountRef,
          paper.exportAccount(a.broker.accountRef),
          this.deps.clock.now().toISOString(),
        );
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
    const working = await this.deps.store.workingOrdersForAccount(account.id);
    let unresolved = 0;
    for (const o of working) {
      try {
        const state = await adapter.getOrder(account.broker.accountRef, o.clientOrderId);
        // A resting LIMIT the broker still holds is a known state (the safety loop tracks it).
        if (state && (isTerminal(state.status) || isWorking(state))) {
          await this.deps.store.updateOrder(o.clientOrderId, state);
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
    this.reconciled.add(account.id);
  }

  readiness(account: AccountDefinition | null): ExecutionReadiness {
    const adapter = account ? this.adapters.get(account.broker.adapterId) : undefined;
    const health = this.deps.health.registry.get('EXECUTION').status;
    return {
      adapterId: adapter?.id ?? null,
      adapterKind: adapter?.kind ?? null,
      health,
      reconciled: account ? this.reconciled.has(account.id) : false,
      supportedEntryTypes: adapter?.supportedEntryTypes ?? [],
    };
  }

  async execute(approvalId: string, actor: string): Promise<ExecutionResult> {
    const result = await this.gateway.execute(approvalId);
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
    const result = await this.gateway.cancelWorking({
      accountId: order.accountId,
      clientOrderId,
      reason: `cancelled by ${actor}`,
    });
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

  /** Serialised, fire-and-forget persistence of paper state (failures are logged loudly). */
  private persistPaper(paper: PaperBrokerAdapter, ref: string): void {
    const previous = this.pendingSaves.get(ref) ?? Promise.resolve();
    const next = previous
      .then(() =>
        this.deps.paperState.save(
          paper.id,
          ref,
          paper.exportAccount(ref),
          this.deps.clock.now().toISOString(),
        ),
      )
      .catch((err: unknown) =>
        this.deps.log.error(
          { err: errorMessage(err), ref },
          'failed to persist paper broker state',
        ),
      );
    this.pendingSaves.set(ref, next);
  }

  async flush(): Promise<void> {
    await Promise.all(this.pendingSaves.values());
  }
}
