/**
 * F003 — the synchronous final guard of a successful revalidation (ADR-0027 §3a), and FX
 * provenance in the assembler. Real assembler + real Decision Engine; deterministic clock.
 */
import { ManualClock, notObserved, observed, type Observed, type Quote } from '@astra/core';
import { describe, expect, it } from 'vitest';
import { assembleWithProvenance, type DecisionDataPorts } from '../src/assembler';
import { DecisionEngine } from '../src/engine';
import {
  revalidateApprovedEntry,
  type CurrentEvidencePorts,
  type EntryRevalidation,
} from '../src/revalidate';
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
const T0 = Date.parse(NOW);
const plan = (() => {
  const d = new DecisionEngine().evaluate(base);
  if (!d.orderPlan) throw new Error('fixture not approved');
  return d.orderPlan;
})();

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
const DAX = { ...NQ, symbol: 'DAX', quoteCurrency: 'EUR' };

interface Rig {
  clock: ManualClock;
  killSwitches: ReturnType<typeof loadedKillSwitches>;
  mode: { v: 'PAPER' | 'HALTED' };
  health: { down: boolean };
  revoked: { quote: boolean; calendar: boolean; news: boolean; fx: boolean };
  ports: Partial<DecisionDataPorts>;
  withFx: boolean;
  policy: typeof policy;
  profile: typeof profile;
}

function rig(over: Partial<Rig> = {}): Rig {
  return {
    clock: new ManualClock(NOW),
    killSwitches: loadedKillSwitches(),
    mode: { v: 'PAPER' },
    health: { down: false },
    revoked: { quote: false, calendar: false, news: false, fx: false },
    ports: {},
    withFx: false,
    policy,
    profile,
    ...over,
  };
}

function options(r: Rig) {
  const instruments = r.withFx ? ['NQ', 'USDJPY', 'DAX'] : ['NQ'];
  const specs = { NQ, USDJPY, DAX } as Record<string, typeof NQ>;
  const data: DecisionDataPorts = {
    quote: () => Promise.resolve(base.quote),
    accountSnapshot: () => Promise.resolve(base.accountSnapshot),
    tracking: () => Promise.resolve(base.tracking),
    activity: () => Promise.resolve(base.activity),
    calendar: () => Promise.resolve(base.calendar),
    newsRisk: () => Promise.resolve(notObserved('UNAVAILABLE', 'none', 'news')),
    aiAnalysis: () => Promise.resolve(notObserved('UNAVAILABLE', 'none', 'ai')),
    duplicates: () => Promise.resolve(base.duplicates),
    ...r.ports,
  };
  const current: CurrentEvidencePorts = {
    quote: (symbol) =>
      r.revoked.quote || (r.revoked.fx && symbol !== 'NQ')
        ? notObserved('ERROR', `${symbol} provider down`, 'q')
        : (base.quote as Observed<Quote>),
    calendar: () =>
      r.revoked.calendar ? notObserved('ERROR', 'calendar down', 'cal') : base.calendar,
    newsRisk: () => (r.revoked.news ? notObserved('ERROR', 'news down', 'news') : base.newsRisk),
  };
  return {
    engine: new DecisionEngine(),
    candidate: base.candidate,
    plan,
    originalConfigHash: 'sha256:test',
    current,
    assemble: {
      config: {
        configHash: 'sha256:test',
        policy: r.policy,
        account: (id: string) => (id === account.id ? { ...account, instruments } : undefined),
        profile: (id: string) => (id === r.profile.id ? r.profile : undefined),
        riskPolicy: (id: string) => (id === riskPolicy.id ? riskPolicy : undefined),
        strategy: (id: string) => (id === strategy.id ? strategy : undefined),
        instrument: (s: string) => (instruments.includes(s) ? specs[s] : undefined),
        instrumentSymbols: () => (r.withFx ? ['NQ', 'USDJPY', 'DAX', 'EURUSD'] : ['NQ']),
        sessions: () => [],
      },
      data,
      state: {
        mode: () => r.mode.v,
        killSwitches: (ctx) => r.killSwitches.evaluate(ctx),
        componentHealth: () =>
          healthyComponents().map((c) =>
            r.health.down && c.component === 'MARKET_DATA'
              ? { ...c, status: 'OFFLINE' as const }
              : c,
          ),
        execution: () => base.execution,
        liveTradingEnvironmentAuthorized: () => false,
      },
      clock: r.clock,
      timeoutMs: 50,
    },
  };
}

type Ok = Extract<EntryRevalidation, { ok: true }>;
async function approved(r: Rig): Promise<Ok> {
  const v = await revalidateApprovedEntry(options(r));
  if (!v.ok) throw new Error(`revalidation refused: ${v.reasons.join('; ')}`);
  return v;
}
const reasonsOf = (v: ReturnType<Ok['finalGuard']>) => (v.ok ? '' : v.reasons.join(' | '));
const longPolicy: typeof policy = {
  ...policy,
  freshness: {
    ...policy.freshness,
    quoteMaxAgeMs: 1e9,
    accountSnapshotMaxAgeMs: 1e9,
    calendarMaxAgeMs: 1e9,
    newsMaxAgeMs: 1e9,
    aiAnalysisMaxAgeMs: 1e9,
  },
};

describe('final guard — carries the revalidation and judges captured evidence NOW', () => {
  it('every successful revalidation carries a synchronous guard; unchanged world passes', async () => {
    const v = await approved(rig());
    expect(typeof v.finalGuard).toBe('function');
    const out = v.finalGuard();
    expect(out).toEqual({ ok: true });
    expect(typeof (out as unknown as { then?: unknown }).then).toBe('undefined');
  });

  it('quote that ages beyond its limit after the revalidation (approval TTL still valid)', async () => {
    const r = rig();
    const v = await approved(r);
    r.clock.advance(5_000); // quote asOf is 1s old at assembly → 6s > 5s limit; approval TTL is 30s
    expect(reasonsOf(v.finalGuard())).toMatch(/quote/i);
  });

  it('a calendar blackout that the clock crosses after the revalidation', async () => {
    // HIGH event at 14:16:00 with a 15 min blackout begins at 14:01:00.
    const calendar = observed(
      {
        from: '2026-09-28T13:00:00.000Z',
        to: '2026-09-28T16:00:00.000Z',
        events: [
          {
            id: 'cpi',
            title: 'CPI',
            impact: 'HIGH' as const,
            scheduledAt: '2026-09-28T14:16:00.000Z',
            affectedInstruments: [],
          },
        ],
      },
      { source: 'test', sourceKind: 'SIMULATED', asOf: '2026-09-28T13:59:59.000Z' },
    );
    const r = rig({ policy: longPolicy, ports: { calendar: () => Promise.resolve(calendar) } });
    const v = await approved(r);
    r.clock.advance(70_000); // 14:01:10; signal TTL (120s) still valid; inside the blackout
    expect(reasonsOf(v.finalGuard())).toMatch(/CPI/);
  });

  it('signal TTL expiry after the revalidation', async () => {
    const r = rig({ policy: longPolicy });
    const v = await approved(r);
    r.clock.advance(121_000); // signal detected 13:59:30 → TTL 120s
    expect(v.finalGuard().ok).toBe(false);
  });

  it('account tracking / activity aging (reuses the account snapshot limit)', async () => {
    const r = rig({
      policy: {
        ...policy,
        freshness: { ...policy.freshness, accountSnapshotMaxAgeMs: 4_000, quoteMaxAgeMs: 1e9 },
      },
    });
    const v = await approved(r);
    r.clock.advance(2_000);
    expect(v.finalGuard().ok).toBe(true);
    r.clock.advance(3_000); // 6s since the 13:59:59 observations
    expect(reasonsOf(v.finalGuard())).toMatch(/account/i);
  });

  it('kill switch, mode and health changes after the revalidation', async () => {
    const r = rig();
    const v = await approved(r);
    r.mode.v = 'HALTED';
    expect(v.finalGuard().ok).toBe(false);
    r.mode.v = 'PAPER';
    expect(v.finalGuard().ok).toBe(true);
    r.health.down = true;
    expect(v.finalGuard().ok).toBe(false);
    r.health.down = false;
    r.killSwitches.activate({
      scope: 'GLOBAL',
      target: null,
      reason: 'stop now',
      actor: { type: 'HUMAN', id: 'u' },
    });
    expect(reasonsOf(v.finalGuard())).toMatch(/stop now/);
  });

  it('provider revocation voids captured evidence even while its timestamp is fresh', async () => {
    for (const k of ['quote', 'calendar'] as const) {
      const r = rig();
      const v = await approved(r);
      r.revoked[k] = true;
      expect(reasonsOf(v.finalGuard())).toMatch(new RegExp(`${k} provider is now ERROR`));
    }
  });

  it('invalid and backward clocks are refused', async () => {
    const r = rig();
    const v = await approved(r);
    r.clock.set('2026-09-28T13:59:00.000Z');
    expect(reasonsOf(v.finalGuard())).toMatch(/backwards/);
    r.clock.now = () => new Date(Number.NaN);
    expect(reasonsOf(v.finalGuard())).toMatch(/invalid/);
  });

  it('configuration changed since the decision', async () => {
    const o = options(rig());
    const v = (await revalidateApprovedEntry(o)) as Ok;
    (o.assemble.config as { configHash: string }).configHash = 'sha256:other';
    expect(reasonsOf(v.finalGuard())).toMatch(/configuration changed/);
  });

  it('profile trading-day reset crossed during the wait: refuse, never use yesterday’s reference', async () => {
    // Reset 14:01 UTC: at 14:00:00 the day key is 2026-09-28 (the captured tracking's); at 14:01:30
    // it is 2026-09-29. Every other input stays valid (long limits; signal TTL 120s not reached).
    const reset = { ...profile, tradingDayReset: { timeZone: 'UTC', time: '14:01' } };
    const r = rig({ policy: longPolicy, profile: reset });
    const v = await approved(r);
    expect(v.finalGuard().ok).toBe(true);
    r.clock.advance(90_000);
    expect(reasonsOf(v.finalGuard())).toMatch(/trading day is now 2026-09-29/);
  });
});

describe('FX provenance (assembler) and its final validation', () => {
  const fxQuote = (symbol: string, asOf: string, bid = 150, ask = 150): Observed<Quote> =>
    observed({ symbol, bid, ask, asOf }, { source: 'fx', sourceKind: 'SIMULATED', asOf });
  const iso = (ms: number) => new Date(ms).toISOString();

  it('keeps every consulted FX quote with its own source and timestamp', async () => {
    const r = rig({
      withFx: true,
      ports: {
        quote: (s) =>
          Promise.resolve(
            s === 'USDJPY'
              ? fxQuote(s, iso(T0 - 1_000))
              : s === 'EURUSD'
                ? fxQuote(s, iso(T0 - 2_000), 1.1, 1.1)
                : base.quote,
          ),
      },
    });
    const { inputs, provenance } = await assembleWithProvenance({
      ...options(r).assemble,
      candidate: base.candidate,
    });
    expect(provenance.fx.map((d) => d.pair)).toEqual(['USDJPY', 'EURUSD']);
    expect(provenance.fx[0]!.observed).toMatchObject({
      status: 'OK',
      source: 'fx',
      asOf: iso(T0 - 1_000),
    });
    expect(inputs.instruments.USDJPY).toMatchObject({ conversion: { via: 'USDJPY' } });
    expect(inputs.instruments.DAX).toMatchObject({ conversion: { via: 'EURUSD' } });
  });

  it('a delayed SECOND FX fetch that expires the FIRST rate: the first is not fresh', async () => {
    const r = rig({ withFx: true });
    r.ports.quote = (s) => {
      if (s === 'USDJPY') return Promise.resolve(fxQuote(s, iso(T0 - 1_000)));
      if (s === 'EURUSD') {
        r.clock.advance(6_000); // the second fetch takes 6s; USDJPY is now 7s old (limit 5s)
        return Promise.resolve(fxQuote(s, iso(r.clock.now().getTime()), 1.1, 1.1));
      }
      return Promise.resolve(base.quote);
    };
    const { inputs } = await assembleWithProvenance({
      ...options(r).assemble,
      candidate: base.candidate,
    });
    expect(inputs.instruments.USDJPY).toMatchObject({
      conversionError: expect.stringMatching(/no fresh JPY→USD rate/),
    });
    // the decision time is taken after the last fetch, not before the sequence
    expect(inputs.now).toBe(iso(T0 + 6_000));
  });

  it('final guard: an FX rate that ages (own timestamp) or whose provider fails is refused', async () => {
    const mk = () =>
      rig({
        withFx: true,
        ports: {
          quote: (s) =>
            Promise.resolve(
              s === 'USDJPY'
                ? fxQuote(s, iso(T0 - 4_000)) // fresh at assembly (limit 5s), older than the others
                : s === 'EURUSD'
                  ? fxQuote(s, iso(T0 - 500), 1.1, 1.1)
                  : base.quote,
            ),
        },
      });
    const r = mk();
    const v = await approved(r);
    expect(v.finalGuard().ok).toBe(true);
    r.clock.advance(2_000); // NQ 3s, EURUSD 2.5s fresh; USDJPY 6s → stale
    expect(reasonsOf(v.finalGuard())).toMatch(/FX quote USDJPY is no longer valid \(STALE\)/);

    const r2 = mk();
    const v2 = await approved(r2);
    r2.revoked.fx = true; // timestamps untouched, provider now ERROR
    expect(reasonsOf(v2.finalGuard())).toMatch(/FX provider for USDJPY is now ERROR/);
  });
});
