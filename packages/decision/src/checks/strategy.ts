import { dec, directionSign, modePolicy } from '@astra/core';
import { fail, pass, unknown, type GateCheck } from './check';

export const strategyEligibility: GateCheck = {
  id: 'strategy.eligibility',
  layer: 'STRATEGY',
  mandatory: true,
  description:
    'Strategy is active, enabled for the account and allowed on this instrument and direction.',
  evaluate: (i) => {
    const s = i.candidate.signal;
    const strat = i.strategy;
    if (!i.account) return fail(`account ${i.candidate.accountId} not found`);
    if (!strat) return fail(`strategy ${s.strategyId} not found`);
    const reasons: string[] = [];
    if (strat.status !== 'ACTIVE') reasons.push(`strategy status is ${strat.status}`);
    if (!i.account.strategies.includes(strat.id))
      reasons.push(`strategy ${strat.id} not enabled for account ${i.account.id}`);
    if (!strat.instruments.includes(s.symbol))
      reasons.push(`${s.symbol} not in strategy instruments`);
    if (!i.account.instruments.includes(s.symbol))
      reasons.push(`${s.symbol} not enabled for account ${i.account.id}`);
    if (strat.direction === 'LONG_ONLY' && s.direction !== 'LONG')
      reasons.push('strategy is LONG_ONLY');
    if (strat.direction === 'SHORT_ONLY' && s.direction !== 'SHORT')
      reasons.push('strategy is SHORT_ONLY');
    if (strat.ownership === 'TEMPLATE' && !modePolicy(i.mode).allowsUnverifiedConfig) {
      reasons.push(
        `TEMPLATE strategy cannot trade in ${i.mode}; the owner's strategy rules are required`,
      );
    }
    return reasons.length > 0
      ? fail(reasons)
      : pass(`strategy ${strat.id} v${strat.version} eligible`);
  },
};

export const strategySignal: GateCheck = {
  id: 'strategy.signal',
  layer: 'STRATEGY',
  mandatory: true,
  description: 'Signal is QUALIFIED, belongs to the strategy, and has not expired.',
  evaluate: (i) => {
    const s = i.candidate.signal;
    if (!i.strategy) return unknown('strategy not found');
    const reasons: string[] = [];
    if (s.setupState !== 'QUALIFIED') reasons.push(`setup state is ${s.setupState}, not QUALIFIED`);
    if (s.strategyId !== i.strategy.id) reasons.push('signal strategy mismatch');
    const now = Date.parse(i.now);
    const detected = Date.parse(s.detectedAt);
    const ageSec = (now - detected) / 1000;
    if (detected - now > i.policy.freshness.maxFutureSkewMs)
      reasons.push('signal detection time is in the future');
    if (ageSec > i.strategy.signalTtlSeconds) {
      reasons.push(
        `signal expired (${Math.round(ageSec)}s old, TTL ${i.strategy.signalTtlSeconds}s)`,
      );
    }
    return reasons.length > 0
      ? fail(reasons)
      : pass(`signal qualified, ${Math.max(0, Math.round(ageSec))}s old`);
  },
};

export const strategyLevels: GateCheck = {
  id: 'strategy.levels',
  layer: 'STRATEGY',
  mandatory: true,
  description: 'Stop and target are on the correct sides of entry.',
  evaluate: (i) => {
    const s = i.candidate.signal;
    const sign = directionSign(s.direction);
    const reasons: string[] = [];
    if (dec(s.entry).minus(s.stop).mul(sign).lte(0))
      reasons.push('stop is not on the protective side of entry');
    if (dec(s.target).minus(s.entry).mul(sign).lte(0))
      reasons.push('target is not on the profit side of entry');
    return reasons.length > 0 ? fail(reasons) : pass('stop and target placement valid');
  },
};
