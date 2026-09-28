/**
 * A complete setup as an ASTRA signal: a LIMIT entry at the FVG midpoint that expires with the
 * setup's entry window. The gate decides everything else (size, news, limits, prop-firm rules).
 */
import type { Signal } from '@astra/core';
import type { LsfvgSetup } from './engine';

export function toSignal(setup: LsfvgSetup, strategyId: string): Signal {
  return {
    id: `${strategyId}:${setup.id}`,
    strategyId,
    symbol: setup.symbol,
    direction: setup.direction,
    setupState: 'QUALIFIED',
    entryType: 'LIMIT',
    entry: setup.entry,
    stop: setup.stop,
    target: setup.target,
    timeframe: 'M15',
    detectedAt: setup.detectedAt,
    expiresAt: setup.expiresAt,
    rationale: [...setup.rationale],
    features: {
      engine: 'lsfvg-v1',
      model: setup.model,
      h1Bias: setup.h1Bias.bias,
      liquidity: setup.liquidity.name,
      liquidityPrice: setup.liquidity.price,
      liquidityStrong: setup.liquidity.strong,
      sweepExtreme: setup.sweep.extreme,
      structure: setup.structure.kind,
      displacementBodyToRange: setup.displacement.bodyToRange,
      displacementBodyToAtr: setup.displacement.bodyToAtr,
      fvgLow: setup.fvg.low,
      fvgHigh: setup.fvg.high,
      targetSource: setup.targetSource,
      rewardToRisk: setup.rewardToRisk,
      score: setup.score.total,
    },
  };
}
