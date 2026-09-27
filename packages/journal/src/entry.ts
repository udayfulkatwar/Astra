/**
 * One journal entry per closed trade: the plan ASTRA approved, what actually happened, and how
 * the two differ. Built only from records (decision, order, broker's closed trade, observed
 * excursions); anything not known is null — never estimated. Costs are the instrument's
 * configured commission (labelled as such), because the paper broker reports gross P&L.
 */
import { dec, directionSign, toNum, type Direction, type InstrumentSpec } from '@astra/core';
import type { ExcursionRecord } from './excursion';

export interface ClosedTradeInput {
  readonly positionId: string;
  readonly accountId: string;
  readonly clientOrderId: string | null;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  /** STOP, TARGET, MANUAL, PROTECTIVE (or a broker's own reason). */
  readonly exitReason: string;
  /** Gross realized P&L as reported by the broker. */
  readonly realizedPnl: number;
  readonly openedAt: string;
  readonly closedAt: string;
}

export interface OrderInput {
  readonly decisionId: string;
  readonly strategyId: string;
  readonly signalId: string;
  readonly mode: string;
  readonly plannedEntry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly quantity: number;
}

export interface DecisionInput {
  readonly decidedAt: string;
  readonly configHash: string;
  /** Worst-case loss the sizing approved (incl. cost allowances). */
  readonly plannedRisk: number | null;
}

export type TradeOutcome = 'WIN' | 'LOSS' | 'BREAKEVEN';

export interface Excursion {
  readonly price: number;
  readonly pnl: number;
  readonly r: number | null;
}

export interface JournalEntry {
  readonly tradeId: string;
  readonly accountId: string;
  /** ASTRA: placed by the gateway (plan known); EXTERNAL: no ASTRA order found. */
  readonly source: 'ASTRA' | 'EXTERNAL';
  readonly strategyId: string | null;
  readonly signalId: string | null;
  readonly decisionId: string | null;
  readonly mode: string | null;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly plan: {
    readonly entry: number;
    readonly stop: number;
    readonly target: number;
    readonly quantity: number;
    readonly rewardToRisk: number | null;
    readonly plannedRisk: number | null;
    readonly decidedAt: string | null;
    readonly configHash: string | null;
  } | null;
  readonly entry: {
    readonly price: number;
    readonly at: string;
    /** Ticks worse (+) or better (−) than the planned entry. */
    readonly slippageTicks: number | null;
  };
  readonly exit: {
    readonly price: number;
    readonly at: string;
    readonly reason: string;
    /** Ticks worse (+) than the planned stop/target level when exited there; else null. */
    readonly slippageTicks: number | null;
  };
  readonly durationSec: number;
  readonly result: {
    readonly grossPnl: number;
    readonly costs: number | null;
    readonly costsSource: 'INSTRUMENT_SPEC' | null;
    readonly netPnl: number | null;
    /** Risk at the actual entry to the planned stop (before costs). */
    readonly initialRisk: number | null;
    readonly rMultiple: number | null;
    readonly outcome: TradeOutcome;
  };
  readonly excursion: {
    readonly mfe: Excursion;
    readonly mae: Excursion;
    readonly coverage: 'FULL' | 'PARTIAL';
    readonly observedFrom: string;
  } | null;
  /** Exited at its own stop or target (as planned) vs manually / by protection. */
  readonly exitedAsPlanned: boolean;
}

export function buildJournalEntry(input: {
  readonly trade: ClosedTradeInput;
  readonly order: OrderInput | null;
  readonly decision: DecisionInput | null;
  readonly spec: InstrumentSpec | undefined;
  readonly excursion: ExcursionRecord | null;
}): JournalEntry {
  const { trade: t, order: o, decision: d, spec } = input;
  const sign = directionSign(t.direction);
  const perPoint = spec ? dec(spec.tickValue).div(spec.tickSize).mul(t.quantity) : null;
  const ticks = (diff: ReturnType<typeof dec>) => (spec ? toNum(diff.div(spec.tickSize), 2) : null);

  const gross = dec(t.realizedPnl);
  const costs = spec ? dec(spec.costs.commissionPerUnitRoundTurn).mul(t.quantity) : null;
  const net = costs ? gross.minus(costs) : null;
  const initialRisk =
    o && perPoint ? dec(t.entryPrice).minus(o.stopLoss).mul(sign).mul(perPoint) : null;
  const riskOk = initialRisk !== null && initialRisk.gt(0);
  const r = (pnl: ReturnType<typeof dec>) => (riskOk ? toNum(pnl.div(initialRisk), 2) : null);
  // Within one tick (for the whole quantity) of zero is a breakeven.
  const band = spec ? dec(spec.tickValue).mul(t.quantity) : dec(0);
  const basis = net ?? gross;
  const outcome: TradeOutcome = basis.abs().lte(band) ? 'BREAKEVEN' : basis.gt(0) ? 'WIN' : 'LOSS';

  let exitSlip: number | null = null;
  if (o && t.exitReason === 'STOP') exitSlip = ticks(dec(o.stopLoss).minus(t.exitPrice).mul(sign));
  if (o && t.exitReason === 'TARGET')
    exitSlip = ticks(dec(o.takeProfit).minus(t.exitPrice).mul(sign));

  const x = input.excursion;
  const excursionAt = (price: number): Excursion => {
    const pnl = perPoint ? dec(price).minus(t.entryPrice).mul(sign).mul(perPoint) : dec(0);
    return { price, pnl: toNum(pnl, 2), r: r(pnl) };
  };
  // The exit price itself was observed too: extend the excursion to it.
  const best = x
    ? sign > 0
      ? Math.max(x.bestPrice, t.exitPrice)
      : Math.min(x.bestPrice, t.exitPrice)
    : null;
  const worst = x
    ? sign > 0
      ? Math.min(x.worstPrice, t.exitPrice)
      : Math.max(x.worstPrice, t.exitPrice)
    : null;

  const plannedRR =
    o && dec(o.plannedEntry).minus(o.stopLoss).mul(sign).gt(0)
      ? toNum(
          dec(o.takeProfit)
            .minus(o.plannedEntry)
            .mul(sign)
            .div(dec(o.plannedEntry).minus(o.stopLoss).mul(sign)),
          2,
        )
      : null;

  return {
    tradeId: t.positionId,
    accountId: t.accountId,
    source: o ? 'ASTRA' : 'EXTERNAL',
    strategyId: o?.strategyId ?? null,
    signalId: o?.signalId ?? null,
    decisionId: o?.decisionId ?? null,
    mode: o?.mode ?? null,
    symbol: t.symbol,
    direction: t.direction,
    quantity: t.quantity,
    plan: o
      ? {
          entry: o.plannedEntry,
          stop: o.stopLoss,
          target: o.takeProfit,
          quantity: o.quantity,
          rewardToRisk: plannedRR,
          plannedRisk: d?.plannedRisk ?? null,
          decidedAt: d?.decidedAt ?? null,
          configHash: d?.configHash ?? null,
        }
      : null,
    entry: {
      price: t.entryPrice,
      at: t.openedAt,
      slippageTicks: o ? ticks(dec(t.entryPrice).minus(o.plannedEntry).mul(sign)) : null,
    },
    exit: { price: t.exitPrice, at: t.closedAt, reason: t.exitReason, slippageTicks: exitSlip },
    durationSec: Math.max(0, Math.round((Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 1000)),
    result: {
      grossPnl: toNum(gross, 2),
      costs: costs ? toNum(costs, 2) : null,
      costsSource: costs ? 'INSTRUMENT_SPEC' : null,
      netPnl: net ? toNum(net, 2) : null,
      initialRisk: riskOk ? toNum(initialRisk, 2) : null,
      rMultiple: net ? r(net) : null,
      outcome,
    },
    excursion:
      x && best !== null && worst !== null
        ? {
            mfe: excursionAt(best),
            mae: excursionAt(worst),
            coverage: x.coverage,
            observedFrom: x.observedFrom,
          }
        : null,
    exitedAsPlanned: o !== null && (t.exitReason === 'STOP' || t.exitReason === 'TARGET'),
  };
}
