/**
 * Multi-pair simulated broker for research replays on bid/ask M5 candles. Pessimistic by
 * construction (SPEC §20: model spread, commission, slippage, fills, missed limits, stops):
 *
 * - An order decided at a candle's close is active from the NEXT candle.
 * - A resting LIMIT fills AT its limit (never better) only in a candle whose entry side trades
 *   `limitThroughTicks` beyond it (ask for a buy, bid for a sell) and that closes before the
 *   order expires. A touch is not a fill; an order never reached is MISSED.
 * - In its fill candle a position can hit its stop (that candle's adverse extreme counts) but
 *   not its target (the order of highs and lows inside a candle is unknown).
 * - Exits are on the exit side (bid for a long, ask for a short). If a candle reaches both the
 *   stop and the target, the STOP is assumed. A stop gapped through at the open fills at the
 *   open. Stops and protective closes pay slippage; targets fill at the target.
 * - Commission is charged at entry. Money is valued in the account currency at the moment of
 *   the fill / exit (USD/JPY with its own mid price).
 */
import {
  conversionRate,
  dec,
  directionSign,
  money,
  toNum,
  valueInAccountCurrency,
  type AccountSnapshot,
  type Direction,
  type InstrumentSpec,
  type OpenPosition,
  type ValuedInstrumentSpec,
  type WorkingOrder,
} from '@astra/core';
import type { Ohlc, ResearchBar } from './data';

export interface CostModel {
  /** Adverse slippage (ticks) on stop exits and protective closes. */
  readonly slippageTicks: number;
  /** LIMIT fills need the market to trade this many ticks beyond the limit. */
  readonly limitThroughTicks: number;
  /** Charge the instrument's commission. */
  readonly commission: boolean;
  /** Spread multiplier around the mid (0 = no spread: both sides at the mid). */
  readonly spreadMultiplier: number;
}

export const REALISTIC_COSTS: CostModel = {
  slippageTicks: 2,
  limitThroughTicks: 1,
  commission: true,
  spreadMultiplier: 1,
};

/** "Before costs": mid prices, touch fills, no slippage, no commission. */
export const NO_COSTS: CostModel = {
  slippageTicks: 0,
  limitThroughTicks: 0,
  commission: false,
  spreadMultiplier: 0,
};

export interface ResearchOrder {
  readonly id: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly limit: number;
  readonly stop: number;
  readonly target: number;
  /** Active from candles opening at or after this time (ms). */
  readonly activeFrom: number;
  readonly expiresAt: number;
  readonly signalId: string;
  readonly placedAt: string;
}

export interface ResearchPosition {
  readonly id: string;
  readonly order: ResearchOrder;
  readonly entry: number;
  readonly openedAt: number;
  readonly commission: number;
  /** Risk to the stop at the fill, account currency (for R). */
  readonly riskMoney: number;
}

export type ExitReason = 'STOP' | 'TARGET' | 'PROTECTIVE' | 'END_OF_DATA';

export interface ResearchFill {
  readonly position: ResearchPosition;
}

export interface ResearchClose {
  readonly position: ResearchPosition;
  readonly exit: number;
  readonly exitReason: ExitReason;
  readonly closedAt: number;
  /** Price P&L in the account currency (spread and slippage are in the prices). */
  readonly grossPnl: number;
  readonly netPnl: number;
}

export class ResearchBroker {
  private balance;
  private readonly orders = new Map<string, ResearchOrder>();
  private readonly positions = new Map<string, ResearchPosition>();
  private readonly pendingCloses = new Set<string>();
  private readonly last = new Map<string, { bid: number; ask: number }>();
  /** Latest uncrossed quote per symbol: the broker's own money conversions use it. */
  private readonly rates = new Map<string, { bid: number; ask: number }>();
  private readonly fillBar = new Set<string>();

  constructor(
    private readonly opts: {
      accountId: string;
      currency: string;
      startingBalance: number;
      specs: ReadonlyMap<string, InstrumentSpec>;
      costs: CostModel;
    },
  ) {
    this.balance = dec(opts.startingBalance);
  }

  private spec(symbol: string): InstrumentSpec {
    const s = this.opts.specs.get(symbol);
    if (!s) throw new Error(`no instrument spec for ${symbol}`);
    return s;
  }

  /**
   * Spec valued in the account currency with the latest uncrossed mids (throws if it cannot be).
   * A candle whose bid and ask series disagree (ask below bid) must not stop the accounting of a
   * trade already open, so the broker converts with the last uncrossed quote; the gate sees the
   * raw quote and refuses new risk on it.
   */
  valued(symbol: string): ValuedInstrumentSpec {
    const cur = this.opts.currency;
    const v = valueInAccountCurrency(this.spec(symbol), cur, (from) =>
      conversionRate(from, cur, this.opts.specs.keys(), (s) => this.rates.get(s) ?? null),
    );
    if (v.conversionError) throw new Error(v.conversionError);
    return v;
  }

  private mark(symbol: string, bid: number, ask: number): void {
    this.last.set(symbol, { bid, ask });
    if (bid > 0 && ask >= bid) this.rates.set(symbol, { bid, ask });
  }

  /** The candle as this cost model sees it (spread scaled around the mid). */
  adjust(bar: ResearchBar): { bid: Ohlc; ask: Ohlc } {
    const m = this.opts.costs.spreadMultiplier;
    if (m === 1) return { bid: bar.bid, ask: bar.ask };
    const side = (k: keyof Ohlc, sign: number) => {
      const mid = (bar.bid[k] + bar.ask[k]) / 2;
      const half = ((bar.ask[k] - bar.bid[k]) / 2) * m;
      return mid + sign * half;
    };
    const make = (sign: number): Ohlc => ({
      o: side('o', sign),
      h: side('h', sign),
      l: side('l', sign),
      c: side('c', sign),
    });
    return { bid: make(-1), ask: make(1) };
  }

  place(order: ResearchOrder): void {
    this.orders.set(order.id, order);
  }

  cancel(signalId: string): ResearchOrder[] {
    const out: ResearchOrder[] = [];
    for (const o of [...this.orders.values()]) {
      if (o.signalId !== signalId) continue;
      this.orders.delete(o.id);
      out.push(o);
    }
    return out;
  }

  queueClose(positionId: string): void {
    if (this.positions.has(positionId)) this.pendingCloses.add(positionId);
  }

  hasWorking(symbol: string): boolean {
    return [...this.orders.values()].some((o) => o.symbol === symbol);
  }

  quote(symbol: string): { bid: number; ask: number } | null {
    return this.last.get(symbol) ?? null;
  }

  /** One candle of one symbol: protective closes, fills, expiries, then stops and targets. */
  onBar(
    symbol: string,
    bar: ResearchBar,
  ): { filled: ResearchFill[]; closed: ResearchClose[]; missed: ResearchOrder[] } {
    const { bid, ask } = this.adjust(bar);
    const spec = this.spec(symbol);
    const tick = spec.tickSize;
    const slip = this.opts.costs.slippageTicks * tick;
    const closeMs = bar.t + 300_000;
    const filled: ResearchFill[] = [];
    const closed: ResearchClose[] = [];
    const missed: ResearchOrder[] = [];
    this.fillBar.clear();
    // Conversion rates first (USD/JPY values its own P&L with this candle).
    this.mark(symbol, bid.o, ask.o);

    for (const id of [...this.pendingCloses]) {
      const p = this.positions.get(id);
      if (!p || p.order.symbol !== symbol) continue;
      this.pendingCloses.delete(id);
      const long = p.order.direction === 'LONG';
      closed.push(this.settle(p, long ? bid.o - slip : ask.o + slip, 'PROTECTIVE', bar.t));
    }

    const through = this.opts.costs.limitThroughTicks * tick;
    for (const o of [...this.orders.values()]) {
      if (o.symbol !== symbol || bar.t < o.activeFrom) continue;
      if (bar.t >= o.expiresAt) {
        this.orders.delete(o.id);
        missed.push(o);
        continue;
      }
      const long = o.direction === 'LONG';
      const reached = long ? ask.l <= o.limit - through : bid.h >= o.limit + through;
      if (reached && closeMs <= o.expiresAt) {
        this.orders.delete(o.id);
        const p = this.open(o, bar.t);
        this.fillBar.add(p.id);
        filled.push({ position: p });
      } else if (closeMs >= o.expiresAt) {
        this.orders.delete(o.id);
        missed.push(o);
      }
    }

    for (const p of [...this.positions.values()]) {
      if (p.order.symbol !== symbol) continue;
      const long = p.order.direction === 'LONG';
      const inFill = this.fillBar.has(p.id);
      const { stop, target } = p.order;
      const stopHit = long ? bid.l <= stop : ask.h >= stop;
      const targetHit = !inFill && (long ? bid.h >= target : ask.l <= target);
      if (stopHit) {
        const gapped = !inFill && (long ? bid.o <= stop : ask.o >= stop);
        const base = gapped ? (long ? bid.o : ask.o) : stop;
        closed.push(this.settle(p, long ? base - slip : base + slip, 'STOP', closeMs));
      } else if (targetHit) {
        closed.push(this.settle(p, target, 'TARGET', closeMs));
      }
    }
    this.mark(symbol, bid.c, ask.c);
    return { filled, closed, missed };
  }

  private open(o: ResearchOrder, at: number): ResearchPosition {
    const v = this.valued(o.symbol);
    const vpp = dec(v.tickValue).div(v.tickSize);
    const commission = this.opts.costs.commission
      ? dec(v.costs.commissionPerUnitRoundTurn).mul(o.quantity)
      : dec(0);
    this.balance = this.balance.minus(commission);
    const p: ResearchPosition = {
      id: `pos-${o.id}`,
      order: o,
      entry: o.limit,
      openedAt: at,
      commission: toNum(commission, 2),
      riskMoney: toNum(dec(o.limit).minus(o.stop).abs().mul(vpp).mul(o.quantity), 2),
    };
    this.positions.set(p.id, p);
    return p;
  }

  private settle(p: ResearchPosition, exit: number, reason: ExitReason, at: number): ResearchClose {
    const v = this.valued(p.order.symbol);
    const gross = dec(exit)
      .minus(p.entry)
      .mul(directionSign(p.order.direction))
      .mul(v.tickValue)
      .div(v.tickSize)
      .mul(p.order.quantity);
    this.balance = this.balance.plus(gross);
    this.positions.delete(p.id);
    this.pendingCloses.delete(p.id);
    return {
      position: p,
      exit: toNum(dec(exit), 10),
      exitReason: reason,
      closedAt: at,
      grossPnl: money(gross),
      netPnl: money(gross.minus(p.commission)),
    };
  }

  /** Closes everything at the last known prices (end of the data). */
  closeAll(at: number): ResearchClose[] {
    this.orders.clear();
    return [...this.positions.values()].map((p) => {
      const q = this.last.get(p.order.symbol)!;
      return this.settle(p, p.order.direction === 'LONG' ? q.bid : q.ask, 'END_OF_DATA', at);
    });
  }

  snapshot(asOf: number): AccountSnapshot {
    let floating = dec(0);
    const open: OpenPosition[] = [...this.positions.values()].map((p) => {
      const q = this.last.get(p.order.symbol)!;
      const long = p.order.direction === 'LONG';
      const mark = long ? q.bid : q.ask;
      const v = this.valued(p.order.symbol);
      const pnl = dec(mark)
        .minus(p.entry)
        .mul(directionSign(p.order.direction))
        .mul(v.tickValue)
        .div(v.tickSize)
        .mul(p.order.quantity);
      floating = floating.plus(pnl);
      return {
        positionId: p.id,
        symbol: p.order.symbol,
        direction: p.order.direction,
        quantity: p.order.quantity,
        entryPrice: p.entry,
        currentPrice: toNum(dec(mark), 10),
        stopPrice: p.order.stop,
        targetPrice: p.order.target,
        unrealizedPnl: money(pnl),
        openedAt: new Date(p.openedAt).toISOString(),
      };
    });
    const working: WorkingOrder[] = [...this.orders.values()].map((o) => ({
      clientOrderId: o.id,
      symbol: o.symbol,
      direction: o.direction,
      quantity: o.quantity,
      limitPrice: o.limit,
      stopPrice: o.stop,
      targetPrice: o.target,
      placedAt: o.placedAt,
      expiresAt: new Date(o.expiresAt).toISOString(),
    }));
    return {
      accountId: this.opts.accountId,
      asOf: new Date(asOf).toISOString(),
      currency: this.opts.currency,
      balance: money(this.balance),
      equity: money(this.balance.plus(floating)),
      openPositions: open,
      pendingOrders: working.length,
      workingOrders: working,
    };
  }
}
