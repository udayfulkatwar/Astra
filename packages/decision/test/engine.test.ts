import { notObserved, observed, type NonOkStatus } from '@astra/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STANDARD_CHECKS } from '../src/checks';
import { DecisionEngine } from '../src/engine';
import { GatePipeline } from '../src/pipeline';
import { decideAndRecord } from '../src/record';
import type { DecisionInputs, TradeDecision } from '../src/types';
import {
  NQ,
  NOW,
  account,
  healthyComponents,
  loadedKillSwitches,
  makeInputs,
  profile,
  riskPolicy,
  strategy,
} from './fixtures';

const engine = new DecisionEngine({ newApprovalId: () => 'apr_test' });
const decide = (inputs: DecisionInputs) => engine.evaluate(inputs);
const failing = (d: TradeDecision) =>
  d.checks.filter((c) => c.verdict !== 'PASS').map((c) => c.checkId);
const NON_OK: NonOkStatus[] = ['STALE', 'UNKNOWN', 'UNAVAILABLE', 'ERROR', 'TIMEOUT', 'INVALID'];

describe('DecisionEngine — baseline', () => {
  it('approves a fully valid candidate', () => {
    const d = decide(makeInputs());
    expect(failing(d)).toEqual([]);
    expect(d.status).toBe('APPROVED');
    expect(d.orderPlan).toMatchObject({
      symbol: 'NQ',
      direction: 'LONG',
      entry: 20_000,
      stop: 19_990,
      target: 20_030,
      quantity: 1,
    });
    expect(d.approval).toEqual({ approvalId: 'apr_test', expiresAt: '2026-09-28T14:00:30.000Z' });
    expect(d.sizing?.dollarRisk).toBe(209);
    expect(d.explanation.what).toMatch(/^APPROVED LONG 1 NQ/);
  });

  it('covers every gate layer with at least one check', () => {
    expect(new GatePipeline(STANDARD_CHECKS).missingLayers()).toEqual([]);
  });
});

describe('DecisionEngine — fail closed on any non-OK data (spec §10, §49)', () => {
  const cases: [string, keyof DecisionInputs][] = [
    ['quote', 'quote'],
    ['account snapshot', 'accountSnapshot'],
    ['account tracking', 'tracking'],
    ['account activity', 'activity'],
    ['economic calendar', 'calendar'],
    ['duplicate check', 'duplicates'],
  ];
  for (const [label, key] of cases) {
    for (const status of NON_OK) {
      it(`${label} ${status} → NO TRADE`, () => {
        const d = decide(makeInputs({ [key]: notObserved(status, 'test', 'test') }));
        expect(d.status).toBe('REJECTED');
        expect(d.approval).toBeNull();
        expect(d.orderPlan).toBeNull();
      });
    }
  }

  it('rejects a quote that is too old (STALE by age)', () => {
    const d = decide(
      makeInputs({
        quote: observed(
          { symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf: '2026-09-28T13:59:50.000Z' },
          { source: 't', sourceKind: 'SIMULATED', asOf: '2026-09-28T13:59:50.000Z' },
        ),
      }),
    );
    expect(d.status).toBe('REJECTED');
    expect(failing(d)).toContain('data.quote');
  });

  it('rejects a timestamp from the future (clock skew)', () => {
    const d = decide(
      makeInputs({
        quote: observed(
          { symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf: '2026-09-28T14:00:10.000Z' },
          { source: 't', sourceKind: 'SIMULATED', asOf: '2026-09-28T14:00:10.000Z' },
        ),
      }),
    );
    expect(d.status).toBe('REJECTED');
  });

  it('property: approval implies every observed input is OK', () => {
    const statusArb = fc.constantFrom<'OK' | NonOkStatus>('OK', ...NON_OK);
    fc.assert(
      fc.property(
        statusArb,
        statusArb,
        statusArb,
        statusArb,
        statusArb,
        statusArb,
        (q, s, t, a, c, dup) => {
          const base = makeInputs();
          const pick = <K extends keyof DecisionInputs>(key: K, st: 'OK' | NonOkStatus) =>
            (st === 'OK' ? base[key] : notObserved(st, 'generated', 'test')) as DecisionInputs[K];
          const d = decide({
            ...base,
            quote: pick('quote', q),
            accountSnapshot: pick('accountSnapshot', s),
            tracking: pick('tracking', t),
            activity: pick('activity', a),
            calendar: pick('calendar', c),
            duplicates: pick('duplicates', dup),
          });
          const allOk = [q, s, t, a, c, dup].every((x) => x === 'OK');
          expect(d.status === 'APPROVED').toBe(allOk);
        },
      ),
    );
  });
});

describe('DecisionEngine — system layer', () => {
  it.each(['HALTED', 'BACKTEST'] as const)('mode %s → NO TRADE', (mode) => {
    const d = decide(makeInputs({ mode }));
    expect(d.status).toBe('REJECTED');
    expect(failing(d)).toContain('system.mode');
  });

  it('BACKTEST passes the mode check only inside the backtest simulator, which needs BACKTEST', () => {
    const mode = (i: DecisionInputs) => decide(i).checks.find((c) => c.checkId === 'system.mode')!;
    expect(mode(makeInputs({ mode: 'BACKTEST', environment: 'BACKTEST_SIMULATOR' }))).toMatchObject(
      {
        verdict: 'PASS',
      },
    );
    expect(mode(makeInputs({ mode: 'BACKTEST', environment: 'REALTIME' })).verdict).toBe('FAIL');
    expect(mode(makeInputs({ mode: 'PAPER', environment: 'BACKTEST_SIMULATOR' }))).toMatchObject({
      verdict: 'FAIL',
      reasons: ['the backtest simulator only decides in BACKTEST mode (not PAPER)'],
    });
    expect(mode(makeInputs({ mode: 'PAPER' })).verdict).toBe('PASS');
  });

  it('kill-switch state not loaded → NO TRADE', () => {
    const d = decide(
      makeInputs({
        killSwitches: { blocked: true, loaded: false, blocking: [], reasons: ['not loaded'] },
      }),
    );
    expect(failing(d)).toContain('system.kill-switches');
  });

  it('account kill switch → NO TRADE', () => {
    const r = loadedKillSwitches();
    r.activate({
      scope: 'ACCOUNT',
      target: 'acct-a',
      reason: 'owner pause',
      actor: { type: 'HUMAN', id: 'owner' },
    });
    const d = decide(
      makeInputs({
        killSwitches: r.evaluate({
          accountId: 'acct-a',
          strategyId: 'test-strategy',
          symbol: 'NQ',
        }),
      }),
    );
    expect(d.status).toBe('REJECTED');
    expect(d.reasons.join()).toMatch(/owner pause/);
  });

  it('automation (n8n) UNKNOWN → NO TRADE', () => {
    const health = healthyComponents().map((h) =>
      h.component === 'AUTOMATION'
        ? { ...h, status: 'UNKNOWN' as const, detail: 'heartbeat stale' }
        : h,
    );
    const d = decide(makeInputs({ componentHealth: health }));
    expect(failing(d)).toEqual(['system.component-health']);
  });

  it('DEGRADED component blocks unless policy allows degraded', () => {
    const health = healthyComponents().map((h) =>
      h.component === 'MARKET_DATA' ? { ...h, status: 'DEGRADED' as const } : h,
    );
    expect(decide(makeInputs({ componentHealth: health })).status).toBe('REJECTED');
    const lenient = makeInputs({ componentHealth: health });
    expect(
      decide({ ...lenient, policy: { ...lenient.policy, allowDegradedComponents: true } }).status,
    ).toBe('APPROVED');
  });
});

describe('DecisionEngine — mode-specific safety', () => {
  it('SIMULATED data is rejected in SHADOW', () => {
    const d = decide(makeInputs({ mode: 'SHADOW' }));
    expect(failing(d)).toContain('data.source-kinds');
  });

  it('SHADOW with live data approves (orders are never transmitted in SHADOW)', () => {
    const base = makeInputs({ mode: 'SHADOW' }, 'LIVE');
    const d = decide({
      ...base,
      execution: {
        adapterId: null,
        adapterKind: null,
        health: 'UNKNOWN',
        reconciled: false,
        supportedEntryTypes: ['MARKET'],
      },
    });
    expect(failing(d)).toEqual([]);
    expect(d.status).toBe('APPROVED');
  });

  it('LIVE requires verified config, USER strategy/policy, authorization and a LIVE adapter', () => {
    const d = decide(makeInputs({ mode: 'LIVE' }, 'LIVE'));
    expect(d.status).toBe('REJECTED');
    expect(failing(d)).toEqual(
      expect.arrayContaining([
        'strategy.eligibility',
        'prop-firm.config-verification',
        'execution.readiness',
        'execution.live-authorization',
      ]),
    );
  });

  it('LIVE approves only when every live factor is satisfied', () => {
    const verified = {
      status: 'USER_VERIFIED' as const,
      verifiedBy: 'owner',
      verifiedAt: '2026-09-01',
      source: 'firm terms',
    };
    const d = decide(
      makeInputs(
        {
          mode: 'LIVE',
          profile: { ...profile, verification: verified },
          instrument: { ...NQ, verification: verified },
          instruments: { NQ: { ...NQ, verification: verified } },
          riskPolicy: { ...riskPolicy, ownership: 'USER' },
          strategy: { ...strategy, ownership: 'USER' },
          account: { ...account, liveTradingAuthorized: true },
          liveTradingEnvironmentAuthorized: true,
          execution: {
            adapterId: 'live-x',
            adapterKind: 'LIVE',
            health: 'ONLINE',
            reconciled: true,
            supportedEntryTypes: ['MARKET'],
          },
        },
        'LIVE',
      ),
    );
    expect(failing(d)).toEqual([]);
    expect(d.status).toBe('APPROVED');
  });

  it('PAPER refuses a LIVE adapter (adapter kind must match mode)', () => {
    const d = decide(
      makeInputs({
        execution: {
          adapterId: 'live-x',
          adapterKind: 'LIVE',
          health: 'ONLINE',
          reconciled: true,
          supportedEntryTypes: ['MARKET'],
        },
      }),
    );
    expect(failing(d)).toContain('execution.readiness');
  });

  it('unreconciled execution state → NO TRADE', () => {
    const d = decide(
      makeInputs({
        execution: {
          adapterId: 'paper',
          adapterKind: 'PAPER',
          health: 'ONLINE',
          reconciled: false,
          supportedEntryTypes: ['MARKET'],
        },
      }),
    );
    expect(failing(d)).toContain('execution.readiness');
  });
});

describe('DecisionEngine — market, strategy, context', () => {
  it('rejects a wide spread', () => {
    const d = decide(
      makeInputs({
        quote: observed(
          { symbol: 'NQ', bid: 19_998, ask: 20_000, asOf: '2026-09-28T13:59:59.000Z' },
          { source: 't', sourceKind: 'SIMULATED', asOf: '2026-09-28T13:59:59.000Z' },
        ),
      }),
    );
    expect(failing(d)).toContain('market.spread');
  });

  it('rejects when price has moved too far from the signal entry', () => {
    const d = decide(
      makeInputs({
        quote: observed(
          { symbol: 'NQ', bid: 20_002.75, ask: 20_003, asOf: '2026-09-28T13:59:59.000Z' },
          { source: 't', sourceKind: 'SIMULATED', asOf: '2026-09-28T13:59:59.000Z' },
        ),
      }),
    );
    expect(failing(d)).toContain('market.entry');
  });

  it('rejects an expired or unqualified signal', () => {
    const base = makeInputs();
    const expired = decide({
      ...base,
      candidate: {
        ...base.candidate,
        signal: { ...base.candidate.signal, detectedAt: '2026-09-28T13:55:00.000Z' },
      },
    });
    expect(failing(expired)).toContain('strategy.signal');
    const watch = decide({
      ...base,
      candidate: { ...base.candidate, signal: { ...base.candidate.signal, setupState: 'WATCH' } },
    });
    expect(failing(watch)).toContain('strategy.signal');
  });

  it('rejects a disabled strategy or an unknown account', () => {
    expect(decide(makeInputs({ strategy: { ...strategy, status: 'DISABLED' } })).status).toBe(
      'REJECTED',
    );
    expect(decide(makeInputs({ account: null })).status).toBe('REJECTED');
  });

  it('rejects inside a high-impact event blackout', () => {
    const cal = observed(
      {
        from: '2026-09-28T13:00:00.000Z',
        to: '2026-09-29T13:00:00.000Z',
        events: [
          {
            id: 'cpi',
            title: 'Test CPI',
            impact: 'HIGH' as const,
            scheduledAt: '2026-09-28T14:10:00.000Z',
            affectedInstruments: [],
          },
        ],
      },
      { source: 't', sourceKind: 'SIMULATED', asOf: '2026-09-28T13:59:59.000Z' },
    );
    const d = decide(makeInputs({ calendar: cal }));
    expect(failing(d)).toEqual(['calendar.event-blackout']);
    expect(d.reasons.join()).toMatch(/Test CPI/);
  });

  it('rejects when calendar coverage does not include the blackout window', () => {
    const cal = observed(
      { from: '2026-09-28T13:55:00.000Z', to: '2026-09-28T14:05:00.000Z', events: [] },
      { source: 't', sourceKind: 'SIMULATED', asOf: '2026-09-28T13:59:59.000Z' },
    );
    expect(failing(decide(makeInputs({ calendar: cal })))).toContain('calendar.event-blackout');
  });

  describe('AI (context only — can veto, never approve)', () => {
    const aiStrategy = { ...strategy, requiresAiAnalysis: true };
    const analysis = (verdict: 'SUPPORTS' | 'CONFLICTS', confidence = 0.8) =>
      observed(
        {
          analysisId: 'ai-1',
          signalId: 'sig-1',
          model: 'test-model',
          producedAt: NOW,
          verdict,
          confidence,
          setupQuality: 80,
          eventRisk: 'LOW' as const,
          reasons: ['test'],
          invalidation: [],
        },
        { source: 'ai', sourceKind: 'LIVE', asOf: '2026-09-28T13:59:59.000Z' },
      );

    it('required but unavailable → NO TRADE', () => {
      expect(failing(decide(makeInputs({ strategy: aiStrategy })))).toContain('ai.analysis');
    });
    it('CONFLICTS → NO TRADE', () => {
      expect(
        failing(decide(makeInputs({ strategy: aiStrategy, aiAnalysis: analysis('CONFLICTS') }))),
      ).toContain('ai.analysis');
    });
    it('low confidence → NO TRADE', () => {
      expect(
        failing(
          decide(makeInputs({ strategy: aiStrategy, aiAnalysis: analysis('SUPPORTS', 0.3) })),
        ),
      ).toContain('ai.analysis');
    });
    it('SUPPORTS cannot override a deterministic failure', () => {
      const d = decide(
        makeInputs({ strategy: aiStrategy, aiAnalysis: analysis('SUPPORTS'), mode: 'HALTED' }),
      );
      expect(d.status).toBe('REJECTED');
    });
    it('SUPPORTS with everything else valid → APPROVED', () => {
      expect(
        decide(makeInputs({ strategy: aiStrategy, aiAnalysis: analysis('SUPPORTS') })).status,
      ).toBe('APPROVED');
    });
  });
});

describe('DecisionEngine — risk, prop-firm, position', () => {
  it('rejects when the daily loss buffer cannot absorb the trade', () => {
    const base = makeInputs();
    const d = decide({
      ...base,
      accountSnapshot: observed(
        {
          accountId: 'acct-a',
          asOf: '2026-09-28T13:59:59.000Z',
          currency: 'USD',
          balance: 49_300,
          equity: 49_300,
          openPositions: [],
          pendingOrders: 0,
        },
        { source: 't', sourceKind: 'SIMULATED', asOf: '2026-09-28T13:59:59.000Z' },
      ),
    });
    expect(d.status).toBe('REJECTED');
    expect(failing(d)).toEqual(expect.arrayContaining(['risk.capital-preservation']));
  });

  it('rejects a duplicate signal and a working order', () => {
    const d = decide(
      makeInputs({
        duplicates: observed(
          { priorApprovedDecisionId: 'dec_prev', workingOrderForSymbol: true },
          { source: 'db', sourceKind: 'LIVE', asOf: NOW },
        ),
      }),
    );
    expect(failing(d)).toEqual(['position.duplicates']);
  });

  it('rejects R:R below minimum', () => {
    const base = makeInputs();
    const d = decide({
      ...base,
      candidate: { ...base.candidate, signal: { ...base.candidate.signal, target: 20_012 } },
    });
    expect(d.reasons.join()).toMatch(/R:R/);
  });
});

describe('GatePipeline robustness', () => {
  it('a throwing check becomes ERROR and rejects', () => {
    const boom = {
      id: 'test.boom',
      layer: 'MARKET' as const,
      mandatory: true,
      description: '',
      evaluate: () => {
        throw new Error('kaboom');
      },
    };
    const e = new DecisionEngine({ pipeline: new GatePipeline([...STANDARD_CHECKS, boom]) });
    const d = e.evaluate(makeInputs());
    expect(d.status).toBe('REJECTED');
    expect(d.checks.find((c) => c.checkId === 'test.boom')!.verdict).toBe('ERROR');
  });

  it('a pipeline missing a required layer can never approve', () => {
    const noRisk = STANDARD_CHECKS.filter((c) => c.layer !== 'RISK');
    const e = new DecisionEngine({ pipeline: new GatePipeline(noRisk) });
    const d = e.evaluate(makeInputs());
    expect(d.status).toBe('REJECTED');
    expect(d.reasons.join()).toMatch(/no mandatory check for required layer RISK/);
  });

  it('an empty pipeline can never approve', () => {
    const e = new DecisionEngine({ pipeline: new GatePipeline([]) });
    expect(e.evaluate(makeInputs()).status).toBe('REJECTED');
  });

  it('rejects duplicate check ids', () => {
    expect(() => new GatePipeline([STANDARD_CHECKS[0]!, STANDARD_CHECKS[0]!])).toThrow(/duplicate/);
  });
});

describe('decideAndRecord — persistence gate (spec §54)', () => {
  it('returns the approval when persisted', async () => {
    const r = await decideAndRecord(engine, makeInputs(), { record: () => Promise.resolve() });
    expect(r.persisted).toBe(true);
    expect(r.decision.status).toBe('APPROVED');
  });

  it('rejects when the decision cannot be persisted', async () => {
    const r = await decideAndRecord(engine, makeInputs(), {
      record: () => Promise.reject(new Error('db down')),
    });
    expect(r.persisted).toBe(false);
    expect(r.decision.status).toBe('REJECTED');
    expect(r.decision.approval).toBeNull();
    expect(r.decision.reasons.join()).toMatch(/could not be persisted: db down/);
  });
});

describe('DecisionEngine — market session (Phase 2)', () => {
  const at = (now: string) => {
    const base = makeInputs({ now });
    const detected = new Date(Date.parse(now) - 30_000).toISOString();
    const asOf = new Date(Date.parse(now) - 1_000).toISOString();
    const meta = { source: 'test', sourceKind: 'SIMULATED' as const, asOf };
    return {
      ...base,
      candidate: { ...base.candidate, signal: { ...base.candidate.signal, detectedAt: detected } },
      quote: observed({ symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf }, meta),
      accountSnapshot: observed(
        {
          accountId: 'acct-a',
          asOf,
          currency: 'USD',
          balance: 50_000,
          equity: 50_000,
          openPositions: [],
          pendingOrders: 0,
        },
        meta,
      ),
      calendar: observed(
        {
          from: new Date(Date.parse(now) - 3_600_000).toISOString(),
          to: new Date(Date.parse(now) + 3_600_000).toISOString(),
          events: [],
        },
        meta,
      ),
    };
  };
  const session = (d: TradeDecision) => d.checks.find((c) => c.checkId === 'market.session')!;

  it('passes while the market is open and reports active sessions', () => {
    const d = decide(makeInputs());
    expect(session(d).verdict).toBe('PASS');
    expect(session(d).details).toMatchObject({
      marketOpen: true,
      activeSessions: ['london', 'ny-cash'],
    });
  });

  it('rejects when the market is closed (daily break and weekend)', () => {
    expect(session(decide(at('2026-09-28T21:30:00.000Z'))).verdict).toBe('FAIL'); // Mon 17:30 ET break
    const weekend = decide(at('2026-10-03T15:00:00.000Z'));
    expect(weekend.status).toBe('REJECTED');
    expect(session(weekend).reasons[0]).toMatch(/closed \(next open 2026-10-04T22:00:00.000Z\)/);
  });

  it('rejects inside the pre-close buffer', () => {
    const d = decide(at('2026-09-28T20:55:00.000Z')); // 16:55 ET, 5 min before the daily close
    expect(session(d).verdict).toBe('FAIL');
    expect(session(d).reasons[0]).toMatch(/closes in 5 min/);
  });

  it('is UNKNOWN (NO TRADE) when trading hours are not configured', () => {
    const { tradingHours: _omit, ...noHours } = NQ;
    const d = decide(makeInputs({ instrument: noHours, instruments: { NQ: noHours } }));
    expect(session(d).verdict).toBe('UNKNOWN');
    expect(d.status).toBe('REJECTED');
  });

  it('enforces strategy session restrictions', () => {
    const londonOnly = decide(makeInputs({ strategy: { ...strategy, sessions: ['london'] } }));
    expect(session(londonOnly).verdict).toBe('PASS');
    // 18:00Z = 14:00 ET: NY cash open, London closed
    const late = at('2026-09-28T18:00:00.000Z');
    const d = decide({ ...late, strategy: { ...strategy, sessions: ['london'] } });
    expect(session(d).verdict).toBe('FAIL');
    expect(session(d).reasons[0]).toMatch(
      /outside strategy sessions \(london\); active now: ny-cash/,
    );
    expect(
      session(decide({ ...late, strategy: { ...strategy, sessions: ['nowhere'] } })).verdict,
    ).toBe('UNKNOWN');
  });
});

describe('DecisionEngine — per-instrument entry tolerance', () => {
  const moved = observed(
    { symbol: 'NQ', bid: 20_002.75, ask: 20_003, asOf: '2026-09-28T13:59:59.000Z' },
    { source: 't', sourceKind: 'SIMULATED' as const, asOf: '2026-09-28T13:59:59.000Z' },
  );

  it('uses the instrument override instead of the global default', () => {
    // 12 ticks from entry: rejected by the global 8-tick default…
    expect(
      decide(makeInputs({ quote: moved })).checks.find((c) => c.checkId === 'market.entry')!
        .verdict,
    ).toBe('FAIL');
    // …accepted when the instrument allows 20 ticks.
    const wide = { ...NQ, maxEntryDeviationTicks: 20 };
    const d = decide(makeInputs({ quote: moved, instrument: wide, instruments: { NQ: wide } }));
    expect(d.checks.find((c) => c.checkId === 'market.entry')!.verdict).toBe('PASS');
  });
});
