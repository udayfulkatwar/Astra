import { ManualClock, notObserved, observed, type Observed } from '@astra/core';
import { describe, expect, it } from 'vitest';
import {
  assembleDecisionInputs,
  type DecisionDataPorts,
  type DecisionStatePorts,
} from '../src/assembler';
import { DecisionEngine } from '../src/engine';
import {
  NQ,
  NOW,
  account,
  healthyComponents,
  loadedKillSwitches,
  makeInputs,
  policy,
  profile,
  riskPolicy,
  strategy,
} from './fixtures';

const base = makeInputs();
const config = {
  configHash: 'sha256:test',
  policy,
  account: (id: string) => (id === account.id ? account : undefined),
  profile: (id: string) => (id === profile.id ? profile : undefined),
  riskPolicy: (id: string) => (id === riskPolicy.id ? riskPolicy : undefined),
  strategy: (id: string) => (id === strategy.id ? strategy : undefined),
  instrument: (s: string) => (s === 'NQ' ? NQ : undefined),
};
const state: DecisionStatePorts = {
  mode: () => 'PAPER',
  killSwitches: (ctx) => loadedKillSwitches().evaluate(ctx),
  componentHealth: () => healthyComponents(),
  execution: () => base.execution,
  liveTradingEnvironmentAuthorized: () => false,
};

function ports(overrides: Partial<DecisionDataPorts> = {}): DecisionDataPorts {
  return {
    quote: () => Promise.resolve(base.quote),
    accountSnapshot: () => Promise.resolve(base.accountSnapshot),
    tracking: () => Promise.resolve(base.tracking),
    activity: () => Promise.resolve(base.activity),
    calendar: () => Promise.resolve(base.calendar),
    newsRisk: () => Promise.resolve(notObserved('UNAVAILABLE', 'none', 'news')),
    aiAnalysis: () => Promise.resolve(notObserved('UNAVAILABLE', 'none', 'ai')),
    duplicates: () => Promise.resolve(base.duplicates),
    ...overrides,
  };
}

const assemble = (data: DecisionDataPorts) =>
  assembleDecisionInputs({
    candidate: base.candidate,
    config,
    data,
    state,
    clock: new ManualClock(NOW),
    timeoutMs: 50,
    decisionId: 'dec_x',
  });

describe('assembleDecisionInputs', () => {
  it('assembles inputs that approve when every provider answers', async () => {
    const inputs = await assemble(ports());
    expect(inputs.account?.id).toBe('acct-a');
    expect(inputs.instruments).toHaveProperty('NQ');
    expect(new DecisionEngine().evaluate(inputs).status).toBe('APPROVED');
  });

  it('a hanging provider becomes TIMEOUT and the decision is NO TRADE', async () => {
    const inputs = await assemble(
      ports({ quote: () => new Promise<Observed<never>>(() => undefined) }),
    );
    expect(inputs.quote.status).toBe('TIMEOUT');
    expect(new DecisionEngine().evaluate(inputs).status).toBe('REJECTED');
  });

  it('a throwing provider becomes ERROR and the decision is NO TRADE', async () => {
    const inputs = await assemble(ports({ calendar: () => Promise.reject(new Error('503')) }));
    expect(inputs.calendar).toMatchObject({ status: 'ERROR', reason: '503' });
    expect(new DecisionEngine().evaluate(inputs).status).toBe('REJECTED');
  });

  it('requests a calendar window covering the widest blackout', async () => {
    let requested: [Date, Date] | null = null;
    await assemble(
      ports({
        calendar: (from, to) => {
          requested = [from, to];
          return Promise.resolve(base.calendar);
        },
      }),
    );
    expect(requested![0].toISOString()).toBe('2026-09-28T13:45:00.000Z');
    expect(requested![1].toISOString()).toBe('2026-09-28T14:15:00.000Z');
  });

  it('does not call the AI provider when the strategy does not require AI', async () => {
    let called = false;
    const inputs = await assemble(
      ports({
        aiAnalysis: () => {
          called = true;
          return Promise.resolve(
            observed({} as never, { source: 'ai', sourceKind: 'LIVE', asOf: NOW }),
          );
        },
      }),
    );
    expect(called).toBe(false);
    expect(inputs.aiAnalysis.status).toBe('UNAVAILABLE');
  });
});
