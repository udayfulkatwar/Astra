import { modePolicy } from '@astra/core';
import { fail, pass, type GateCheck } from './check';

export const systemMode: GateCheck = {
  id: 'system.mode',
  layer: 'SYSTEM',
  mandatory: true,
  description: 'The global trading mode permits new trades.',
  evaluate: (i) => {
    const simulator = i.environment === 'BACKTEST_SIMULATOR';
    // The backtest simulator only ever decides in BACKTEST mode, and BACKTEST mode only ever
    // "trades" inside the simulator (orders are never transmitted there).
    if (simulator || i.mode === 'BACKTEST') {
      return simulator && i.mode === 'BACKTEST'
        ? pass('BACKTEST mode inside the backtest simulator (nothing is transmitted)')
        : fail(
            simulator
              ? `the backtest simulator only decides in BACKTEST mode (not ${i.mode})`
              : 'mode BACKTEST does not permit new trades outside the backtest simulator',
          );
    }
    return modePolicy(i.mode).newTradesAllowed
      ? pass(`mode ${i.mode} permits new trades`)
      : fail(`mode ${i.mode} does not permit new trades`);
  },
};

export const systemKillSwitches: GateCheck = {
  id: 'system.kill-switches',
  layer: 'SYSTEM',
  mandatory: true,
  description: 'No kill switch applies to this account, strategy or instrument.',
  evaluate: (i) =>
    i.killSwitches.blocked
      ? fail(i.killSwitches.reasons, { loaded: i.killSwitches.loaded })
      : pass('no applicable kill switch is active'),
};

export const systemComponentHealth: GateCheck = {
  id: 'system.component-health',
  layer: 'SYSTEM',
  mandatory: true,
  description: 'Every required component is healthy.',
  evaluate: (i) => {
    const acceptable = new Set(
      i.policy.allowDegradedComponents ? ['ONLINE', 'DEGRADED'] : ['ONLINE'],
    );
    const byId = new Map(i.componentHealth.map((h) => [h.component, h]));
    const problems = i.policy.requiredComponents.flatMap((c) => {
      const h = byId.get(c);
      if (!h) return [`${c} health not reported`];
      return acceptable.has(h.status) ? [] : [`${c} is ${h.status}: ${h.detail}`];
    });
    return problems.length > 0
      ? fail(problems)
      : pass(`required components healthy: ${i.policy.requiredComponents.join(', ') || 'none'}`);
  },
};
