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
  type AccountSnapshot,
  type Clock,
  type TradingMode,
} from '@astra/core';
import type { KillSwitchContext, KillSwitchEvaluation } from '@astra/safety';
import type { EntryRevalidation } from '@astra/decision';
import { KeyedMutex } from './mutex';
import { isUncertain, snapshotWithReservations } from './reservations';
import {
  isTerminal,
  isWorking,
  type AccountExposure,
  type ApprovalRecord,
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

export type ProtectiveCloseOutcome = 'CLOSED' | 'ALREADY_FLAT' | 'SKIPPED' | 'REJECTED' | 'UNKNOWN';

export interface ProtectiveCloseResult {
  readonly outcome: ProtectiveCloseOutcome;
  readonly reason: string;
  readonly exitPrice: number | null;
  readonly realizedPnl: number | null;
}

export type CancelOutcome =
  'CANCELLED' | 'FILLED' | 'ALREADY_FINAL' | 'SKIPPED' | 'REJECTED' | 'UNKNOWN';

export interface CancelResult {
  readonly outcome: CancelOutcome;
  readonly reason: string;
  readonly state: BrokerOrderState | null;
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
  /**
   * REQUIRED deterministic revalidation of an entry on fresh data (see `revalidateApprovedEntry`).
   * There is no permissive default: it must be supplied, an error or timeout refuses the order.
   * `snapshot` is the broker snapshot plus every reserved exposure not yet visible in it.
   */
  readonly revalidate: (req: EntryRevalidationRequest) => Promise<EntryRevalidation>;
  readonly revalidationTimeoutMs: number;
  readonly clock: Clock;
  readonly confirmation: { readonly timeoutMs: number; readonly pollIntervalMs: number };
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface EntryRevalidationRequest {
  readonly approval: ApprovalRecord;
  readonly snapshot: AccountSnapshot;
  readonly exposure: AccountExposure;
  /**
   * Set only by the final pre-submit gate: this order's own (already reserved) client order id,
   * which the working-order duplicate check must not count against itself. Nothing else is exempt.
   */
  readonly ownClientOrderId: string | null;
}

type Control =
  | {
      readonly ok: true;
      readonly account: AccountDefinition;
      readonly mode: TradingMode;
      /** null in SHADOW (nothing is transmitted). */
      readonly adapter: BrokerAdapter | null;
    }
  | { readonly ok: false; readonly reasons: string[]; readonly expired: boolean };

/** What a queued risk-reducing request was made against; pinned, never re-resolved. */
interface Binding {
  readonly adapterId: string;
  readonly accountRef: string;
  readonly adapter: BrokerAdapter;
  readonly kind: BrokerAdapter['kind'];
}

const MAX_LEDGER_ATTEMPTS = 3;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
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

  /**
   * Approval → broker. Every check that can change while an approval waits (for the account's
   * lock, for a snapshot, for revalidation) is repeated AFTER those awaits, and once more
   * immediately before the submit call. The entry is then validated against fresh data by the
   * deterministic gate, and approval consumption, order creation and the account-wide exposure
   * reservation commit in one atomic step of the shared store (ADR-0027). If any of that fails,
   * nothing is transmitted and the refusal is audited.
   */
  async execute(approvalId: string): Promise<ExecutionResult> {
    try {
      const approval = await this.deps.store.getApproval(approvalId);
      if (!approval) return await this.refuse(null, approvalId, `approval ${approvalId} not found`);
      return await this.locks.run(approval.accountId, () => this.executeLocked(approvalId));
    } catch (err) {
      return this.refuse(
        null,
        approvalId,
        `execution could not be validated (${errorMessage(err)}); nothing was transmitted`,
      );
    }
  }

  private async refuse(
    approval: ApprovalRecord | null,
    approvalId: string,
    ...reasons: string[]
  ): Promise<ExecutionResult> {
    try {
      await this.deps.store.recordRejection({
        approvalId,
        accountId: approval?.accountId ?? null,
        reasons,
        at: this.deps.clock.now().toISOString(),
      });
    } catch {
      // The refusal stands even when it cannot be audited: nothing was transmitted.
    }
    return { outcome: 'REJECTED', reasons, order: null, brokerState: null };
  }

  /**
   * Everything that must hold for this approval to be acted on, judged NOW from current state.
   * Synchronous and side-effect free, so it can be repeated at any point (and right before submit).
   */
  private control(approval: ApprovalRecord): Control {
    const no = (...reasons: string[]): Control => ({ ok: false, reasons, expired: false });
    const now = this.deps.clock.now().getTime();
    const expires = Date.parse(approval.expiresAt);
    if (!Number.isFinite(expires))
      return no(`approval expiry ${approval.expiresAt} is not a valid timestamp`);
    if (now >= expires)
      return { ok: false, expired: true, reasons: [`approval expired at ${approval.expiresAt}`] };

    const mode = this.deps.mode();
    if (mode !== approval.mode) {
      return no(`mode changed from ${approval.mode} to ${mode} since the decision; re-evaluate`);
    }
    const policy = modePolicy(mode);
    if (!policy.newTradesAllowed) return no(`mode ${mode} does not permit new trades`);

    const plan = approval.orderPlan;
    if (plan.entryType === 'LIMIT') {
      if (!plan.expiresAt) return no('LIMIT order plan has no expiry');
      const limitExpiry = Date.parse(plan.expiresAt);
      if (!Number.isFinite(limitExpiry))
        return no(`LIMIT expiry ${plan.expiresAt} is not a valid timestamp`);
      if (now >= limitExpiry) return no(`LIMIT order would already be expired (${plan.expiresAt})`);
    }
    const ks = this.deps.killSwitches({
      accountId: approval.accountId,
      strategyId: approval.strategyId,
      symbol: plan.symbol,
    });
    if (ks.blocked) return no(...ks.reasons);

    const account = this.deps.account(approval.accountId);
    if (!account) return no(`account ${approval.accountId} not found`);
    if (account.status !== 'ACTIVE') return no(`account status ${account.status}`);

    // SHADOW: record what would have been sent; never transmit (no adapter needed).
    if (!policy.transmitsOrders) return { ok: true, account, mode, adapter: null };

    const adapter = this.deps.adapter(account.broker.adapterId);
    if (!adapter) return no(`execution adapter ${account.broker.adapterId} not registered`);
    if (adapter.kind !== policy.brokerKind) {
      return no(
        `adapter ${adapter.id} is ${adapter.kind}; mode ${mode} requires ${policy.brokerKind}`,
      );
    }
    if (
      mode === 'LIVE' &&
      !(this.deps.liveTradingEnvironmentAuthorized() && account.liveTradingAuthorized)
    ) {
      return no('live trading not authorized (environment and account authorization required)');
    }
    if (!adapter.supportedEntryTypes.includes(plan.entryType)) {
      return no(`adapter does not support ${plan.entryType} entries`);
    }
    return { ok: true, account, mode, adapter };
  }

  /** Re-reads the approval from the store, then applies `control` to what is stored NOW. */
  private async freshControl(
    approvalId: string,
  ): Promise<
    | { ok: true; approval: ApprovalRecord; ctx: Extract<Control, { ok: true }> }
    | { ok: false; approval: ApprovalRecord | null; reasons: string[] }
  > {
    const { store, clock } = this.deps;
    const approval = await store.getApproval(approvalId);
    if (!approval)
      return { ok: false, approval: null, reasons: [`approval ${approvalId} not found`] };
    if (approval.state !== 'PENDING')
      return { ok: false, approval, reasons: [`approval ${approvalId} is ${approval.state}`] };
    const ctx = this.control(approval);
    if (!ctx.ok) {
      if (ctx.expired)
        await store.transitionApproval(approvalId, 'EXPIRED', clock.now().toISOString());
      return { ok: false, approval, reasons: ctx.reasons };
    }
    return { ok: true, approval, ctx };
  }

  private async executeLocked(approvalId: string): Promise<ExecutionResult> {
    const { store, clock } = this.deps;
    for (let attempt = 1; attempt <= MAX_LEDGER_ATTEMPTS; attempt++) {
      const c = await this.freshControl(approvalId);
      if (!c.ok) return this.refuse(c.approval, approvalId, ...c.reasons);
      const { approval, ctx } = c;
      const { mode, adapter } = ctx;
      const plan = approval.orderPlan;

      const baseOrder = (adapterId: string | null, status: OrderRecord['status']): OrderRecord => {
        const at = clock.now().toISOString();
        return {
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
          expiresAt: plan.expiresAt ?? null,
          createdAt: at,
          updatedAt: at,
        };
      };

      // SHADOW: record what would have been sent; never transmit.
      if (!adapter) {
        const at = clock.now().toISOString();
        if (!(await store.transitionApproval(approvalId, 'SHADOW_RECORDED', at))) {
          return this.refuse(approval, approvalId, 'approval already used (concurrent execution)');
        }
        const order = baseOrder(null, 'SHADOW');
        await store.createOrder(order);
        await store.appendOrderEvent({
          clientOrderId: order.clientOrderId,
          at,
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

      const gated = await this.gate(approval, ctx, adapter, null, async () => {
        const again = await this.freshControl(approvalId);
        return again.ok ? null : again.reasons;
      });
      if (!gated.ok) return this.refuse(approval, approvalId, ...gated.reasons);
      const { exposure, verdict } = gated;

      const c3 = await this.freshControl(approvalId);
      if (!c3.ok) return this.refuse(c3.approval, approvalId, ...c3.reasons);

      const order = baseOrder(adapter.id, 'PENDING_SUBMIT');
      const reserved = await store.reserveAndConsume({
        order,
        expectedVersion: exposure.version,
        at: order.createdAt,
        intent: { adapter: adapter.id, plan, revalidatedQuantity: verdict.permittedQuantity },
      });
      if (!reserved.ok) {
        if (reserved.code === 'LEDGER_CHANGED' && attempt < MAX_LEDGER_ATTEMPTS) continue;
        return this.refuse(approval, approvalId, reserved.reason);
      }
      return this.transmit(c3.approval, c3.ctx, adapter, order);
    }
    return this.refuse(
      null,
      approvalId,
      'account exposure kept changing during validation; refusing to guess',
    );
  }

  /**
   * The entry gate on FRESH data: working orders, broker snapshot, reservation ledger and the
   * deterministic revalidation, with `recheck` (control plane) after each awaited step. It runs
   * once before the reservation and once more after the last durable wait before submit
   * (`exclude` = the order's own reservation, so it is not counted against itself): a delay in
   * persistence can therefore never carry an expired quote, a new blackout, a changed limit or a
   * stale snapshot to the broker.
   */
  private async gate(
    approval: ApprovalRecord,
    ctx: Extract<Control, { ok: true }>,
    adapter: BrokerAdapter,
    exclude: string | null,
    recheck: () => Promise<string[] | null>,
  ): Promise<
    | { ok: true; exposure: AccountExposure; verdict: Extract<EntryRevalidation, { ok: true }> }
    | { ok: false; reasons: string[]; ledgerMoved?: boolean }
  > {
    const { store, clock } = this.deps;
    const { account } = ctx;
    const plan = approval.orderPlan;
    const no = (...reasons: string[]) => ({ ok: false as const, reasons });
    const quarantined = (e: AccountExposure) =>
      e.quarantines[0]
        ? `account ${approval.accountId} is quarantined (${e.quarantines[0].reason}); new entries are blocked until it is reconciled`
        : null;
    try {
      const working = (await store.workingOrders(approval.accountId, plan.symbol)).filter(
        (o) => o.clientOrderId !== exclude,
      );
      if (working.length > 0)
        return no(`order ${working[0]!.clientOrderId} for ${plan.symbol} is still working`);

      // Broker truth first, then the durable ledger: positions may have changed since the decision.
      let broker;
      try {
        broker = await adapter.getAccountSnapshot(account.broker.accountRef, account.id);
      } catch (err) {
        return no(`cannot verify broker positions before submission: ${errorMessage(err)}`);
      }
      if (broker.openPositions.some((p) => p.symbol === plan.symbol)) {
        return no(
          `a ${plan.symbol} position is already open at the broker; re-evaluate before adding exposure`,
        );
      }
      await store.reconcileReservations(approval.accountId, clock.now().toISOString());
      const full = await store.accountExposure(approval.accountId);
      const blocked = quarantined(full);
      if (blocked) return no(blocked);
      const exposure: AccountExposure = {
        ...full,
        reservations: full.reservations.filter((r) => r.clientOrderId !== exclude),
      };
      const uncertain = exposure.reservations.find(isUncertain);
      if (uncertain) {
        return no(
          `order ${uncertain.clientOrderId} (${uncertain.symbol}) is unresolved (${uncertain.orderStatus}); new entries wait for reconciliation`,
        );
      }
      const { snapshot } = snapshotWithReservations(broker, exposure.reservations);

      // The world may have moved while the snapshot was read.
      const moved = await recheck();
      if (moved) return no(...moved);

      // Full deterministic gate on fresh data and the account-wide reserved exposure.
      let verdict: EntryRevalidation;
      try {
        verdict = await withTimeout(
          this.deps.revalidate({ approval, snapshot, exposure, ownClientOrderId: exclude }),
          this.deps.revalidationTimeoutMs,
        );
      } catch (err) {
        return no(`pre-submit revalidation failed: ${errorMessage(err)}`);
      }
      if (!verdict.ok) return no(...verdict.reasons);
      if (typeof verdict.finalGuard !== 'function')
        return no('revalidation carried no final guard; refusing to transmit');
      if (!(verdict.permittedQuantity >= plan.quantity)) {
        return no(
          `permitted size ${verdict.permittedQuantity} is below the approved ${plan.quantity}`,
        );
      }
      // Evidence may have arrived WHILE the revalidation waited (e.g. a late fill on a released
      // order quarantining the account). Re-read the shared ledger, bounded like the revalidation,
      // before the synchronous control-plane check. Before the reservation, `reserveAndConsume`
      // re-checks the version and the quarantine under the ledger lock; after it (final gate),
      // a changed ledger means the verdict was reached on stale exposure: the gate is re-run.
      const latest = await withTimeout(
        store.accountExposure(approval.accountId),
        this.deps.revalidationTimeoutMs,
      );
      const blockedNow = quarantined(latest);
      if (blockedNow) return no(blockedNow);
      if (exclude !== null && latest.version !== full.version)
        return {
          ok: false,
          ledgerMoved: true,
          reasons: [
            'account exposure changed while the order was being validated; refusing to guess',
          ],
        };
      const after = await recheck();
      if (after) return no(...after);
      return { ok: true, exposure: full, verdict };
    } catch (err) {
      return no(`entry gate failed: ${errorMessage(err)}; nothing was transmitted`);
    }
  }

  /**
   * The reservation, consumed approval and intent are durable. Re-checks the control plane
   * synchronously right before the submit call; only a failure BEFORE the adapter is called may
   * release the reservation (the gateway knows it never transmitted).
   */
  /**
   * Invokes the revalidation's synchronous final guard. Anything but a plain `{ ok: true }` result
   * (missing guard, throw, thenable, malformed) refuses: there is no permissive default.
   */
  private runFinalGuard(guard: unknown): { ok: true } | { ok: false; reasons: string[] } {
    const no = (why: string) => ({ ok: false as const, reasons: [`[final-guard] ${why}`] });
    if (typeof guard !== 'function') return no('missing; refusing to transmit');
    try {
      const r: unknown = (guard as () => unknown)();
      if (r !== null && (typeof r === 'object' || typeof r === 'function')) {
        if (typeof (r as { then?: unknown }).then === 'function')
          return no('returned a thenable (it must be synchronous); refusing to transmit');
        const v = r as { ok?: unknown; reasons?: unknown };
        if (v.ok === true) return { ok: true };
        if (v.ok === false)
          return {
            ok: false,
            reasons:
              Array.isArray(v.reasons) && v.reasons.length > 0
                ? v.reasons.map(String)
                : ['[final-guard] refused without a reason'],
          };
      }
      return no('returned a malformed result; refusing to transmit');
    } catch (err) {
      return no(`threw: ${errorMessage(err)}`);
    }
  }

  private async transmit(
    approval: ApprovalRecord,
    ctx: Extract<Control, { ok: true }>,
    adapter: BrokerAdapter,
    order: OrderRecord,
  ): Promise<ExecutionResult> {
    const { store, clock } = this.deps;
    const { account } = ctx;
    const plan = approval.orderPlan;
    const notSent = async (...reasons: string[]): Promise<ExecutionResult> => {
      let kept = '';
      try {
        await store.releaseUntransmitted(
          order.clientOrderId,
          reasons.join('; '),
          clock.now().toISOString(),
        );
      } catch (err) {
        kept = ` (reservation kept until reconciliation: ${errorMessage(err)})`;
      }
      return {
        outcome: 'REJECTED',
        reasons: [...reasons.slice(0, -1), `${reasons.at(-1)}${kept}; nothing was transmitted`],
        order,
        brokerState: null,
      };
    };

    const before = this.control(approval);
    if (!before.ok) return notSent(...before.reasons);
    try {
      await store.markDispatching(order.clientOrderId, clock.now().toISOString());
    } catch (err) {
      return notSent(`submit intent could not be persisted: ${errorMessage(err)}`);
    }
    // Everything below the last durable wait: the same fresh-data gate again (our own reservation
    // excluded), then the control plane with no await before the adapter call. A ledger that moved
    // during the validation re-runs the gate (bounded); a quarantine refuses outright.
    let finalGuard: unknown;
    for (let attempt = 1; ; attempt++) {
      const finalGate = await this.gate(approval, ctx, adapter, order.clientOrderId, () =>
        Promise.resolve(((c) => (c.ok ? null : c.reasons))(this.control(approval))),
      );
      if (finalGate.ok) {
        finalGuard = finalGate.verdict.finalGuard;
        break;
      }
      if (finalGate.ledgerMoved && attempt < MAX_LEDGER_ATTEMPTS) continue;
      return notSent(...finalGate.reasons);
    }
    // ---- NO await from here to the adapter call (ADR-0027 §3a) ----
    const last = this.control(approval);
    if (!last.ok) return notSent(...last.reasons);
    // The control result must describe the SAME binding the snapshot, the reservation and the
    // order were made for: a fresh control result must never authorize an obsolete adapter/account.
    if (
      last.adapter !== adapter ||
      last.adapter?.id !== order.adapterId ||
      last.account.id !== account.id ||
      last.account.broker.accountRef !== account.broker.accountRef ||
      last.account.broker.adapterId !== account.broker.adapterId
    )
      return notSent('the adapter or broker account binding changed since the snapshot');
    const guard = this.runFinalGuard(finalGuard);
    if (!guard.ok) return notSent(...guard.reasons);
    let submitted: BrokerOrderState | null = null;
    let submitError: string | null = null;
    let recordError: string | null = null;
    try {
      // Initiation is INSIDE the uncertainty handling: an adapter that throws synchronously after
      // (possibly) dispatching is as uncertain as one whose promise rejects — poll, never resend.
      submitted = await adapter.submitOrder({
        clientOrderId: order.clientOrderId,
        accountRef: account.broker.accountRef,
        symbol: plan.symbol,
        direction: plan.direction,
        quantity: plan.quantity,
        entryType: plan.entryType,
        ...(plan.entryType === 'LIMIT'
          ? { limitPrice: plan.entry, ...(plan.expiresAt ? { expiresAt: plan.expiresAt } : {}) }
          : {}),
        stopLoss: plan.stop,
        takeProfit: plan.target,
      });
    } catch (err) {
      // The broker may or may not have received it: the outcome is unknown until confirmed.
      submitError = errorMessage(err);
    }
    try {
      if (submitted) {
        const applied = await store.updateOrder(order.clientOrderId, submitted);
        if (applied.contradiction) recordError = applied.contradiction;
        await store.appendOrderEvent({
          clientOrderId: order.clientOrderId,
          at: clock.now().toISOString(),
          type: 'SUBMIT_RESPONSE',
          detail: { ...submitted },
        });
      } else {
        await store.appendOrderEvent({
          clientOrderId: order.clientOrderId,
          at: clock.now().toISOString(),
          type: 'SUBMIT_ERROR',
          detail: { error: submitError },
        });
      }
    } catch (err) {
      recordError = errorMessage(err); // keep going: polling the broker is still the truth
    }

    const confirmed = await this.confirm(
      adapter,
      account.broker.accountRef,
      order.clientOrderId,
      plan.entryType === 'LIMIT',
    );
    if (confirmed === null || recordError !== null) {
      const reason =
        confirmed === null
          ? submitError
            ? `submission error (${submitError}) and order state could not be confirmed`
            : `order state not confirmed within ${this.deps.confirmation.timeoutMs}ms`
          : `order state could not be recorded (${recordError}); exposure stays reserved`;
      return this.unknown(order, reason, confirmed ?? submitted, plan.quantity);
    }

    try {
      const applied = await store.updateOrder(order.clientOrderId, confirmed);
      await store.appendOrderEvent({
        clientOrderId: order.clientOrderId,
        at: clock.now().toISOString(),
        type: 'CONFIRMED',
        detail: { ...confirmed },
      });
      if (applied.contradiction) {
        return this.unknown(
          order,
          `contradictory broker evidence (${applied.contradiction}); exposure stays reserved`,
          confirmed,
          plan.quantity,
        );
      }
    } catch (err) {
      return this.unknown(
        order,
        `order state could not be recorded (${errorMessage(err)}); exposure stays reserved`,
        confirmed,
        plan.quantity,
      );
    }
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
        isWorking(confirmed)
          ? `WORKING: LIMIT ${plan.quantity} @ ${plan.entry} until ${plan.expiresAt}`
          : `${confirmed.status} ${confirmed.filledQuantity}/${plan.quantity} @ ${confirmed.averageFillPrice}`,
      ],
      order,
      brokerState: confirmed,
    };
  }

  /**
   * Outcome not established: the reservation stays (a failed write here must not free it),
   * execution is halted for the account, and nothing is ever resent.
   */
  private async unknown(
    order: OrderRecord,
    reason: string,
    last: BrokerOrderState | null,
    quantity: number,
  ): Promise<ExecutionResult> {
    const { store, clock } = this.deps;
    const unknownState: BrokerOrderState = {
      clientOrderId: order.clientOrderId,
      brokerOrderId: last?.brokerOrderId ?? null,
      status: 'UNKNOWN',
      quantity,
      filledQuantity: last?.filledQuantity ?? 0,
      averageFillPrice: last?.averageFillPrice ?? null,
      rejectReason: reason,
      updatedAt: clock.now().toISOString(),
    };
    // Each durable step reports its REAL outcome: a failed write is never presented as recorded.
    // (The DIRTY paper-session marker, written before any interaction, still covers a restart.)
    const failed: string[] = [];
    try {
      await store.updateOrder(order.clientOrderId, unknownState);
      await store.appendOrderEvent({
        clientOrderId: order.clientOrderId,
        at: clock.now().toISOString(),
        type: 'STATE_UNKNOWN',
        detail: { reason },
      });
    } catch (err) {
      // The stored order stays PENDING_SUBMIT/dispatched, which restart treats as unresolved.
      failed.push(`UNKNOWN state/evidence NOT recorded (${errorMessage(err)})`);
    }
    try {
      await this.deps.onExecutionUnknown(order.accountId, order.clientOrderId, reason);
    } catch (err) {
      // The reservation still blocks new entries; reconciliation resolves the order.
      failed.push(`execution halt NOT persisted (${errorMessage(err)})`);
    }
    const detail =
      failed.length > 0
        ? `${reason}; persistence incomplete: ${failed.join('; ')}; the reservation state is whatever the store committed (not asserted) and the account needs recovery`
        : reason;
    return { outcome: 'UNKNOWN', reasons: [detail], order, brokerState: unknownState };
  }

  /**
   * Cancels a resting entry order (risk-reducing: it removes exposure that could still open).
   * Same rules as a protective close: not blocked by mode or trading kill switches, never sent
   * while an EXECUTION kill switch is active or in SHADOW; an unknown outcome halts execution.
   * If the order filled first, the result says so — the position then stays under protection.
   */
  async cancelWorking(req: {
    accountId: string;
    clientOrderId: string;
    reason: string;
  }): Promise<CancelResult> {
    const result = (outcome: CancelOutcome, reason: string, state: BrokerOrderState | null) => ({
      outcome,
      reason,
      state,
    });
    const asked = this.reductionControl(req.accountId, null);
    if (!asked.ok) return result(asked.outcome, asked.reason, null);
    const queued = asked.binding; // what the caller saw when it asked
    const { store, clock } = this.deps;
    return this.locks.run(req.accountId, async () => {
      // Permission is re-read from CURRENT state inside the lock (the request may have queued
      // behind another action), after each awaited step, and immediately before the broker call.
      let c = this.reductionControl(req.accountId, queued);
      if (!c.ok) return result(c.outcome, c.reason, null);
      let target: OrderRecord | null;
      try {
        target = await store.orderByClientId(req.clientOrderId);
      } catch (err) {
        return result(
          'REJECTED',
          `order ${req.clientOrderId} could not be read: ${errorMessage(err)}`,
          null,
        );
      }
      if (!target || target.accountId !== req.accountId)
        return result(
          'REJECTED',
          `order ${req.clientOrderId} does not belong to account ${req.accountId}`,
          null,
        );
      c = this.reductionControl(req.accountId, queued);
      if (!c.ok) return result(c.outcome, c.reason, null);
      if (target.adapterId !== c.adapter.id)
        return result(
          'REJECTED',
          `order ${req.clientOrderId} was placed through adapter ${target.adapterId}, not ${c.adapter.id}`,
          null,
        );
      let state: BrokerOrderState;
      try {
        // No await between the final control read above and this call.
        state = await c.adapter.cancelOrder(c.accountRef, req.clientOrderId);
      } catch (err) {
        return this.actionUnknown(
          req.accountId,
          req.clientOrderId,
          `cancel of ${req.clientOrderId} outcome unknown: ${errorMessage(err)}`,
          null,
          result,
        );
      }
      // Each durable step has its own honest outcome; none implies another.
      let contradiction: string | null = null;
      let stateNote: string | null = null;
      let eventNote: string | null = null;
      try {
        contradiction = (await store.updateOrder(req.clientOrderId, state)).contradiction;
      } catch (err) {
        stateNote = `the order-state evidence was NOT recorded (${errorMessage(err)}); whether it committed is not confirmed`;
      }
      try {
        await store.appendOrderEvent({
          clientOrderId: req.clientOrderId,
          at: clock.now().toISOString(),
          type: 'CANCEL_REQUESTED',
          detail: { reason: req.reason, result: { ...state } },
        });
      } catch (err) {
        eventNote = `the CANCEL_REQUESTED audit event was NOT appended (${errorMessage(err)})`;
      }
      if (stateNote || eventNote || contradiction) {
        const parts = [
          `the broker answered ${state.status}`,
          stateNote ??
            (contradiction
              ? `contradictory broker evidence (${contradiction})`
              : 'the order state was recorded (the reservation follows the recorded state; it is not asserted kept or released here)'),
          eventNote ?? 'the audit event was appended',
        ];
        return this.actionUnknown(
          req.accountId,
          req.clientOrderId,
          `cancel of ${req.clientOrderId}: ${parts.join('; ')}`,
          state,
          result,
        );
      }
      if (state.status === 'CANCELLED') return result('CANCELLED', req.reason, state);
      if (state.status === 'FILLED') return result('FILLED', 'the order filled first', state);
      if (isTerminal(state.status))
        return result('ALREADY_FINAL', `order is ${state.status}`, state);
      return result('REJECTED', `broker left the order ${state.status}`, state);
    });
  }

  /**
   * Permission for a RISK-REDUCING action (cancel of a resting entry, protective close), judged NOW
   * from current state. Synchronous. Unlike entries it is not blocked by mode HALTED or by
   * GLOBAL / ACCOUNT / STRATEGY / INSTRUMENT kill switches (it only removes risk), but: SHADOW and
   * BACKTEST never transmit; the kill-switch state must be loaded and no EXECUTION switch active
   * (the execution path itself cannot be trusted); the account and its CURRENT adapter binding
   * must exist; the adapter kind must match the mode (PAPER adapter in PAPER, LIVE in LIVE); and
   * any LIVE adapter needs the existing environment + account authorization. When `queued` is
   * given the binding must be the one the request was made against (never redirect a queued
   * request to a different adapter or broker account).
   */
  private reductionControl(
    accountId: string,
    queued: Binding | null,
  ):
    | {
        ok: true;
        adapter: BrokerAdapter;
        accountRef: string;
        binding: Binding;
      }
    | { ok: false; outcome: 'SKIPPED' | 'REJECTED'; reason: string } {
    const no = (outcome: 'SKIPPED' | 'REJECTED', reason: string) =>
      ({ ok: false, outcome, reason }) as const;
    const account = this.deps.account(accountId);
    if (!account) return no('REJECTED', `account ${accountId} not found`);
    const mode = this.deps.mode();
    if (mode === 'SHADOW' || mode === 'BACKTEST')
      return no('SKIPPED', `mode ${mode} never transmits orders`);
    const ks = this.deps.killSwitches({ accountId });
    if (!ks.loaded) return no('SKIPPED', ks.reasons.join('; '));
    const execution = ks.blocking.filter((s) => s.scope === 'EXECUTION');
    if (execution.length > 0)
      return no(
        'SKIPPED',
        `EXECUTION kill switch active (${execution.map((s) => s.reason).join('; ')}) — manual action required`,
      );
    const adapterId = account.broker.adapterId;
    const adapter = this.deps.adapter(adapterId);
    if (!adapter) return no('REJECTED', `adapter ${adapterId} not registered`);
    // The binding is the adapter INSTANCE and its kind as well as the ids: a different object
    // registered under the same id/ref while the request queued is a different broker connection.
    const binding: Binding = {
      adapterId,
      accountRef: account.broker.accountRef,
      adapter,
      kind: adapter.kind,
    };
    if (
      queued &&
      (queued.adapterId !== binding.adapterId ||
        queued.accountRef !== binding.accountRef ||
        queued.adapter !== binding.adapter ||
        queued.kind !== binding.kind)
    )
      return no(
        'REJECTED',
        "the account's broker binding (adapter instance, kind or broker account) changed since the request was queued",
      );
    const policy = modePolicy(mode);
    if (policy.brokerKind && adapter.kind !== policy.brokerKind)
      return no(
        'REJECTED',
        `adapter ${adapter.id} is ${adapter.kind}; mode ${mode} requires ${policy.brokerKind}`,
      );
    if (
      adapter.kind === 'LIVE' &&
      !(this.deps.liveTradingEnvironmentAuthorized() && account.liveTradingAuthorized)
    )
      return no(
        'REJECTED',
        'live trading not authorized (environment and account authorization required)',
      );
    return { ok: true, adapter, accountRef: binding.accountRef, binding };
  }

  /**
   * An action whose outcome (or whose recording) is not established: execution is halted for the
   * account and the result says exactly which persistence step failed; nothing is released or
   * resent.
   */
  private async actionUnknown<R>(
    accountId: string,
    id: string,
    reason: string,
    state: BrokerOrderState | null,
    result: (outcome: 'UNKNOWN', reason: string, state: BrokerOrderState | null) => R,
  ): Promise<R> {
    let detail: string;
    try {
      await this.deps.onExecutionUnknown(accountId, id, reason);
      detail = `${reason}; execution halted (persisted)`;
    } catch (err) {
      detail = `${reason}; execution halt NOT persisted (${errorMessage(err)})`;
    }
    return result('UNKNOWN', detail, state);
  }

  /**
   * Reads an order's current state from its broker and records any change (fill, expiry,
   * cancellation of a resting order). Returns the state, or null when the broker cannot say.
   */
  async refresh(
    order: OrderRecord,
  ): Promise<{ state: BrokerOrderState | null; changed: boolean; error?: string }> {
    const account = this.deps.account(order.accountId);
    const adapter = order.adapterId ? this.deps.adapter(order.adapterId) : undefined;
    if (!account || !adapter) return { state: null, changed: false, error: 'no adapter' };
    let state: BrokerOrderState | null;
    try {
      state = await adapter.getOrder(account.broker.accountRef, order.clientOrderId);
    } catch (err) {
      return { state: null, changed: false, error: errorMessage(err) };
    }
    if (!state) return { state: null, changed: false, error: 'order not found at the broker' };
    const changed =
      state.status !== order.status ||
      state.filledQuantity !== order.filledQuantity ||
      state.averageFillPrice !== order.averageFillPrice;
    if (changed) {
      const applied = await this.deps.store.updateOrder(order.clientOrderId, state);
      await this.deps.store.appendOrderEvent({
        clientOrderId: order.clientOrderId,
        at: this.deps.clock.now().toISOString(),
        type: 'STATE_CHANGED',
        detail: { from: order.status, ...state },
      });
      if (applied.contradiction) {
        const reason = `contradictory broker evidence (${applied.contradiction}); exposure stays reserved`;
        await this.deps.onExecutionUnknown(order.accountId, order.clientOrderId, reason);
        return { state, changed, error: reason };
      }
    }
    return { state, changed };
  }

  /**
   * Risk-reducing close of one position (ADR-0014). Unlike new trades it is not blocked by mode
   * or GLOBAL / ACCOUNT / STRATEGY / INSTRUMENT kill switches — it only removes risk — but it is
   * never sent while an EXECUTION kill switch says the execution path itself cannot be trusted,
   * and never in SHADOW (nothing is transmitted there). An unknown outcome halts execution for the
   * account, exactly like an unconfirmed order. Runs under the account's execution lock.
   */
  async protectiveClose(req: {
    accountId: string;
    positionId: string;
    clientCloseId: string;
    reason: string;
  }): Promise<ProtectiveCloseResult> {
    const result = (
      outcome: ProtectiveCloseOutcome,
      reason: string,
      exitPrice: number | null = null,
      realizedPnl: number | null = null,
    ): ProtectiveCloseResult => ({ outcome, reason, exitPrice, realizedPnl });
    const asked = this.reductionControl(req.accountId, null);
    if (!asked.ok) return result(asked.outcome, asked.reason);
    const queued = asked.binding;
    return this.locks.run(req.accountId, async () => {
      // Re-read from CURRENT state inside the lock; the broker is addressed only through the
      // binding the request was made against, so a position id can never be applied to another
      // account. No await between this last read and the broker call.
      const c = this.reductionControl(req.accountId, queued);
      if (!c.ok) return result(c.outcome, c.reason);
      try {
        const r = await c.adapter.closePosition({
          clientCloseId: req.clientCloseId,
          accountRef: c.accountRef,
          positionId: req.positionId,
          reason: req.reason,
        });
        if (r.status === 'CLOSED')
          return result('CLOSED', r.detail ?? req.reason, r.exitPrice, r.realizedPnl);
        if (r.status === 'NOT_FOUND')
          return result('ALREADY_FLAT', r.detail ?? 'position not open');
        return result('REJECTED', r.detail ?? 'close rejected by the broker');
      } catch (err) {
        return this.actionUnknown(
          req.accountId,
          req.clientCloseId,
          `close of ${req.positionId} outcome unknown: ${errorMessage(err)}`,
          null,
          (_o, reason) => result('UNKNOWN', reason),
        );
      }
    });
  }

  /**
   * Polls the broker until the order reaches a terminal (or, for LIMIT, resting) state. A partial fill still working at
   * the deadline has its remainder cancelled. Returns null when the state cannot be confirmed.
   */
  private async confirm(
    adapter: BrokerAdapter,
    accountRef: string,
    clientOrderId: string,
    /** LIMIT: a resting order the broker accepted is a confirmed state. */
    acceptWorking: boolean,
  ): Promise<BrokerOrderState | null> {
    const deadline = this.deps.clock.now().getTime() + this.deps.confirmation.timeoutMs;
    let last: BrokerOrderState | null = null;
    for (;;) {
      try {
        last = await adapter.getOrder(accountRef, clientOrderId);
      } catch {
        last = null;
      }
      if (last && (isTerminal(last.status) || (acceptWorking && isWorking(last)))) return last;
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
