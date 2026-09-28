/**
 * Strategy port for the backtest, and ONE clearly-marked TEMPLATE strategy that exists only to
 * exercise the engine. It is not the owner's strategy and not a recommendation: its ownership
 * is TEMPLATE, so the gate refuses it in LIVE (ADR-0016).
 *
 * A strategy only ever sees higher-timeframe bars that have CLOSED, and the structure analysed
 * from them; it proposes a signal, and the real decision gate decides.
 */
import { dec, toNum, type Direction, type StrategyDefinition } from '@astra/core';
import type { Bar, Timeframe } from '@astra/market-data';
import type { MarketStructure } from '@astra/market-structure';
import type { BacktestConfig } from './config';

export interface StrategyContext {
  /** Close time of the bar just completed (the decision moment). */
  readonly now: string;
  readonly symbol: string;
  readonly tickSize: number;
  /** Modelled spread (the executable entry is the close ± half of it). */
  readonly spreadTicks: number;
  /** Completed bars of the strategy timeframe, oldest → newest (bounded window). */
  readonly bars: readonly Bar[];
  readonly structure: MarketStructure;
  /** No open position and no entry waiting to fill. */
  readonly flat: boolean;
}

export interface SignalProposal {
  readonly direction: Direction;
  /** Expected executable price (ask for LONG, bid for SHORT). */
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  readonly rationale: string[];
  readonly features: Record<string, unknown>;
}

export type StrategyOutput =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'SKIP'; readonly reason: string }
  | { readonly kind: 'SIGNAL'; readonly signal: SignalProposal };

export interface BacktestStrategy {
  readonly definition: StrategyDefinition;
  readonly timeframe: Exclude<Timeframe, 'M1'>;
  onBar(ctx: StrategyContext): StrategyOutput;
}

const NONE: StrategyOutput = { kind: 'NONE' };

/**
 * TEMPLATE "structure breakout": when the bar that just closed broke structure (BOS or CHoCH),
 * enter in the break's direction with the stop at the opposite swing (the last swing low for a
 * bullish break, the last swing high for a bearish one) and the target at `rewardToRisk` × the
 * risk. Setups with a stop closer than `minStopTicks` are skipped.
 */
export function structureBreakoutTemplate(
  symbol: string,
  params: BacktestConfig['strategy'],
): BacktestStrategy {
  const definition: StrategyDefinition = {
    id: params.id,
    name: 'Structure breakout (TEMPLATE — engine test only)',
    version: 1,
    ownership: 'TEMPLATE',
    status: 'ACTIVE',
    description:
      'Placeholder used only to exercise the backtest engine. Not the owner’s strategy and not a recommendation.',
    instruments: [symbol],
    timeframes: [params.timeframe],
    direction: 'BOTH',
    minRewardToRisk: Math.min(1.5, params.rewardToRisk),
    signalTtlSeconds: 300,
    requiresAiAnalysis: false,
    rules: {
      entry: 'close beyond the last swing (BOS or CHoCH) on the closed bar',
      stop: 'opposite swing',
      target: `${params.rewardToRisk} R`,
      minStopTicks: params.minStopTicks,
    },
  };

  return {
    definition,
    timeframe: params.timeframe,
    onBar(ctx) {
      const s = ctx.structure;
      const last = ctx.bars.at(-1);
      if (!ctx.flat || !last || !s.sufficient || !s.lastBreak) return NONE;
      const brk = s.lastBreak;
      if (brk.at !== last.closeTime) return NONE; // only a break on the bar that just closed

      const long = brk.direction === 'BULLISH';
      const swing = long ? s.lastSwingLow : s.lastSwingHigh;
      if (!swing)
        return { kind: 'SKIP', reason: `no ${long ? 'swing low' : 'swing high'} for the stop` };

      const tick = dec(ctx.tickSize);
      const half = dec(ctx.spreadTicks).mul(tick).div(2);
      const entry = long ? dec(last.close).plus(half) : dec(last.close).minus(half);
      const stop = dec(swing.price);
      const risk = long ? entry.minus(stop) : stop.minus(entry);
      if (risk.lt(tick.mul(params.minStopTicks))) {
        return {
          kind: 'SKIP',
          reason: `stop ${toNum(risk.div(tick), 1)} ticks away (minimum ${params.minStopTicks})`,
        };
      }
      // Target on the tick grid, rounded toward the entry (never a larger reward than planned).
      const raw = long
        ? entry.plus(risk.mul(params.rewardToRisk))
        : entry.minus(risk.mul(params.rewardToRisk));
      const ticks = raw.div(tick);
      const target = (long ? ticks.floor() : ticks.ceil()).mul(tick);

      return {
        kind: 'SIGNAL',
        signal: {
          direction: long ? 'LONG' : 'SHORT',
          entry: toNum(entry, 10),
          stop: toNum(stop, 10),
          target: toNum(target, 10),
          rationale: [
            `TEMPLATE strategy: ${brk.type} ${brk.direction.toLowerCase()} on ${params.timeframe} (close ${brk.close} beyond ${brk.level})`,
            `stop at the last swing ${long ? 'low' : 'high'} ${swing.price}; target ${params.rewardToRisk} R`,
          ],
          features: {
            setup: `${brk.type} ${long ? 'long' : 'short'}`,
            breakType: brk.type,
            breakLevel: brk.level,
            trendBefore: brk.from,
            riskTicks: toNum(risk.div(tick), 2),
          },
        },
      };
    },
  };
}
