/**
 * Execution Gateway (spec §26, §27, §50). The only path from an approval to a broker.
 *
 * It re-validates everything that can change between decision and execution (approval validity,
 * mode, kill switches, authorization, adapter kind), serialises orders per account, protects
 * against duplicates at three levels (atomic approval consumption, unique order records,
 * working-order check), submits with an idempotency key, and CONFIRMS the result by polling the
 * broker — it never assumes a fill because a request succeeded. An order whose state cannot be
 * confirmed becomes UNKNOWN and triggers the account's EXECUTION kill switch.
 */
import {
  errorMessage,
  modePolicy,
  newId,
  type AccountDefinition,
  type Clock,
  type TradingMode,
} from '@astra/core';
import type { KillSwitchContext, KillSwitchEvaluation } from '@astra/safety';
import { KeyedMutex } from './mutex';
import {
  isTerminal,
  type BrokerAdapter,
  type BrokerOrderState,
  type ExecutionStore,
  type OrderRecord,
} from './types';

export type ExecutionOutcome = 'CONFIRMED' | 'SHADOW_RECORDED' | 'REJECTED' | 'UNKNOWN';

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  readonly reasons: readonly string[];
  readonly order: OrderRecord | null;
  readonly brokerState: BrokerOrderState | null;
}

export interface ExecutionGatewayDeps {
  readonly store: ExecutionStore;
  readonly adapter: (adapterId: string) => BrokerAdapter | undefined;
  readonly account: (accountId: string) => AccountDefinition | undefined;
  readonly mode: () => TradingMode;
  readonly killSwitches: (ctx: KillSwitchContext) => KillSwitchEvaluation;
  readonly liveTradingEnvironmentAuthorized: () => boolean;
  /** Called when an order's state cannot be confirmed: must halt execution for the account. */
  readonly onExecutionUnknown: (
    accountId: string,
    clientOrderId: string,
    reason: string,
  ) => Promise<void>;
  readonly clock: Clock;
  readonly confirmation: { readonly timeoutMs: number; readonly pollIntervalMs: number };
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function clientOrderIdFor(approvalId: string): string {
  return `astra-${approvalId}`;
}

export class ExecutionGateway {
  private readonly locks = new KeyedMutex();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ExecutionGatewayDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async execute(approvalId: string): Promise<ExecutionResult> {
    const { store, clock } = this.deps;
    const rejected = (...reasons: string[]): ExecutionResult => ({
      outcome: 'REJECTED',
      reasons,
      order: null,
      brokerState: null,
    });

    const approval = await store.getApproval(approvalId);
    if (!approval) return rejected(`approval ${approvalId} not found`);
    if (approval.state !== 'PENDING')
      return rejected(`approval ${approvalId} is ${approval.state}`);
    const now = clock.now();
    if (now.getTime() >= Date.parse(approval.expiresAt)) {
      await store.transitionApproval(approvalId, 'EXPIRED', now.toISOString());
      return rejected(`approval expired at ${approval.expiresAt}`);
    }

    const mode = this.deps.mode();
    if (mode !== approval.mode) {
      return rejected(
        `mode changed from ${approval.mode} to ${mode} since the decision; re-evaluate`,
      );
    }
    const policy = modePolicy(mode);
    if (!policy.newTradesAllowed) return rejected(`mode ${mode} does not permit new trades`);

    const plan = approval.orderPlan;
    const ks = this.deps.killSwitches({
      accountId: approval.accountId,
      strategyId: approval.strategyId,
      symbol: plan.symbol,
    });
    if (ks.blocked) return rejected(...ks.reasons);

    const account = this.deps.account(approval.accountId);
    if (!account) return rejected(`account ${approval.accountId} not found`);
    if (account.status !== 'ACTIVE') return rejected(`account status ${account.status}`);

    const baseOrder = (adapterId: string | null, status: OrderRecord['status']): OrderRecord => ({
      orderId: newId('order'),
      clientOrderId: clientOrderIdFor(approvalId),
      approvalId,
      decisionId: approval.decisionId,
      accountId: approval.accountId,
      strategyId: approval.strategyId,
      signalId: approval.signalId,
      adapterId,
      mode,
      symbol: plan.symbol,
      direction: plan.direction,
      quantity: plan.quantity,
      entryType: plan.entryType,
      plannedEntry: plan.entry,
      stopLoss: plan.stop,
      takeProfit: plan.target,
      status,
      brokerOrderId: null,
      filledQuantity: 0,
      averageFillPrice: null,
      rejectReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    // SHADOW: record what would have been sent; never transmit.
    if (!policy.transmitsOrders) {
      if (!(await store.transitionApproval(approvalId, 'SHADOW_RECORDED', now.toISOString()))) {
        return rejected('approval already used (concurrent execution)');
      }
      const order = baseOrder(null, 'SHADOW');
      await store.createOrder(order);
      await store.appendOrderEvent({
        clientOrderId: order.clientOrderId,
        at: now.toISOString(),
        type: 'SHADOW_RECORDED',
        detail: { plan },
      });
      return {
        outcome: 'SHADOW_RECORDED',
        reasons: [`${mode}: order recorded, not transmitted`],
        order,
        brokerState: null,
      };
    }

    const adapter = this.deps.adapter(account.broker.adapterId);
    if (!adapter) return rejected(`execution adapter ${account.broker.adapterId} not registered`);
    if (adapter.kind !== policy.brokerKind) {
      return rejected(
        `adapter ${adapter.id} is ${adapter.kind}; mode ${mode} requires ${policy.brokerKind}`,
      );
    }
    if (
      mode === 'LIVE' &&
      !(this.deps.liveTradingEnvironmentAuthorized() && account.liveTradingAuthorized)
    ) {
      return rejected(
        'live trading not authorized (environment and account authorization required)',
      );
    }
    if (!adapter.supportedEntryTypes.includes(plan.entryType)) {
      return rejected(`adapter does not support ${plan.entryType} entries`);
    }

    // One order at a time per account: prevents races between concurrent approvals.
    return this.locks.run(approval.accountId, async () => {
      const working = await store.workingOrders(approval.accountId, plan.symbol);
      if (working.length > 0)
        return rejected(`order ${working[0]!.clientOrderId} for ${plan.symbol} is still working`);

      // Positions may have changed since the decision (e.g. two approvals decided concurrently).
      let broker;
      try {
        broker = await adapter.getAccountSnapshot(account.broker.accountRef, account.id);
      } catch (err) {
        return rejected(`cannot verify broker positions before submission: ${errorMessage(err)}`);
      }
      if (broker.openPositions.some((p) => p.symbol === plan.symbol)) {
        return rejected(
          `a ${plan.symbol} position is already open at the broker; re-evaluate before adding exposure`,
        );
      }

      const at = clock.now().toISOString();
      if (!(await store.transitionApproval(approvalId, 'CONSUMED', at))) {
        return rejected('approval already consumed (duplicate execution prevented)');
      }
      const order = baseOrder(adapter.id, 'PENDING_SUBMIT');
      await store.createOrder(order); // unique approvalId/clientOrderId: DB-level duplicate guard
      await store.appendOrderEvent({
        clientOrderId: order.clientOrderId,
        at,
        type: 'SUBMIT_REQUESTED',
        detail: { adapter: adapter.id, plan },
      });

      let submitted: BrokerOrderState | null = null;
      let submitError: string | null = null;
      try {
        submitted = await adapter.submitOrder({
          clientOrderId: order.clientOrderId,
          accountRef: account.broker.accountRef,
          symbol: plan.symbol,
          direction: plan.direction,
          quantity: plan.quantity,
          entryType: plan.entryType,
          stopLoss: plan.stop,
          takeProfit: plan.target,
        });
        await store.updateOrder(order.clientOrderId, submitted);
        await store.appendOrderEvent({
          clientOrderId: order.clientOrderId,
          at: clock.now().toISOString(),
          type: 'SUBMIT_RESPONSE',
          detail: { ...submitted },
        });
      } catch (err) {
        // The broker may or may not have received it: the outcome is unknown until confirmed.
        submitError = errorMessage(err);
        await store.appendOrderEvent({
          clientOrderId: order.clientOrderId,
          at: clock.now().toISOString(),
          type: 'SUBMIT_ERROR',
          detail: { error: submitError },
        });
      }

      const confirmed = await this.confirm(adapter, account.broker.accountRef, order.clientOrderId);
      if (confirmed === null) {
        const reason = submitError
          ? `submission error (${submitError}) and order state could not be confirmed`
          : `order state not confirmed within ${this.deps.confirmation.timeoutMs}ms`;
        const unknownState: BrokerOrderState = {
          clientOrderId: order.clientOrderId,
          brokerOrderId: submitted?.brokerOrderId ?? null,
          status: 'UNKNOWN',
          quantity: plan.quantity,
          filledQuantity: submitted?.filledQuantity ?? 0,
          averageFillPrice: submitted?.averageFillPrice ?? null,
          rejectReason: reason,
          updatedAt: clock.now().toISOString(),
        };
        await store.updateOrder(order.clientOrderId, unknownState);
        await store.appendOrderEvent({
          clientOrderId: order.clientOrderId,
          at: clock.now().toISOString(),
          type: 'STATE_UNKNOWN',
          detail: { reason },
        });
        await this.deps.onExecutionUnknown(approval.accountId, order.clientOrderId, reason);
        return { outcome: 'UNKNOWN', reasons: [reason], order, brokerState: unknownState };
      }

      await store.updateOrder(order.clientOrderId, confirmed);
      await store.appendOrderEvent({
        clientOrderId: order.clientOrderId,
        at: clock.now().toISOString(),
        type: 'CONFIRMED',
        detail: { ...confirmed },
      });
      if (
        confirmed.status === 'REJECTED' ||
        confirmed.status === 'CANCELLED' ||
        confirmed.status === 'EXPIRED'
      ) {
        return {
          outcome: 'REJECTED',
          reasons: [`broker ${confirmed.status}: ${confirmed.rejectReason ?? 'no reason given'}`],
          order,
          brokerState: confirmed,
        };
      }
      return {
        outcome: 'CONFIRMED',
        reasons: [
          `${confirmed.status} ${confirmed.filledQuantity}/${plan.quantity} @ ${confirmed.averageFillPrice}`,
        ],
        order,
        brokerState: confirmed,
      };
    });
  }

  /**
   * Polls the broker until the order reaches a terminal state. A partial fill still working at
   * the deadline has its remainder cancelled. Returns null when the state cannot be confirmed.
   */
  private async confirm(
    adapter: BrokerAdapter,
    accountRef: string,
    clientOrderId: string,
  ): Promise<BrokerOrderState | null> {
    const deadline = this.deps.clock.now().getTime() + this.deps.confirmation.timeoutMs;
    let last: BrokerOrderState | null = null;
    for (;;) {
      try {
        last = await adapter.getOrder(accountRef, clientOrderId);
      } catch {
        last = null;
      }
      if (last && isTerminal(last.status)) return last;
      if (this.deps.clock.now().getTime() >= deadline) break;
      await this.sleep(this.deps.confirmation.pollIntervalMs);
    }
    if (last?.status === 'PARTIALLY_FILLED') {
      try {
        const final = await adapter.cancelOrder(accountRef, clientOrderId);
        if (isTerminal(final.status)) return final;
      } catch {
        return null;
      }
    }
    return null;
  }
}
