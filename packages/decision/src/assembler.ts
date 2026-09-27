/**
 * Context assembly: gathers every input for a decision through ports, each with a hard timeout,
 * and freezes them into DecisionInputs. A provider that fails, hangs or is absent produces an
 * explicit non-OK observation — never a default value.
 */
import {
  newId,
  notObserved,
  observeWithTimeout,
  type AccountActivity,
  type AccountDefinition,
  type AccountSnapshot,
  type AiAnalysis,
  type CalendarWindow,
  type Clock,
  type ComponentHealth,
  type InstrumentSpec,
  type NewsRiskAssessment,
  type Observed,
  type Quote,
  type SessionDefinition,
  type StrategyDefinition,
  type TradeCandidate,
  type TradingMode,
} from '@astra/core';
import type { AccountTracking, PropFirmRuleProfile } from '@astra/prop-firm';
import type { RiskPolicy } from '@astra/risk';
import type { KillSwitchContext, KillSwitchEvaluation } from '@astra/safety';
import type { DecisionPolicy } from './policy';
import type { DecisionInputs, DuplicateCheckData, ExecutionReadiness } from './types';

/** External data sources. Every method must resolve to an Observed (never throw by design). */
export interface DecisionDataPorts {
  quote(symbol: string, signal: AbortSignal): Promise<Observed<Quote>>;
  accountSnapshot(accountId: string, signal: AbortSignal): Promise<Observed<AccountSnapshot>>;
  tracking(accountId: string, signal: AbortSignal): Promise<Observed<AccountTracking>>;
  activity(accountId: string, signal: AbortSignal): Promise<Observed<AccountActivity>>;
  calendar(from: Date, to: Date, signal: AbortSignal): Promise<Observed<CalendarWindow>>;
  newsRisk(symbol: string, signal: AbortSignal): Promise<Observed<NewsRiskAssessment>>;
  aiAnalysis(candidate: TradeCandidate, signal: AbortSignal): Promise<Observed<AiAnalysis>>;
  duplicates(
    accountId: string,
    signalId: string,
    symbol: string,
    signal: AbortSignal,
  ): Promise<Observed<DuplicateCheckData>>;
}

/** In-process state (synchronous, owned by the core). */
export interface DecisionStatePorts {
  mode(): TradingMode;
  killSwitches(ctx: KillSwitchContext): KillSwitchEvaluation;
  componentHealth(): readonly ComponentHealth[];
  execution(account: AccountDefinition | null): ExecutionReadiness;
  liveTradingEnvironmentAuthorized(): boolean;
}

/** Read-only view of validated configuration. */
export interface DecisionConfigView {
  readonly configHash: string;
  readonly policy: DecisionPolicy;
  account(id: string): AccountDefinition | undefined;
  profile(id: string): PropFirmRuleProfile | undefined;
  riskPolicy(id: string): RiskPolicy | undefined;
  strategy(id: string): StrategyDefinition | undefined;
  instrument(symbol: string): InstrumentSpec | undefined;
  sessions(): readonly SessionDefinition[];
}

export interface AssembleOptions {
  readonly candidate: TradeCandidate;
  readonly config: DecisionConfigView;
  readonly data: DecisionDataPorts;
  readonly state: DecisionStatePorts;
  readonly clock: Clock;
  /** Per-provider timeout. */
  readonly timeoutMs: number;
  readonly decisionId?: string;
}

function notRequested<T>(what: string): Observed<T> {
  return notObserved('UNAVAILABLE', `${what} not requested (not required)`, 'assembler');
}

export async function assembleDecisionInputs(opts: AssembleOptions): Promise<DecisionInputs> {
  const { candidate, config, data, state, clock, timeoutMs } = opts;
  const signal = candidate.signal;
  const account = config.account(candidate.accountId) ?? null;
  const profile = account ? (config.profile(account.propFirmProfileId) ?? null) : null;
  const riskPolicy = account ? (config.riskPolicy(account.riskPolicyId) ?? null) : null;
  const strategy = config.strategy(signal.strategyId) ?? null;
  const instrument = config.instrument(signal.symbol) ?? null;

  const instruments: Record<string, InstrumentSpec> = {};
  for (const sym of new Set([signal.symbol, ...(account?.instruments ?? [])])) {
    const spec = config.instrument(sym);
    if (spec) instruments[sym] = spec;
  }

  // Calendar window must cover the widest blackout of global, strategy and firm rules.
  const minutesBefore = Math.max(
    config.policy.eventBlackout.minutesBefore,
    strategy?.eventBlackout?.minutesBefore ?? 0,
    profile?.news?.minutesBefore ?? 0,
  );
  const minutesAfter = Math.max(
    config.policy.eventBlackout.minutesAfter,
    strategy?.eventBlackout?.minutesAfter ?? 0,
    profile?.news?.minutesAfter ?? 0,
  );
  const now = clock.now();
  const calFrom = new Date(now.getTime() - minutesAfter * 60_000);
  const calTo = new Date(now.getTime() + minutesBefore * 60_000);

  const acct = candidate.accountId;
  const obs = <T>(source: string, fn: (s: AbortSignal) => Promise<Observed<T>>) =>
    observeWithTimeout(source, timeoutMs, fn);

  const [quote, accountSnapshot, tracking, activity, calendar, newsRisk, aiAnalysis, duplicates] =
    await Promise.all([
      obs('market-data', (s) => data.quote(signal.symbol, s)),
      obs('account-data', (s) => data.accountSnapshot(acct, s)),
      obs('account-tracking', (s) => data.tracking(acct, s)),
      obs('account-activity', (s) => data.activity(acct, s)),
      obs('calendar', (s) => data.calendar(calFrom, calTo, s)),
      config.policy.news.required
        ? obs('news', (s) => data.newsRisk(signal.symbol, s))
        : Promise.resolve(notRequested<NewsRiskAssessment>('news risk')),
      strategy?.requiresAiAnalysis
        ? obs('ai', (s) => data.aiAnalysis(candidate, s))
        : Promise.resolve(notRequested<AiAnalysis>('AI analysis')),
      obs('duplicates', (s) => data.duplicates(acct, signal.id, signal.symbol, s)),
    ]);

  return {
    decisionId: opts.decisionId ?? newId('decision'),
    // Decision time is taken AFTER gathering so freshness is judged at the moment of decision.
    now: clock.now().toISOString(),
    mode: state.mode(),
    configHash: config.configHash,
    policy: config.policy,
    candidate,
    account,
    profile,
    riskPolicy,
    strategy,
    instrument,
    sessions: config.sessions(),
    instruments,
    quote,
    accountSnapshot,
    tracking,
    activity,
    calendar,
    newsRisk,
    aiAnalysis,
    duplicates,
    killSwitches: state.killSwitches({
      accountId: acct,
      strategyId: signal.strategyId,
      symbol: signal.symbol,
      requiresAi: strategy?.requiresAiAnalysis ?? false,
    }),
    componentHealth: state.componentHealth(),
    execution: state.execution(account),
    liveTradingEnvironmentAuthorized: state.liveTradingEnvironmentAuthorized(),
  };
}
