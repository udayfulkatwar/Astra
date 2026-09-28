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
  sessions: () => [],
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

describe('assembleDecisionInputs — account-currency valuation', () => {
  const USDJPY = {
    ...NQ,
    symbol: 'USDJPY',
    assetClass: 'FOREX' as const,
    quantityUnit: 'LOTS' as const,
    quoteCurrency: 'JPY',
    tickSize: 0.001,
    tickValue: 100,
    quantityStep: 0.01,
    minQuantity: 0.01,
    costs: { commissionPerUnitRoundTurn: 7, commissionCurrency: 'USD', slippageAllowanceTicks: 5 },
  };
  const fxConfig = {
    ...config,
    account: (id: string) =>
      id === account.id ? { ...account, instruments: ['NQ', 'USDJPY'] } : undefined,
    instrument: (s: string) => (s === 'NQ' ? NQ : s === 'USDJPY' ? USDJPY : undefined),
    instrumentSymbols: () => ['NQ', 'USDJPY'],
  };
  const run = (data: DecisionDataPorts) =>
    assembleDecisionInputs({
      candidate: base.candidate,
      config: fxConfig,
      data,
      state,
      clock: new ManualClock(NOW),
      timeoutMs: 50,
      decisionId: 'dec_fx',
    });
  const meta = { source: 'test', sourceKind: 'LIVE' as const, asOf: NOW };

  it('values a JPY-quoted spec with a fresh USDJPY quote and freezes the rate in the record', async () => {
    const asked: string[] = [];
    const inputs = await run(
      ports({
        quote: (symbol) => {
          asked.push(symbol);
          return Promise.resolve(
            symbol === 'USDJPY'
              ? observed({ symbol, bid: 149.99, ask: 150.01, asOf: NOW }, meta)
              : base.quote,
          );
        },
      }),
    );
    expect(asked).toEqual(['NQ', 'USDJPY']);
    expect(inputs.instruments.NQ).toBe(NQ); // already USD
    expect(inputs.instruments.USDJPY).toMatchObject({
      quoteCurrency: 'USD',
      conversion: { from: 'JPY', to: 'USD', via: 'USDJPY' },
    });
    expect(inputs.instruments.USDJPY!.tickValue).toBeCloseTo(0.6667, 4);
    expect(new DecisionEngine().evaluate(inputs).status).toBe('APPROVED');
  });

  it('a stale rate is no rate: the spec carries the error instead of a guessed value', async () => {
    const stale = '2026-09-28T13:00:00.000Z';
    const inputs = await run(
      ports({
        quote: (symbol) =>
          Promise.resolve(
            symbol === 'USDJPY'
              ? observed({ symbol, bid: 150, ask: 150, asOf: stale }, { ...meta, asOf: stale })
              : base.quote,
          ),
      }),
    );
    expect(inputs.instruments.USDJPY).toMatchObject({
      quoteCurrency: 'JPY',
      conversionError: expect.stringMatching(/no fresh JPY→USD rate/),
    });
  });
});
