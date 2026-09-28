/**
 * Derivations: deterministic values computed from the frozen DecisionInputs before any check
 * runs. Each derivation is either a value or an explicit failure; a thrown error becomes a
 * failure (never an approval).
 */
import {
  applyFreshness,
  dec,
  describeNotOk,
  toNum,
  errorMessage,
  type AccountActivity,
  type AccountSnapshot,
  type AiAnalysis,
  type CalendarWindow,
  type NewsRiskAssessment,
  type Observed,
  type Quote,
  exposurePositions,
} from '@astra/core';
import {
  computeAccountState,
  evaluatePropFirmRules,
  firmQuantityHeadroom,
  resolveInitialBasedLimit,
  trailingExposure,
  type AccountState,
  type AccountTracking,
  type PropFirmVerdict,
  type QuantityHeadroom,
  type TrailingExposure,
} from '@astra/prop-firm';
import {
  calculatePositionSize,
  classifyAccountHealth,
  evaluateRiskPolicy,
  type AccountHealthAssessment,
  type PositionSizing,
  type RiskVerdict,
} from '@astra/risk';
import type { DecisionInputs } from './types';

export type Derived<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const ok = <T>(value: T): Derived<T> => ({ ok: true, value });
const missing = <T>(reason: string): Derived<T> => ({ ok: false, reason });

function fromObserved<T>(label: string, o: Observed<T>): Derived<T> {
  return o.status === 'OK' ? ok(o.value) : missing(describeNotOk(label, o));
}

function guard<T>(label: string, fn: () => Derived<T>): Derived<T> {
  try {
    return fn();
  } catch (err) {
    return missing(`${label} computation failed: ${errorMessage(err)}`);
  }
}

/** Freshness-checked views of time-sensitive observations. */
export interface FreshInputs {
  readonly quote: Observed<Quote>;
  readonly accountSnapshot: Observed<AccountSnapshot>;
  readonly calendar: Observed<CalendarWindow>;
  readonly newsRisk: Observed<NewsRiskAssessment>;
  readonly aiAnalysis: Observed<AiAnalysis>;
}

export interface Derivations {
  readonly fresh: FreshInputs;
  /**
   * Planned entry: MARKET — the executable price (ask for LONG, bid for SHORT); LIMIT — the limit
   * price (a fill is at the limit or better, so risk is sized from it).
   */
  readonly effectiveEntry: Derived<number>;
  readonly tracking: Derived<AccountTracking>;
  readonly activity: Derived<AccountActivity>;
  readonly accountState: Derived<AccountState>;
  readonly health: Derived<AccountHealthAssessment>;
  readonly headroom: Derived<QuantityHeadroom>;
  /** Trailing intraday-equity path exposure (null value: the rule is not trailing intraday). */
  readonly trailing: Derived<TrailingExposure | null>;
  readonly sizing: Derived<PositionSizing>;
  readonly propFirm: Derived<PropFirmVerdict>;
  readonly risk: Derived<RiskVerdict>;
}

export function deriveAll(inputs: DecisionInputs): Derivations {
  const now = new Date(inputs.now);
  const f = inputs.policy.freshness;
  const fresh: FreshInputs = {
    quote: applyFreshness(inputs.quote, now, {
      maxAgeMs: f.quoteMaxAgeMs,
      maxFutureSkewMs: f.maxFutureSkewMs,
    }),
    accountSnapshot: applyFreshness(inputs.accountSnapshot, now, {
      maxAgeMs: f.accountSnapshotMaxAgeMs,
      maxFutureSkewMs: f.maxFutureSkewMs,
    }),
    calendar: applyFreshness(inputs.calendar, now, {
      maxAgeMs: f.calendarMaxAgeMs,
      maxFutureSkewMs: f.maxFutureSkewMs,
    }),
    newsRisk: applyFreshness(inputs.newsRisk, now, {
      maxAgeMs: f.newsMaxAgeMs,
      maxFutureSkewMs: f.maxFutureSkewMs,
    }),
    aiAnalysis: applyFreshness(inputs.aiAnalysis, now, {
      maxAgeMs: f.aiAnalysisMaxAgeMs,
      maxFutureSkewMs: f.maxFutureSkewMs,
    }),
  };

  const signal = inputs.candidate.signal;
  const lookup = (symbol: string) => inputs.instruments[symbol];
  const entryUntil = entryWindowEnd(signal);

  const effectiveEntry: Derived<number> = guard('entry', () => {
    const q = fromObserved('quote', fresh.quote);
    if (!q.ok) return q;
    if (signal.entryType === 'LIMIT') return ok(signal.entry);
    return ok(signal.direction === 'LONG' ? q.value.ask : q.value.bid);
  });

  const snapshot = fromObserved('account snapshot', fresh.accountSnapshot);
  const tracking = fromObserved('account tracking', inputs.tracking);
  const activity = fromObserved('account activity', inputs.activity);

  const accountState: Derived<AccountState> = guard('account state', () => {
    if (!inputs.profile) return missing('prop-firm profile not found');
    if (!snapshot.ok) return snapshot;
    if (!tracking.ok) return tracking;
    return ok(
      computeAccountState({
        profile: inputs.profile,
        tracking: tracking.value,
        snapshot: snapshot.value,
        // A position on an instrument without a spec makes open risk UNKNOWN (fail-closed).
        instruments: lookup,
      }),
    );
  });

  const health: Derived<AccountHealthAssessment> = guard('account health', () => {
    if (!accountState.ok) return accountState;
    if (!activity.ok) return activity;
    if (!inputs.riskPolicy) return missing('risk policy not found');
    if (!inputs.account) return missing('account not found');
    return ok(
      classifyAccountHealth({
        state: accountState.value,
        policy: inputs.riskPolicy,
        activity: activity.value,
        accountStatus: inputs.account.status,
      }),
    );
  });

  const headroom: Derived<QuantityHeadroom> = guard('firm quantity headroom', () => {
    if (!inputs.profile) return missing('prop-firm profile not found');
    if (!inputs.instrument) return missing('instrument spec not found');
    if (!accountState.ok) return accountState;
    if (!snapshot.ok) return snapshot;
    return ok(
      firmQuantityHeadroom({
        profile: inputs.profile,
        state: accountState.value,
        snapshot: snapshot.value,
        spec: inputs.instrument,
        instruments: lookup,
      }),
    );
  });

  // Trailing intraday-equity drawdown: the run-up-then-reverse path (ADR-0013); null otherwise.
  const trailing: Derived<TrailingExposure | null> = guard('trailing drawdown exposure', () => {
    if (!inputs.profile) return missing('prop-firm profile not found');
    if (!accountState.ok) return accountState;
    if (!snapshot.ok) return snapshot;
    return ok(
      trailingExposure(
        inputs.profile.maxDrawdown,
        accountState.value,
        exposurePositions(snapshot.value),
        lookup,
      ),
    );
  });

  const sizing: Derived<PositionSizing> = guard('position sizing', () => {
    if (!inputs.instrument) return missing('instrument spec not found');
    if (!inputs.account) return missing('account not found');
    if (!inputs.riskPolicy) return missing('risk policy not found');
    if (!inputs.strategy) return missing('strategy not found');
    if (!inputs.profile) return missing('prop-firm profile not found');
    if (!effectiveEntry.ok) return effectiveEntry;
    if (!accountState.ok) return accountState;
    if (!health.ok) return health;
    if (!headroom.ok) return headroom;
    if (!trailing.ok) return trailing;
    const firmMax = inputs.profile.trading.maxRiskPerTrade
      ? toNum(
          resolveInitialBasedLimit(
            inputs.profile.trading.maxRiskPerTrade,
            dec(accountState.value.initialBalance),
          ),
        )
      : null;
    return ok(
      calculatePositionSize({
        instrument: inputs.instrument,
        accountCurrency: inputs.account.currency,
        direction: signal.direction,
        entry: effectiveEntry.value,
        stop: signal.stop,
        state: accountState.value,
        policy: inputs.riskPolicy,
        strategyMaxRiskPercent: inputs.strategy.maxRiskPercentPerTrade ?? null,
        healthMultiplier: health.value.sizeMultiplier,
        firmMaxRiskPerTrade: firmMax,
        firmHeadroom: headroom.value,
        target: signal.target,
        trailing: trailing.value,
      }),
    );
  });

  const propFirm: Derived<PropFirmVerdict> = guard('prop-firm rules', () => {
    if (!inputs.profile) return missing('prop-firm profile not found');
    if (!inputs.account) return missing('account not found');
    if (!inputs.riskPolicy) return missing('risk policy not found');
    if (!accountState.ok) return accountState;
    if (!snapshot.ok) return snapshot;
    if (!effectiveEntry.ok) return effectiveEntry;
    if (!sizing.ok) return sizing;
    if (!sizing.value.ok) return missing(`no valid position size: ${sizing.value.reason}`);
    return ok(
      evaluatePropFirmRules({
        profile: inputs.profile,
        account: inputs.account,
        state: accountState.value,
        snapshot: snapshot.value,
        proposal: {
          symbol: signal.symbol,
          direction: signal.direction,
          quantity: sizing.value.quantity,
          entry: effectiveEntry.value,
          stop: signal.stop,
          target: signal.target,
          worstCaseLoss: sizing.value.dollarRisk,
        },
        instruments: lookup,
        calendar: fresh.calendar,
        now,
        ...(entryUntil ? { entryUntil } : {}),
        flatBufferMinutes: inputs.riskPolicy.timing.noNewTradesMinutesBeforeFlat,
      }),
    );
  });

  const risk: Derived<RiskVerdict> = guard('risk policy', () => {
    if (!inputs.riskPolicy) return missing('risk policy not found');
    if (!inputs.strategy) return missing('strategy not found');
    if (!health.ok) return health;
    if (!sizing.ok) return sizing;
    if (!accountState.ok) return accountState;
    if (!snapshot.ok) return snapshot;
    if (!activity.ok) return activity;
    if (!effectiveEntry.ok) return effectiveEntry;
    if (!trailing.ok) return trailing;
    return ok(
      evaluateRiskPolicy({
        policy: inputs.riskPolicy,
        strategy: inputs.strategy,
        health: health.value,
        sizing: sizing.value,
        state: accountState.value,
        snapshot: snapshot.value,
        activity: activity.value,
        symbol: signal.symbol,
        direction: signal.direction,
        entry: effectiveEntry.value,
        stop: signal.stop,
        target: signal.target,
        trailing: trailing.value,
        valuePerPoint: inputs.instrument
          ? toNum(dec(inputs.instrument.tickValue).div(inputs.instrument.tickSize))
          : undefined,
      }),
    );
  });

  return {
    fresh,
    effectiveEntry,
    tracking,
    activity,
    accountState,
    health,
    headroom,
    trailing,
    sizing,
    propFirm,
    risk,
  };
}

/** A resting LIMIT entry can fill until it expires: time-based rules must cover that window. */
export function entryWindowEnd(signal: {
  entryType: string;
  expiresAt?: string | undefined;
}): Date | undefined {
  return signal.entryType === 'LIMIT' && signal.expiresAt ? new Date(signal.expiresAt) : undefined;
}
