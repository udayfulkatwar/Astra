/**
 * Paper broker adapter (spec §34, §65). A deterministic in-memory broker: market orders fill at
 * the current ask/bid plus configured slippage; every position carries its bracket (stop and
 * target) which is triggered by incoming quotes. Failure injection lets tests exercise the full
 * safety chain (rejections, transport errors, unconfirmed orders, partial fills).
 *
 * Commission is charged in full (round turn) at entry — conservative for paper results.
 */
import {
  AstraError,
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
import type { AdapterHealth, BrokerAdapter, BrokerOrderState, OrderRequest } from '../types';

export interface PaperClosedTrade {
  readonly positionId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly direction: OpenPosition['direction'];
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly exitReason: 'STOP' | 'TARGET' | 'MANUAL';
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
}

interface PaperAccount {
  balance: ReturnType<typeof dec>;
  positions: Map<string, OpenPosition & { clientOrderId: string }>;
  orders: Map<string, BrokerOrderState>;
  closed: PaperClosedTrade[];
  currency: string;
}

export interface PaperBrokerOptions {
  readonly id?: string;
  readonly clock: Clock;
  readonly instruments: (symbol: string) => InstrumentSpec | undefined;
  /** Simulated fill slippage in ticks (adverse). */
  readonly fillSlippageTicks?: number;
  /** Called after any change to an account's state (so the caller can persist it). */
  readonly onChange?: (accountRef: string) => void;
}

/** Serializable paper account state (persisted so paper trading survives restarts). */
export interface PaperAccountState {
  readonly balance: number;
  readonly currency: string;
  readonly positions: readonly (OpenPosition & { clientOrderId: string })[];
  readonly orders: readonly BrokerOrderState[];
  readonly closed: readonly PaperClosedTrade[];
}

export class PaperBrokerAdapter implements BrokerAdapter {
  readonly id: string;
  readonly kind = 'PAPER' as const;
  readonly supportedEntryTypes: readonly EntryType[] = ['MARKET'];

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
      closed: [],
      currency,
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
    };
  }

  importAccount(accountRef: string, state: PaperAccountState): void {
    this.accounts.set(accountRef, {
      balance: dec(state.balance),
      currency: state.currency,
      positions: new Map(state.positions.map((p) => [p.positionId, { ...p }])),
      orders: new Map(state.orders.map((o) => [o.clientOrderId, o])),
      closed: [...state.closed],
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

  /** Feeds a quote: updates marks and triggers stops/targets. */
  onQuote(quote: Quote): void {
    this.quotes.set(quote.symbol, quote);
    for (const [ref, acct] of this.accounts) {
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
          this.closePosition(ref, pos.positionId, fill, 'STOP');
          this.changed(ref);
        } else if (
          pos.targetPrice !== null &&
          (long ? exitSide >= pos.targetPrice : exitSide <= pos.targetPrice)
        ) {
          this.closePosition(ref, pos.positionId, pos.targetPrice, 'TARGET');
          this.changed(ref);
        }
      }
    }
  }

  submitOrder(req: OrderRequest): Promise<BrokerOrderState> {
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
      state = this.fill(req, base);
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
    return Promise.resolve(this.account(accountRef).orders.get(clientOrderId) ?? null);
  }

  cancelOrder(accountRef: string, clientOrderId: string): Promise<BrokerOrderState> {
    const acct = this.account(accountRef);
    const o = acct.orders.get(clientOrderId);
    if (!o) return Promise.reject(new AstraError('NOT_FOUND', `order ${clientOrderId} not found`));
    if (o.status === 'FILLED' || o.status === 'REJECTED' || o.status === 'CANCELLED')
      return Promise.resolve(o);
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
    return Promise.resolve(
      [...this.account(accountRef).orders.values()].filter((o) =>
        ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'PENDING_SUBMIT'].includes(o.status),
      ),
    );
  }

  getAccountSnapshot(accountRef: string, accountId: string): Promise<AccountSnapshot> {
    const acct = this.account(accountRef);
    let floating = ZERO;
    const positions: OpenPosition[] = [];
    for (const p of acct.positions.values()) {
      const q = this.quotes.get(p.symbol);
      const spec = this.spec(p.symbol);
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
    });
  }

  /** Test/operator helper: close a position at the current market. */
  closeAtMarket(accountRef: string, positionId: string): void {
    const pos = this.account(accountRef).positions.get(positionId);
    if (!pos) throw new AstraError('NOT_FOUND', `position ${positionId} not found`);
    const q = this.quotes.get(pos.symbol);
    if (!q) throw new AstraError('UNAVAILABLE', `no quote for ${pos.symbol}`);
    this.closePosition(accountRef, positionId, pos.direction === 'LONG' ? q.bid : q.ask, 'MANUAL');
    this.changed(accountRef);
  }

  private validate(req: OrderRequest): string | null {
    if (req.entryType !== 'MARKET')
      return `entry type ${req.entryType} not supported by paper broker`;
    const spec = this.opts.instruments(req.symbol);
    if (!spec) return `unknown instrument ${req.symbol}`;
    if (!this.quotes.has(req.symbol)) return `no market for ${req.symbol}`;
    if (req.quantity < spec.minQuantity) return 'quantity below minimum';
    const sign = directionSign(req.direction);
    const q = this.quotes.get(req.symbol)!;
    const px = req.direction === 'LONG' ? q.ask : q.bid;
    if (dec(px).minus(req.stopLoss).mul(sign).lte(0))
      return 'stop loss on the wrong side of the market';
    if (dec(req.takeProfit).minus(px).mul(sign).lte(0))
      return 'take profit on the wrong side of the market';
    return null;
  }

  private fill(req: OrderRequest, base: BrokerOrderState): BrokerOrderState {
    const acct = this.account(req.accountRef);
    const spec = this.spec(req.symbol);
    const q = this.quotes.get(req.symbol)!;
    const slip = dec(this.opts.fillSlippageTicks ?? 0)
      .mul(spec.tickSize)
      .mul(directionSign(req.direction));
    const price = toNum(dec(req.direction === 'LONG' ? q.ask : q.bid).plus(slip));

    let qty = dec(req.quantity);
    const ratio = this.failures.partialFillRatio;
    if (ratio !== undefined) {
      this.failures.partialFillRatio = undefined;
      qty = qty.mul(ratio).div(spec.quantityStep).floor().mul(spec.quantityStep);
    }
    if (qty.lte(0)) return { ...base, status: 'ACCEPTED' };

    acct.balance = acct.balance.minus(dec(spec.costs.commissionPerUnitRoundTurn).mul(qty));
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

  private closePosition(
    accountRef: string,
    positionId: string,
    exitPrice: number,
    reason: PaperClosedTrade['exitReason'],
  ): void {
    const acct = this.account(accountRef);
    const pos = acct.positions.get(positionId);
    if (!pos) return;
    const spec = this.spec(pos.symbol);
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
}
