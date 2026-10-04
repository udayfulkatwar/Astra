/**
 * Test world for pre-submit validation: REAL assembler + Decision Engine + revalidateApprovedEntry
 * over fake ports whose data tests can change after an approval was issued. No network, no money.
 */
import {
  ManualClock,
  notObserved,
  observed,
  type AccountSnapshot,
  type EconomicEvent,
  type InstrumentSpec,
  type Observed,
  type Quote,
  type TradeCandidate,
} from '@astra/core';
import {
  DecisionEngine,
  revalidateApprovedEntry,
  updateAccountTracking,
  type DecisionDataPorts,
  type DecisionInputs,
  type EntryRevalidation,
  type TradeDecision,
} from '@astra/decision';
import { KillSwitchRegistry } from '@astra/safety';
import {
  NOW,
  NQ,
  SESSIONS,
  account,
  healthyComponents,
  makeInputs,
  policy,
  profile,
  riskPolicy,
  strategy,
  tracking,
} from '../../decision/test/fixtures';
import { ExecutionGateway, type EntryRevalidationRequest } from '../src/gateway';
import { PaperBrokerAdapter } from '../src/paper/paper-broker';
import type { ApprovalRecord, BrokerAdapter, ExecutionStore } from '../src/types';

export { NOW, NQ };
export const ES: InstrumentSpec = { ...NQ, symbol: 'ES', displayName: 'Test ES' };
export const CONFIG_HASH = 'sha256:test';

export interface World {
  clock: ManualClock;
  specs: Record<string, InstrumentSpec>;
  quotes: Record<string, { bid: number; ask: number }>;
  /** Age of every quote when served (ms). */
  quoteAgeMs: number;
  /** When set, quotes keep THIS asOf however late they are served (so time can make them stale). */
  quoteAsOf: string | null;
  calendarEvents: EconomicEvent[];
  riskPolicy: typeof riskPolicy;
  configHash: string;
  mode: 'PAPER' | 'SHADOW' | 'LIVE' | 'HALTED';
  equity: number | null;
  ks: KillSwitchRegistry;
  accountStatus: 'ACTIVE' | 'SUSPENDED';
  candidates: Map<string, TradeCandidate>;
  liveEnv: boolean;
  accountLiveAuth: boolean;
  /** Called at the start of every revalidation (to inject changes "during" async work). */
  onRevalidate: (() => Promise<void> | void) | null;
  /** Extra async delay inside the broker snapshot call. */
  onSnapshot: (() => Promise<void> | void) | null;
  /** Providers whose CURRENT state is ERROR (read synchronously by the final guard). */
  revoked: { quote: boolean; calendar: boolean; news: boolean };
}

export function makeWorld(): World {
  const clock = new ManualClock(NOW);
  const ks = new KillSwitchRegistry(clock);
  ks.load([]);
  return {
    clock,
    specs: { NQ, ES },
    quotes: { NQ: { bid: 19_999.75, ask: 20_000 }, ES: { bid: 19_999.75, ask: 20_000 } },
    quoteAgeMs: 500,
    quoteAsOf: null,
    calendarEvents: [],
    riskPolicy,
    configHash: CONFIG_HASH,
    mode: 'PAPER',
    equity: null,
    ks,
    accountStatus: 'ACTIVE',
    candidates: new Map(),
    liveEnv: false,
    accountLiveAuth: false,
    onRevalidate: null,
    onSnapshot: null,
    revoked: { quote: false, calendar: false, news: false },
  };
}

export const accountDef = (w: World) => ({
  ...account,
  status: w.accountStatus,
  instruments: ['NQ', 'ES'],
  liveTradingAuthorized: w.accountLiveAuth,
});
const strat = { ...strategy, instruments: ['NQ', 'ES'] };

export function makeBroker(w: World): PaperBrokerAdapter {
  const broker = new PaperBrokerAdapter({ clock: w.clock, instruments: (s) => w.specs[s] });
  broker.openAccount('PAPER-A', 50_000);
  for (const [symbol, q] of Object.entries(w.quotes))
    broker.onQuote({ symbol, ...q, asOf: w.clock.now().toISOString() });
  return broker;
}

/** Equity/snapshot overrides and delay hooks around a broker (the account "changes" at the broker). */
export function instrument(w: World, broker: BrokerAdapter): BrokerAdapter {
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === 'getAccountSnapshot') {
        return async (ref: string, id: string): Promise<AccountSnapshot> => {
          await w.onSnapshot?.();
          const s = await target.getAccountSnapshot(ref, id);
          return w.equity === null ? s : { ...s, equity: w.equity, balance: w.equity };
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Decides a fresh candidate with the real engine and returns the stored artefacts. */
export function decide(
  w: World,
  o: {
    approvalId: string;
    signalId: string;
    symbol?: string;
    decisionId?: string;
    limit?: boolean;
  },
): { decision: TradeDecision; inputs: DecisionInputs; approval: ApprovalRecord } {
  const symbol = o.symbol ?? 'NQ';
  const base = makeInputs({ decisionId: o.decisionId ?? `dec_${o.approvalId}` });
  const candidate: TradeCandidate = {
    ...base.candidate,
    signal: {
      ...base.candidate.signal,
      id: o.signalId,
      symbol,
      ...(o.limit
        ? {
            entryType: 'LIMIT' as const,
            entry: 19_995,
            stop: 19_985,
            target: 20_025,
            expiresAt: new Date(Date.parse(NOW) + 600_000).toISOString(),
          }
        : {}),
    },
  };
  const inputs: DecisionInputs = {
    ...base,
    candidate,
    account: accountDef(w) as never,
    strategy: strat,
    riskPolicy: w.riskPolicy,
    instrument: w.specs[symbol]!,
    instruments: w.specs,
    execution: { ...base.execution, supportedEntryTypes: ['MARKET', 'LIMIT'] },
    quote: observed(
      { symbol, ...w.quotes[symbol]!, asOf: NOW },
      { source: 'test', sourceKind: 'SIMULATED', asOf: NOW },
    ),
  };
  const decision = new DecisionEngine({ newApprovalId: () => o.approvalId }).evaluate(inputs);
  if (decision.status !== 'APPROVED' || !decision.approval || !decision.orderPlan)
    throw new Error(`fixture decision not approved: ${decision.reasons.join('; ')}`);
  w.candidates.set(o.approvalId, candidate);
  return {
    decision,
    inputs,
    approval: {
      approvalId: o.approvalId,
      decisionId: decision.decisionId,
      accountId: 'acct-a',
      strategyId: strat.id,
      signalId: o.signalId,
      mode: 'PAPER',
      orderPlan: decision.orderPlan,
      expiresAt: decision.approval.expiresAt,
      state: 'PENDING',
    },
  };
}

/** The production wiring in miniature: original candidate → fresh ports → real engine. */
export function realRevalidator(
  w: World,
  store: ExecutionStore & {
    workingOrders(a: string, s: string): Promise<{ clientOrderId: string }[]>;
  },
  priorApproved: (
    accountId: string,
    signalId: string,
    excludeDecisionId: string,
  ) => Promise<string | null> = () => Promise.resolve(null),
) {
  const engine = new DecisionEngine();
  return (req: EntryRevalidationRequest): Promise<EntryRevalidation> => {
    const now = w.clock.now();
    const meta = (source: string, ageMs = 0) => ({
      source,
      sourceKind: 'SIMULATED' as const,
      asOf: new Date(now.getTime() - ageMs).toISOString(),
    });
    const base = makeInputs();
    const quoteNow = (symbol: string): Observed<Quote> =>
      observed(
        { symbol, ...w.quotes[symbol]!, asOf: w.quoteAsOf ?? meta('q', w.quoteAgeMs).asOf },
        { ...meta('q', w.quoteAgeMs), asOf: w.quoteAsOf ?? meta('q', w.quoteAgeMs).asOf },
      );
    const data: DecisionDataPorts = {
      quote: (symbol): Promise<Observed<Quote>> => Promise.resolve(quoteNow(symbol)),
      accountSnapshot: () => Promise.resolve(observed(req.snapshot, meta('broker'))),
      // Tracking is advanced from the FRESH broker snapshot, like production (not a cached copy).
      tracking: () =>
        Promise.resolve(
          observed(
            updateAccountTracking(tracking, req.snapshot, {
              reset: profile.tradingDayReset,
              tradedToday: false,
              lateObservationThresholdMs: 60_000,
            }),
            meta('astra-account-tracking'),
          ),
        ),
      activity: () => Promise.resolve(base.activity),
      calendar: () =>
        Promise.resolve(
          observed(
            {
              from: new Date(now.getTime() - 3_600_000).toISOString(),
              to: new Date(now.getTime() + 86_400_000).toISOString(),
              events: w.calendarEvents,
            },
            meta('calendar'),
          ),
        ),
      newsRisk: () => Promise.resolve(base.newsRisk),
      aiAnalysis: () => Promise.resolve(base.aiAnalysis),
      duplicates: async (accountId, signalId, symbol) =>
        observed(
          {
            priorApprovedDecisionId: await priorApproved(
              accountId,
              signalId,
              req.approval.decisionId,
            ),
            workingOrderForSymbol:
              (await store.workingOrders(accountId, symbol)).filter(
                (o) => o.clientOrderId !== req.ownClientOrderId,
              ).length > 0,
          },
          meta('db'),
        ),
    };
    return (async () => {
      await w.onRevalidate?.();
      return revalidateApprovedEntry({
        engine,
        candidate: w.candidates.get(req.approval.approvalId)!,
        plan: req.approval.orderPlan,
        originalConfigHash: CONFIG_HASH,
        current: {
          quote: (symbol) =>
            w.revoked.quote ? notObserved('ERROR', 'quote provider down', 'q') : quoteNow(symbol),
          calendar: () =>
            w.revoked.calendar
              ? notObserved('ERROR', 'calendar provider down', 'calendar')
              : observed(
                  {
                    from: new Date(now.getTime() - 3_600_000).toISOString(),
                    to: new Date(now.getTime() + 86_400_000).toISOString(),
                    events: w.calendarEvents,
                  },
                  meta('calendar'),
                ),
          newsRisk: () =>
            w.revoked.news ? notObserved('ERROR', 'news provider down', 'news') : base.newsRisk,
        },
        assemble: {
          config: {
            configHash: w.configHash,
            policy,
            account: (id) => (id === account.id ? (accountDef(w) as never) : undefined),
            profile: (id) => (id === profile.id ? profile : undefined),
            riskPolicy: (id) => (id === w.riskPolicy.id ? w.riskPolicy : undefined),
            strategy: (id) => (id === strat.id ? strat : undefined),
            instrument: (s) => w.specs[s],
            instrumentSymbols: () => Object.keys(w.specs),
            sessions: () => SESSIONS,
          },
          data,
          state: {
            mode: () => w.mode,
            killSwitches: (ctx) => w.ks.evaluate(ctx),
            componentHealth: () => healthyComponents(),
            execution: () => ({ ...base.execution, supportedEntryTypes: ['MARKET', 'LIMIT'] }),
            liveTradingEnvironmentAuthorized: () => w.liveEnv,
          },
          clock: w.clock,
          timeoutMs: 200,
        },
      });
    })();
  };
}

export function makeGateway(
  w: World,
  store: ExecutionStore & {
    workingOrders(a: string, s: string): Promise<{ clientOrderId: string }[]>;
  },
  adapter: BrokerAdapter,
  opts: {
    revalidate?: (r: EntryRevalidationRequest) => Promise<EntryRevalidation>;
    revalidationTimeoutMs?: number;
    onExecutionUnknown?: (a: string, c: string, r: string) => Promise<void>;
    priorApproved?: (a: string, s: string, e: string) => Promise<string | null>;
  } = {},
): ExecutionGateway {
  return new ExecutionGateway({
    store,
    adapter: (id) => (id === adapter.id ? adapter : undefined),
    account: (id) => (id === 'acct-a' ? (accountDef(w) as never) : undefined),
    mode: () => w.mode,
    killSwitches: (ctx) => w.ks.evaluate(ctx),
    liveTradingEnvironmentAuthorized: () => w.liveEnv,
    onExecutionUnknown: opts.onExecutionUnknown ?? (() => Promise.resolve()),
    revalidate: opts.revalidate ?? realRevalidator(w, store, opts.priorApproved),
    revalidationTimeoutMs: opts.revalidationTimeoutMs ?? 1_000,
    clock: w.clock,
    confirmation: { timeoutMs: 2_000, pollIntervalMs: 250 },
    sleep: (ms) => {
      w.clock.advance(ms);
      return Promise.resolve();
    },
  });
}
