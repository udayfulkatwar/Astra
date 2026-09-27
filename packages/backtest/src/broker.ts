/**
 * Bar-driven simulated broker for backtests. Conservative by construction:
 * - Orders decided at a bar's close fill at the NEXT bar's open (never at the price that
 *   triggered them): entries at the ask (LONG) / bid (SHORT) plus adverse slippage.
 * - Bars are mids; the exit side is bid (LONG) / ask (SHORT), `spreadTicks / 2` away.
 * - Intrabar: if a bar reaches both the stop and the target, the STOP is assumed first. A stop
 *   gapped through at the open fills at the open; stops pay slippage; targets fill at the target
 *   (never better). Protective closes fill at the next open with slippage.
 * - Commission is charged in full at entry (like the paper broker); P&L reported gross.
 */
import {
  dec,
  directionSign,
  money,
  toNum,
  type AccountSnapshot,
  type Dec,
  type Direction,
  type InstrumentSpec,
  type OpenPosition,
} from '@astra/core';
import type { Bar } from '@astra/market-data';

export interface FillModel {
  readonly spreadTicks: number;
  readonly slippageTicks: number;
}

export interface BacktestPosition {
  readonly positionId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly targetPrice: number;
  readonly openedAt: string;
}

export interface BacktestClosedTrade {
  readonly positionId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly exitReason: 'STOP' | 'TARGET' | 'PROTECTIVE';
  readonly realizedPnl: number;
  readonly openedAt: string;
  readonly closedAt: string;
}

export interface EntryOrder {
  readonly clientOrderId: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly stop: number;
  readonly target: number;
  /** The approval's expiry: an entry whose next bar opens later is dropped, never filled. */
  readonly expiresAt: string;
}

export interface BarOutcome {
  /** Entries whose approval expired before the next bar opened (e.g. a data gap). */
  readonly expired: EntryOrder[];
  readonly opened: BacktestPosition[];
  readonly closed: BacktestClosedTrade[];
  /** Positions still open after the bar, with the part of the bar they were exposed to. */
  readonly exposed: { position: BacktestPosition; bestExit: number; worstExit: number }[];
}

export class BacktestBroker {
  private balance: Dec;
  private readonly open = new Map<string, BacktestPosition>();
  private pendingEntries: EntryOrder[] = [];
  private readonly pendingCloses = new Set<string>();
  private seq = 0;

  constructor(
    private readonly opts: {
      accountId: string;
      currency: string;
      startingBalance: number;
      spec: InstrumentSpec;
      model: FillModel;
    },
  ) {
    this.balance = dec(opts.startingBalance);
  }

  queueEntry(order: EntryOrder): void {
    this.pendingEntries.push(order);
  }

  queueClose(positionId: string): void {
    if (this.open.has(positionId)) this.pendingCloses.add(positionId);
  }

  hasPendingEntry(): boolean {
    return this.pendingEntries.length > 0;
  }

  isClosePending(positionId: string): boolean {
    return this.pendingCloses.has(positionId);
  }

  positions(): BacktestPosition[] {
    return [...this.open.values()];
  }

  private get half(): Dec {
    return dec(this.opts.model.spreadTicks).mul(this.opts.spec.tickSize).div(2);
  }

  private get slip(): Dec {
    return dec(this.opts.model.slippageTicks).mul(this.opts.spec.tickSize);
  }

  /** Exit-side price (bid for LONG, ask for SHORT) of a mid price. */
  private exitSide(direction: Direction, mid: number): Dec {
    return direction === 'LONG' ? dec(mid).minus(this.half) : dec(mid).plus(this.half);
  }

  onBar(bar: Bar): BarOutcome {
    const closed: BacktestClosedTrade[] = [];
    const opened: BacktestPosition[] = [];
    const expired: EntryOrder[] = [];

    // 1. Orders decided at the previous close execute at this open: closes first, then entries.
    for (const id of this.pendingCloses) {
      const p = this.open.get(id);
      if (!p) continue;
      const sign = directionSign(p.direction);
      const px = this.exitSide(p.direction, bar.open).minus(this.slip.mul(sign));
      closed.push(this.settle(p, px, 'PROTECTIVE', bar.openTime));
    }
    this.pendingCloses.clear();
    for (const o of this.pendingEntries) {
      if (Date.parse(bar.openTime) > Date.parse(o.expiresAt)) {
        expired.push(o);
        continue;
      }
      const sign = directionSign(o.direction);
      const px = (
        o.direction === 'LONG' ? dec(bar.open).plus(this.half) : dec(bar.open).minus(this.half)
      ).plus(this.slip.mul(sign));
      this.balance = this.balance.minus(
        dec(this.opts.spec.costs.commissionPerUnitRoundTurn).mul(o.quantity),
      );
      const p: BacktestPosition = {
        positionId: `bt-pos-${++this.seq}`,
        clientOrderId: o.clientOrderId,
        symbol: bar.symbol,
        direction: o.direction,
        quantity: o.quantity,
        entryPrice: toNum(px, 10),
        stopPrice: o.stop,
        targetPrice: o.target,
        openedAt: bar.openTime,
      };
      this.open.set(p.positionId, p);
      opened.push(p);
    }
    this.pendingEntries = [];

    // 2. Intrabar exits (stop before target when both are reached).
    const exposed: BarOutcome['exposed'] = [];
    for (const p of [...this.open.values()]) {
      const long = p.direction === 'LONG';
      const sign = directionSign(p.direction);
      const openX = this.exitSide(p.direction, bar.open);
      const lowX = this.exitSide(p.direction, long ? bar.low : bar.high); // adverse extreme
      const highX = this.exitSide(p.direction, long ? bar.high : bar.low); // favourable extreme
      const stopHit = long ? lowX.lte(p.stopPrice) : lowX.gte(p.stopPrice);
      const targetHit = long ? highX.gte(p.targetPrice) : highX.lte(p.targetPrice);
      if (stopHit) {
        const gapped = long ? openX.lte(p.stopPrice) : openX.gte(p.stopPrice);
        const base = gapped ? openX : dec(p.stopPrice);
        closed.push(this.settle(p, base.minus(this.slip.mul(sign)), 'STOP', bar.closeTime));
      } else if (targetHit) {
        closed.push(this.settle(p, dec(p.targetPrice), 'TARGET', bar.closeTime));
      } else {
        exposed.push({ position: p, bestExit: toNum(highX, 10), worstExit: toNum(lowX, 10) });
      }
    }
    return { expired, opened, closed, exposed };
  }

  /** Account snapshot marked at the bar close (exit side). */
  snapshot(asOf: string, closeMid: number): AccountSnapshot {
    const spec = this.opts.spec;
    let floating = dec(0);
    const positions: OpenPosition[] = [...this.open.values()].map((p) => {
      const px = this.exitSide(p.direction, closeMid);
      const pnl = px
        .minus(p.entryPrice)
        .mul(directionSign(p.direction))
        .mul(spec.tickValue)
        .div(spec.tickSize)
        .mul(p.quantity);
      floating = floating.plus(pnl);
      return {
        positionId: p.positionId,
        symbol: p.symbol,
        direction: p.direction,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
        currentPrice: toNum(px, 10),
        stopPrice: p.stopPrice,
        targetPrice: p.targetPrice,
        unrealizedPnl: money(pnl),
        openedAt: p.openedAt,
      };
    });
    return {
      accountId: this.opts.accountId,
      asOf,
      currency: this.opts.currency,
      balance: money(this.balance),
      equity: money(this.balance.plus(floating)),
      openPositions: positions,
      pendingOrders: this.pendingEntries.length,
    };
  }

  private settle(
    p: BacktestPosition,
    exit: Dec,
    reason: BacktestClosedTrade['exitReason'],
    at: string,
  ): BacktestClosedTrade {
    const spec = this.opts.spec;
    const pnl = exit
      .minus(p.entryPrice)
      .mul(directionSign(p.direction))
      .mul(spec.tickValue)
      .div(spec.tickSize)
      .mul(p.quantity);
    this.balance = this.balance.plus(pnl);
    this.open.delete(p.positionId);
    return {
      positionId: p.positionId,
      clientOrderId: p.clientOrderId,
      symbol: p.symbol,
      direction: p.direction,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      exitPrice: toNum(exit, 10),
      exitReason: reason,
      realizedPnl: money(pnl),
      openedAt: p.openedAt,
      closedAt: at,
    };
  }
}
