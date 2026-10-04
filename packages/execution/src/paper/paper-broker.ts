/**
 * Paper broker adapter (spec §34, §65). A deterministic in-memory broker: market orders fill at
 * the current ask/bid plus configured slippage; every position carries its bracket (stop and
 * target) which is triggered by incoming quotes. Failure injection lets tests exercise the full
 * safety chain (rejections, transport errors, unconfirmed orders, partial fills).
 *
 * Commission is charged in full (round turn) at entry — conservative for paper results.
 *
 * LIMIT entries rest until the market reaches the limit (LONG: ask ≤ limit; SHORT: bid ≥ limit)
 * and then fill AT the limit (never better), or expire at `expiresAt`. A limit that is already
 * marketable when submitted fills at once at the market (ask / bid ≤ limit for LONG).
 */
import {
  AstraError,
  conversionRate,
  valueInAccountCurrency,
  ZERO,
  dec,
  uuidv7,
  directionSign,
  money,
  toNum,
  type AccountSnapshot,
  type Clock,
  type EntryType,
  type InstrumentSpec,
  type OpenPosition,
  type Quote,
} from '@astra/core';
import type {
  AdapterHealth,
  BrokerAdapter,
  BrokerOrderState,
  ClosePositionRequest,
  ClosePositionResult,
  OrderRequest,
} from '../types';

export interface PaperClosedTrade {
  readonly positionId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly direction: OpenPosition['direction'];
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  /** PROTECTIVE: closed by ASTRA's automatic protection (ADR-0014). */
  readonly exitReason: 'STOP' | 'TARGET' | 'MANUAL' | 'PROTECTIVE';
  readonly realizedPnl: number;
  readonly openedAt: string;
  readonly closedAt: string;
}

export interface PaperFailureInjection {
  /** Reject the next submitted order with this reason. */
  rejectNextOrder?: string;
  /** Throw a transport error on submit AFTER accepting the order (response lost). */
  loseNextSubmitResponse?: boolean;
  /** Throw a transport error on submit BEFORE accepting the order. */
  failNextSubmit?: boolean;
  /** Leave orders in SUBMITTED forever (never confirm). */
  neverConfirm?: boolean;
  /** Fill only this fraction of the next order (rounded down to the quantity step). */
  partialFillRatio?: number;
  /** Health reported by the adapter. */
  health?: AdapterHealth;
  /** Reject the next close request with this reason. */
  rejectNextClose?: string;
  /** Throw a transport error on the next close request (outcome unknown to the caller). */
  failNextClose?: boolean;
}

/** A resting LIMIT entry (its broker state is ACCEPTED until it fills, expires or is cancelled). */
export interface PaperWorkingOrder {
  readonly request: OrderRequest;
  readonly placedAt: string;
}

interface PaperAccount {
  balance: ReturnType<typeof dec>;
  positions: Map<string, OpenPosition & { clientOrderId: string }>;
  orders: Map<string, BrokerOrderState>;
  working: Map<string, PaperWorkingOrder>;
  closed: PaperClosedTrade[];
  currency: string;
  /** Close results by clientCloseId (idempotency; not persisted). */
  closes: Map<string, ClosePositionResult>;
}

export interface PaperBrokerOptions {
  readonly id?: string;
  readonly clock: Clock;
  readonly instruments: (symbol: string) => InstrumentSpec | undefined;
  /** Simulated fill slippage in ticks (adverse). */
  readonly fillSlippageTicks?: number;
  /** Called after any change to an account's state (so the caller can persist it). */
  readonly onChange?: (accountRef: string) => void;
  /**
   * Returns a reason while this process must not mutate or read paper state (ownership not yet
   * ACKed as DIRTY, ownership lost, persistence failed, shutting down). Quotes are then ignored and
   * every interaction rejects. Wired in production; absent only in unit fixtures.
   */
  readonly blocked?: () => string | null;
  /** Quotes are ignored (not cached, no fills) while this returns true (clean shutdown). */
  readonly ignoreQuotes?: () => boolean;
}

/** Serializable paper account state (persisted so paper trading survives restarts). */
export interface PaperAccountState {
  readonly balance: number;
  readonly currency: string;
  readonly positions: readonly (OpenPosition & { clientOrderId: string })[];
  readonly orders: readonly BrokerOrderState[];
  readonly closed: readonly PaperClosedTrade[];
  /** Resting LIMIT entries (absent in state saved before LIMIT support). */
  readonly working?: readonly PaperWorkingOrder[];
}

export class PaperBrokerAdapter implements BrokerAdapter {
  readonly id: string;
  readonly kind = 'PAPER' as const;
  readonly supportedEntryTypes: readonly EntryType[] = ['MARKET', 'LIMIT'];

  private readonly accounts = new Map<string, PaperAccount>();
  private readonly quotes = new Map<string, Quote>();
  failures: PaperFailureInjection = {};

  constructor(private readonly opts: PaperBrokerOptions) {
    this.id = opts.id ?? 'paper';
  }

  /** Creates (or resets) a simulated account. */
  openAccount(accountRef: string, startingBalance: number, currency = 'USD'): void {
    this.accounts.set(accountRef, {
      balance: dec(startingBalance),
      positions: new Map(),
      orders: new Map(),
      working: new Map(),
      closed: [],
      currency,
      closes: new Map(),
    });
  }

  hasAccount(accountRef: string): boolean {
    return this.accounts.has(accountRef);
  }

  closedTrades(accountRef: string): readonly PaperClosedTrade[] {
    return this.account(accountRef).closed;
  }

  exportAccount(accountRef: string): PaperAccountState {
    const a = this.account(accountRef);
    return {
      balance: money(a.balance),
      currency: a.currency,
      positions: [...a.positions.values()],
      orders: [...a.orders.values()],
      closed: [...a.closed],
      working: [...a.working.values()],
    };
  }

  importAccount(accountRef: string, state: PaperAccountState): void {
    this.accounts.set(accountRef, {
      balance: dec(state.balance),
      currency: state.currency,
      positions: new Map(state.positions.map((p) => [p.positionId, { ...p }])),
      orders: new Map(state.orders.map((o) => [o.clientOrderId, o])),
      working: new Map((state.working ?? []).map((w) => [w.request.clientOrderId, w])),
      closed: [...state.closed],
      closes: new Map(),
    });
  }

  private changed(accountRef: string): void {
    this.opts.onChange?.(accountRef);
  }

  health(): Promise<AdapterHealth> {
    return Promise.resolve(
      this.failures.health ?? { status: 'ONLINE', detail: 'paper broker (simulated)' },
    );
  }

  /** Feeds a quote: fills or expires resting LIMIT entries, then triggers stops/targets. */
  onQuote(quote: Quote): void {
    if (this.opts.blocked?.() || this.opts.ignoreQuotes?.()) return; // no mutation, no cache
    this.quotes.set(quote.symbol, quote);
    for (const [ref, acct] of this.accounts) {
      // Entries first: a position just filled is exposed to this same quote (pessimistic).
      this.expireDue(ref);
      for (const w of [...acct.working.values()]) {
        const r = w.request;
        if (r.symbol !== quote.symbol || r.limitPrice === undefined) continue;
        const reached =
          r.direction === 'LONG' ? quote.ask <= r.limitPrice : quote.bid >= r.limitPrice;
        if (!reached) continue;
        acct.working.delete(r.clientOrderId);
        const base = acct.orders.get(r.clientOrderId)!;
        acct.orders.set(r.clientOrderId, this.fill(r, base, r.limitPrice));
        this.changed(ref);
      }
      for (const pos of [...acct.positions.values()]) {
        if (pos.symbol !== quote.symbol) continue;
        const exitSide = pos.direction === 'LONG' ? quote.bid : quote.ask;
        const long = pos.direction === 'LONG';
        if (
          pos.stopPrice !== null &&
          (long ? exitSide <= pos.stopPrice : exitSide >= pos.stopPrice)
        ) {
          // Gap-through: fill at the worse of the stop and the market.
          const fill = long ? Math.min(pos.stopPrice, exitSide) : Math.max(pos.stopPrice, exitSide);
          this.settlePosition(ref, pos.positionId, fill, 'STOP');
          this.changed(ref);
        } else if (
          pos.targetPrice !== null &&
          (long ? exitSide >= pos.targetPrice : exitSide <= pos.targetPrice)
        ) {
          this.settlePosition(ref, pos.positionId, pos.targetPrice, 'TARGET');
          this.changed(ref);
        }
      }
    }
  }

  /** Rejects (as a failed broker call) while the owner guard blocks paper interaction. */
  private blockedCall(): Promise<never> | null {
    const why = this.opts.blocked?.();
    return why ? Promise.reject(new Error(`paper broker unavailable: ${why}`)) : null;
  }

  submitOrder(req: OrderRequest): Promise<BrokerOrderState> {
    const blocked = this.blockedCall();
    if (blocked) return blocked;
    const acct = this.account(req.accountRef);
    const existing = acct.orders.get(req.clientOrderId);
    if (existing) return Promise.resolve(existing); // idempotent

    if (this.failures.failNextSubmit) {
      this.failures.failNextSubmit = false;
      return Promise.reject(
        new Error('paper broker: simulated transport failure before acceptance'),
      );
    }
    const now = this.opts.clock.now().toISOString();
    const base: BrokerOrderState = {
      clientOrderId: req.clientOrderId,
      brokerOrderId: `PAPER-${uuidv7()}`,
      status: 'SUBMITTED',
      quantity: req.quantity,
      filledQuantity: 0,
      averageFillPrice: null,
      rejectReason: null,
      updatedAt: now,
    };

    const rejection = this.validate(req);
    if (rejection !== null || this.failures.rejectNextOrder) {
      const reason = this.failures.rejectNextOrder ?? rejection!;
      this.failures.rejectNextOrder = undefined;
      const rejected = { ...base, status: 'REJECTED' as const, rejectReason: reason };
      acct.orders.set(req.clientOrderId, rejected);
      this.changed(req.accountRef);
      return Promise.resolve(rejected);
    }

    let state: BrokerOrderState = base;
    if (!this.failures.neverConfirm) {
      const q = this.quotes.get(req.symbol)!;
      const marketable =
        req.entryType !== 'LIMIT' ||
        (req.direction === 'LONG' ? q.ask <= req.limitPrice! : q.bid >= req.limitPrice!);
      if (marketable) {
        state = this.fill(req, base);
      } else {
        state = { ...base, status: 'ACCEPTED' };
        acct.working.set(req.clientOrderId, { request: req, placedAt: base.updatedAt });
      }
    }
    acct.orders.set(req.clientOrderId, state);
    this.changed(req.accountRef);

    if (this.failures.loseNextSubmitResponse) {
      this.failures.loseNextSubmitResponse = false;
      return Promise.reject(new Error('paper broker: simulated lost response after acceptance'));
    }
    return Promise.resolve(state);
  }

  getOrder(accountRef: string, clientOrderId: string): Promise<BrokerOrderState | null> {
    const blocked = this.blockedCall();
    if (blocked) return blocked;
    this.expireDue(accountRef);
    return Promise.resolve(this.account(accountRef).orders.get(clientOrderId) ?? null);
  }

  /** Resting LIMIT entries past their expiry become EXPIRED (checked on every access). */
  private expireDue(accountRef: string): void {
    const acct = this.account(accountRef);
    const now = this.opts.clock.now();
    for (const w of [...acct.working.values()]) {
      const at = w.request.expiresAt;
      if (at === undefined || now.getTime() < Date.parse(at)) continue;
      acct.working.delete(w.request.clientOrderId);
      const o = acct.orders.get(w.request.clientOrderId)!;
      acct.orders.set(w.request.clientOrderId, {
        ...o,
        status: 'EXPIRED',
        rejectReason: `limit not reached by ${at}`,
        updatedAt: now.toISOString(),
      });
      this.changed(accountRef);
    }
  }

  cancelOrder(accountRef: string, clientOrderId: string): Promise<BrokerOrderState> {
    const blocked = this.blockedCall();
    if (blocked) return blocked;
    const acct = this.account(accountRef);
    const o = acct.orders.get(clientOrderId);
    if (!o) return Promise.reject(new AstraError('NOT_FOUND', `order ${clientOrderId} not found`));
    this.expireDue(accountRef);
    const current = acct.orders.get(clientOrderId)!;
    if (['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(current.status))
      return Promise.resolve(current);
    acct.working.delete(clientOrderId);
    const cancelled: BrokerOrderState = {
      ...o,
      status: o.filledQuantity > 0 ? 'FILLED' : 'CANCELLED',
      quantity: o.filledQuantity > 0 ? o.filledQuantity : o.quantity,
      updatedAt: this.opts.clock.now().toISOString(),
    };
    acct.orders.set(clientOrderId, cancelled);
    this.changed(accountRef);
    return Promise.resolve(cancelled);
  }

  listOpenOrders(accountRef: string): Promise<BrokerOrderState[]> {
    const blocked = this.blockedCall();
    if (blocked) return blocked;
    this.expireDue(accountRef);
    return Promise.resolve(
      [...this.account(accountRef).orders.values()].filter((o) =>
        ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'PENDING_SUBMIT'].includes(o.status),
      ),
    );
  }

  getAccountSnapshot(accountRef: string, accountId: string): Promise<AccountSnapshot> {
    const blocked = this.blockedCall();
    if (blocked) return blocked;
    this.expireDue(accountRef);
    const acct = this.account(accountRef);
    let floating = ZERO;
    const positions: OpenPosition[] = [];
    for (const p of acct.positions.values()) {
      const q = this.quotes.get(p.symbol);
      const spec = this.valued(p.symbol, acct.currency);
      const mark = q ? (p.direction === 'LONG' ? q.bid : q.ask) : p.currentPrice;
      const pnl = dec(mark)
        .minus(p.entryPrice)
        .mul(directionSign(p.direction))
        .mul(spec.tickValue)
        .div(spec.tickSize)
        .mul(p.quantity);
      floating = floating.plus(pnl);
      const { clientOrderId: _omit, ...pos } = p;
      positions.push({ ...pos, currentPrice: mark, unrealizedPnl: money(pnl) });
    }
    const pending = [...acct.orders.values()].filter(
      (o) => o.status === 'SUBMITTED' || o.status === 'ACCEPTED',
    ).length;
    return Promise.resolve({
      accountId,
      asOf: this.opts.clock.now().toISOString(),
      currency: acct.currency,
      balance: money(acct.balance),
      equity: money(acct.balance.plus(floating)),
      openPositions: positions,
      pendingOrders: pending,
      workingOrders: [...acct.working.values()].map(({ request: r, placedAt }) => ({
        clientOrderId: r.clientOrderId,
        symbol: r.symbol,
        direction: r.direction,
        quantity: r.quantity,
        limitPrice: r.limitPrice!,
        stopPrice: r.stopLoss,
        targetPrice: r.takeProfit,
        placedAt,
        expiresAt: r.expiresAt!,
      })),
    });
  }

  closePosition(req: ClosePositionRequest): Promise<ClosePositionResult> {
    const blocked = this.blockedCall();
    if (blocked) return blocked;
    const acct = this.account(req.accountRef);
    const previous = acct.closes.get(req.clientCloseId);
    if (previous) return Promise.resolve(previous); // idempotent
    if (this.failures.failNextClose) {
      this.failures.failNextClose = false;
      return Promise.reject(new Error('paper broker: simulated transport failure on close'));
    }
    const now = this.opts.clock.now().toISOString();
    const result = (
      status: ClosePositionResult['status'],
      detail: string | null,
      exitPrice: number | null = null,
      realizedPnl: number | null = null,
    ): ClosePositionResult => ({
      clientCloseId: req.clientCloseId,
      positionId: req.positionId,
      status,
      exitPrice,
      realizedPnl,
      detail,
      updatedAt: now,
    });
    const rejectReason = this.failures.rejectNextClose;
    if (rejectReason !== undefined) {
      this.failures.rejectNextClose = undefined;
      return Promise.resolve(result('REJECTED', rejectReason)); // not stored: a retry may succeed
    }
    const pos = acct.positions.get(req.positionId);
    let r: ClosePositionResult;
    if (!pos) {
      r = result('NOT_FOUND', 'position is not open');
    } else {
      const q = this.quotes.get(pos.symbol);
      if (!q) return Promise.resolve(result('REJECTED', `no market for ${pos.symbol}`));
      const exit = pos.direction === 'LONG' ? q.bid : q.ask;
      this.settlePosition(req.accountRef, req.positionId, exit, 'PROTECTIVE');
      const trade = acct.closed.at(-1)!;
      r = result('CLOSED', req.reason, trade.exitPrice, trade.realizedPnl);
      this.changed(req.accountRef);
    }
    acct.closes.set(req.clientCloseId, r);
    return Promise.resolve(r);
  }

  /** Test/operator helper: close a position at the current market. */
  closeAtMarket(accountRef: string, positionId: string): void {
    const why = this.opts.blocked?.();
    if (why) throw new Error(`paper broker unavailable: ${why}`);
    const pos = this.account(accountRef).positions.get(positionId);
    if (!pos) throw new AstraError('NOT_FOUND', `position ${positionId} not found`);
    const q = this.quotes.get(pos.symbol);
    if (!q) throw new AstraError('UNAVAILABLE', `no quote for ${pos.symbol}`);
    this.settlePosition(accountRef, positionId, pos.direction === 'LONG' ? q.bid : q.ask, 'MANUAL');
    this.changed(accountRef);
  }

  private validate(req: OrderRequest): string | null {
    if (!this.supportedEntryTypes.includes(req.entryType))
      return `entry type ${String(req.entryType)} not supported by paper broker`;
    const spec = this.opts.instruments(req.symbol);
    if (!spec) return `unknown instrument ${req.symbol}`;
    if (!this.quotes.has(req.symbol)) return `no market for ${req.symbol}`;
    // P&L must be convertible to the account currency; quotes are kept, so it stays convertible.
    const currency = this.account(req.accountRef).currency;
    const valued = valueInAccountCurrency(spec, currency, (from) =>
      conversionRate(from, currency, this.quotes.keys(), (s) => this.quotes.get(s) ?? null),
    );
    if (valued.conversionError) return valued.conversionError;
    if (req.quantity < spec.minQuantity) return 'quantity below minimum';
    const sign = directionSign(req.direction);
    const q = this.quotes.get(req.symbol)!;
    const market = req.direction === 'LONG' ? q.ask : q.bid;
    if (req.entryType === 'LIMIT') {
      if (req.limitPrice === undefined || !(req.limitPrice > 0))
        return 'LIMIT order without a price';
      if (!req.expiresAt || !(Date.parse(req.expiresAt) > this.opts.clock.now().getTime()))
        return 'LIMIT order without a future expiry';
      if (!dec(req.limitPrice).div(spec.tickSize).isInteger())
        return 'limit price is not on the tick grid';
    }
    // Brackets are checked against where the position will open (the limit, or the market).
    const px =
      req.entryType === 'LIMIT' &&
      (req.direction === 'LONG' ? market > req.limitPrice! : market < req.limitPrice!)
        ? req.limitPrice!
        : market;
    if (dec(px).minus(req.stopLoss).mul(sign).lte(0))
      return 'stop loss on the wrong side of the market';
    if (dec(req.takeProfit).minus(px).mul(sign).lte(0))
      return 'take profit on the wrong side of the market';
    return null;
  }

  /** Fills at the market (plus slippage), or at `atPrice` for a resting LIMIT that was reached. */
  private fill(req: OrderRequest, base: BrokerOrderState, atPrice?: number): BrokerOrderState {
    const acct = this.account(req.accountRef);
    const spec = this.spec(req.symbol);
    const q = this.quotes.get(req.symbol)!;
    const slip = dec(this.opts.fillSlippageTicks ?? 0)
      .mul(spec.tickSize)
      .mul(directionSign(req.direction));
    const price = atPrice ?? toNum(dec(req.direction === 'LONG' ? q.ask : q.bid).plus(slip));

    let qty = dec(req.quantity);
    const ratio = this.failures.partialFillRatio;
    if (ratio !== undefined) {
      this.failures.partialFillRatio = undefined;
      qty = qty.mul(ratio).div(spec.quantityStep).floor().mul(spec.quantityStep);
    }
    if (qty.lte(0)) return { ...base, status: 'ACCEPTED' };

    const fee = this.valued(req.symbol, acct.currency).costs.commissionPerUnitRoundTurn;
    acct.balance = acct.balance.minus(dec(fee).mul(qty));
    const now = this.opts.clock.now().toISOString();
    const positionId = `PAPER-POS-${uuidv7()}`;
    acct.positions.set(positionId, {
      positionId,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      direction: req.direction,
      quantity: toNum(qty),
      entryPrice: price,
      currentPrice: price,
      stopPrice: req.stopLoss,
      targetPrice: req.takeProfit,
      unrealizedPnl: 0,
      openedAt: now,
    });
    const full = qty.eq(req.quantity);
    return {
      ...base,
      status: full ? 'FILLED' : 'PARTIALLY_FILLED',
      filledQuantity: toNum(qty),
      averageFillPrice: price,
      updatedAt: now,
    };
  }

  private settlePosition(
    accountRef: string,
    positionId: string,
    exitPrice: number,
    reason: PaperClosedTrade['exitReason'],
  ): void {
    const acct = this.account(accountRef);
    const pos = acct.positions.get(positionId);
    if (!pos) return;
    const spec = this.valued(pos.symbol, acct.currency);
    const pnl = dec(exitPrice)
      .minus(pos.entryPrice)
      .mul(directionSign(pos.direction))
      .mul(spec.tickValue)
      .div(spec.tickSize)
      .mul(pos.quantity);
    acct.balance = acct.balance.plus(pnl);
    acct.positions.delete(positionId);
    acct.closed.push({
      positionId,
      clientOrderId: pos.clientOrderId,
      symbol: pos.symbol,
      direction: pos.direction,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      exitPrice,
      exitReason: reason,
      realizedPnl: money(pnl),
      openedAt: pos.openedAt,
      closedAt: this.opts.clock.now().toISOString(),
    });
  }

  private account(ref: string): PaperAccount {
    const a = this.accounts.get(ref);
    if (!a) throw new AstraError('NOT_FOUND', `paper account ${ref} not open`);
    return a;
  }

  private spec(symbol: string): InstrumentSpec {
    const s = this.opts.instruments(symbol);
    if (!s) throw new AstraError('NOT_FOUND', `unknown instrument ${symbol}`);
    return s;
  }

  /** The spec valued in the account currency from the latest quotes (P&L is never 1:1 guessed). */
  private valued(symbol: string, currency: string): InstrumentSpec {
    const v = valueInAccountCurrency(this.spec(symbol), currency, (from) =>
      conversionRate(from, currency, this.quotes.keys(), (s) => this.quotes.get(s) ?? null),
    );
    if (v.conversionError) throw new AstraError('UNAVAILABLE', v.conversionError);
    return v;
  }
}
