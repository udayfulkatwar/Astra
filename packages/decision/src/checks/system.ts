import { modePolicy } from '@astra/core';
import { fail, pass, type GateCheck } from './check';

export const systemMode: GateCheck = {
  id: 'system.mode',
  layer: 'SYSTEM',
  mandatory: true,
  description: 'The global trading mode permits new trades.',
  evaluate: (i) =>
    modePolicy(i.mode).newTradesAllowed
      ? pass(`mode ${i.mode} permits new trades`)
      : fail(`mode ${i.mode} does not permit new trades`),
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
