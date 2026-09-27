import { observed, notObserved, type OpenPosition, type Quote } from '@astra/core';
import { PropFirmRuleProfileSchema, type PropFirmRuleProfile } from '@astra/prop-firm';
import { describe, expect, it } from 'vitest';
import { MonitorAlertTracker, type MonitorAlertChange } from '../src/monitor-alerts';
import {
  DEFAULT_MONITOR_POLICY,
  MonitorPolicySchema,
  monitorAccount,
  type AccountMonitorView,
  type PositionView,
} from '../src/monitor';
import { lookup, makeSnapshot, makeTracking, profile, stateFor } from './fixtures';

const NOW = new Date('2026-09-28T14:00:00.000Z');

// Long 2 NQ @ 20,000, stop 19,990 (10 pt = $400 at $40/pt), target 20,020 (2 R).
const long = (overrides: Partial<OpenPosition> = {}): OpenPosition => ({
  positionId: 'p1',
  symbol: 'NQ',
  direction: 'LONG',
  quantity: 2,
  entryPrice: 20_000,
  currentPrice: 20_002.5,
  stopPrice: 19_990,
  targetPrice: 20_020,
  unrealizedPnl: 100,
  openedAt: '2026-09-28T13:30:00.000Z',
  ...overrides,
});

const quote = (bid: number, ask = bid + 0.25) =>
  observed<Quote>(
    { symbol: 'NQ', bid, ask, asOf: NOW.toISOString() },
    { source: 'feed', sourceKind: 'LIVE', asOf: NOW.toISOString() },
  );

function run(opts: {
  positions: OpenPosition[];
  q?: ReturnType<typeof quote> | ReturnType<typeof notObserved>;
  p?: PropFirmRuleProfile;
  equityPeak?: number;
}) {
  const floating = opts.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const snapshot = makeSnapshot({ equity: 50_000 + floating, openPositions: opts.positions });
  const p = opts.p ?? profile;
  const tracking = makeTracking({ equityPeak: opts.equityPeak ?? 50_000 + floating });
  return monitorAccount({
    accountId: 'acct-a',
    now: NOW,
    snapshot: observed(snapshot, { source: 'paper', sourceKind: 'SIMULATED', asOf: snapshot.asOf }),
    state: stateFor(snapshot, tracking, p),
    drawdownRule: p.maxDrawdown,
    instruments: lookup,
    quote: () => opts.q ?? quote(20_002.5),
    policy: DEFAULT_MONITOR_POLICY,
  });
}

const trailingProfile = (trailingStopsAt: Record<string, unknown>) =>
  PropFirmRuleProfileSchema.parse({
    ...profile,
    maxDrawdown: {
      type: 'TRAILING_INTRADAY_EQUITY',
      limit: { kind: 'AMOUNT', value: 2_500 },
      measure: 'EQUITY',
      trailingStopsAt,
    },
  });

describe('monitorAccount — positions', () => {
  it('marks a long at the bid and derives P&L, R, stop and target distances', () => {
    const v = run({ positions: [long()] });
    expect(v.status).toBe('OK');
    expect(v.positions[0]).toMatchObject({
      mark: 20_002.5,
      unrealizedPnl: 100, // 2.5 pt × $40
      initialRisk: 400,
      rMultiple: 0.25,
      stopRemainingPct: 125, // 12.5 of the 10-point stop distance
      stopDistanceTicks: 50,
      targetProgressPct: 12.5,
      targetDistanceTicks: 70,
      riskToStop: 518, // 12.5 pt × $40 + 1 tick slippage × 2 + $4 commission × 2
      flags: [],
    });
  });

  it('marks a short at the ask and flags a nearby stop', () => {
    const short = long({
      direction: 'SHORT',
      stopPrice: 20_010,
      targetPrice: 19_980,
      currentPrice: 20_007,
    });
    const v = run({ positions: [short], q: quote(20_007.75, 20_008) });
    expect(v.positions[0]).toMatchObject({
      mark: 20_008,
      unrealizedPnl: -320,
      rMultiple: -0.8,
      stopRemainingPct: 20,
      flags: ['NEAR_STOP'],
    });
  });

  it('flags a position without a fresh quote or without a stop — never inventing a mark', () => {
    const v = run({
      positions: [long({ stopPrice: null })],
      q: notObserved('STALE', 'age 9000ms exceeds limit 5000ms', 'feed'),
    });
    expect(v.positions[0]).toMatchObject({
      mark: null,
      markReason: 'quote STALE: age 9000ms exceeds limit 5000ms',
      unrealizedPnl: null,
      brokerUnrealizedPnl: 100,
      initialRisk: null,
      flags: ['NO_PRICE', 'UNPROTECTED'],
    });
    expect(v.bufferUsedPct).toBeNull(); // open risk unknown without a stop
  });

  it('is UNKNOWN when the account snapshot is not available', () => {
    const v = monitorAccount({
      accountId: 'acct-a',
      now: NOW,
      snapshot: notObserved('ERROR', 'broker unreachable', 'paper'),
      state: null,
      drawdownRule: profile.maxDrawdown,
      instruments: lookup,
      quote: () => quote(20_000),
      policy: DEFAULT_MONITOR_POLICY,
    });
    expect(v).toMatchObject({
      status: 'UNKNOWN',
      reason: 'account snapshot ERROR: broker unreachable',
      positions: [],
    });
  });
});

describe('monitorAccount — limits and the trailing path', () => {
  it('reports static buffers without a trailing path', () => {
    const v = run({ positions: [long()] });
    expect(v.trailing).toBeNull();
    // Worst-case equity 50,100 − 518 = 49,582: daily loss 418 of 1,000 used.
    expect(v.dailyLoss?.worstCaseUsedPct).toBeCloseTo(41.8, 5);
    expect(v.bufferUsedPct).toBeCloseTo(41.8, 5);
  });

  it('prices the run-up-then-reverse path of a trailing intraday threshold', () => {
    const v = run({ positions: [long()], p: trailingProfile({ kind: 'INITIAL_BALANCE' }) });
    // Peak 50,100 → threshold 47,600. Run-up to target 17.5 pt × $40 = 700 → peak 50,800,
    // threshold 48,300; then the stop: equity 49,582 → 1,282 left of 2,500 (48.72% used).
    expect(v.trailing).toMatchObject({
      locked: false,
      threshold: 47_600,
      lockLevel: 50_000,
      runUp: 700,
      pathThreshold: 48_300,
      pathRemaining: 1_282,
      pathUsedPct: 48.72,
    });
    expect(v.drawdown?.worstCaseUsedPct).toBeCloseTo(20.72, 5); // the naive worst case
    expect(v.bufferUsedPct).toBe(48.72);
  });

  it('without a target the threshold can climb to its lock level; without a lock it is unknown', () => {
    const lockable = run({
      positions: [long({ targetPrice: null })],
      p: trailingProfile({ kind: 'INITIAL_BALANCE' }),
    });
    expect(lockable.trailing).toMatchObject({
      runUp: null,
      pathThreshold: 50_000,
      pathRemaining: -418,
    });
    expect(lockable.trailing?.pathUsedPct).toBeCloseTo(116.72, 5);

    const never = run({
      positions: [long({ targetPrice: null })],
      p: trailingProfile({ kind: 'NEVER' }),
    });
    expect(never.trailing).toMatchObject({
      runUp: null,
      pathThreshold: null,
      pathRemaining: null,
      pathUsedPct: null,
    });
    expect(never.trailing?.note).toMatch(/unbounded/);
    expect(never.bufferUsedPct).toBeNull();
  });

  it('a locked threshold no longer moves: the path equals the plain worst case', () => {
    const v = run({
      positions: [long()],
      p: trailingProfile({ kind: 'INITIAL_BALANCE' }),
      equityPeak: 52_600,
    });
    expect(v.trailing).toMatchObject({
      locked: true,
      runUp: 0,
      pathThreshold: 50_000,
      pathRemaining: -418,
    });
  });
});

describe('MonitorAlertTracker', () => {
  const pos = (o: Partial<PositionView> = {}): PositionView => ({
    positionId: 'p1',
    symbol: 'NQ',
    direction: 'LONG',
    quantity: 2,
    entryPrice: 20_000,
    stopPrice: 19_990,
    targetPrice: 20_020,
    openedAt: '2026-09-28T13:30:00.000Z',
    strategyId: null,
    mark: 20_002.5,
    markReason: null,
    unrealizedPnl: 100,
    brokerUnrealizedPnl: 100,
    initialRisk: 400,
    rMultiple: 0.25,
    stopRemainingPct: 125,
    stopDistanceTicks: 50,
    targetProgressPct: 12.5,
    targetDistanceTicks: 70,
    riskToStop: 518,
    flags: [],
    ...o,
  });
  const view = (
    positions: PositionView[],
    bufferUsedPct: number | null = 10,
  ): AccountMonitorView => ({
    accountId: 'acct-a',
    asOf: NOW.toISOString(),
    status: 'OK',
    reason: null,
    currency: 'USD',
    equity: 50_100,
    positions,
    dailyLoss: null,
    drawdown: {
      limit: 2_500,
      remaining: 2_000,
      usedPct: 20,
      worstCaseRemaining: 1_500,
      worstCaseUsedPct: bufferUsedPct,
    },
    trailing: null,
    bufferUsedPct,
  });
  const summary = (c: MonitorAlertChange[]) =>
    c.map((x) => `${x.change} ${x.alert.kind} ${x.alert.level}`);

  it('raises once per crossing and clears only past the hysteresis margin', () => {
    const t = new MonitorAlertTracker(DEFAULT_MONITOR_POLICY);
    expect(t.update([view([pos()])], NOW)).toEqual([]);
    expect(summary(t.update([view([pos({ stopRemainingPct: 20 })])], NOW))).toEqual([
      'RAISED STOP_NEAR WARN',
    ]);
    expect(t.update([view([pos({ stopRemainingPct: 18 })])], NOW)).toEqual([]); // no repeat
    expect(t.update([view([pos({ stopRemainingPct: 28 })])], NOW)).toEqual([]); // inside 25 + 5
    // No price: the distance is unknown — the alert stays up (only NO_PRICE is added).
    expect(
      summary(
        t.update(
          [view([pos({ mark: null, stopRemainingPct: null, targetProgressPct: null })])],
          NOW,
        ),
      ),
    ).toEqual(['RAISED NO_PRICE WARN']);
    expect(t.list().map((a) => a.kind)).toEqual(['STOP_NEAR', 'NO_PRICE']); // older first
    expect(summary(t.update([view([pos({ stopRemainingPct: 28 })])], NOW))).toEqual([
      'CLEARED NO_PRICE WARN',
    ]);
    expect(summary(t.update([view([pos({ stopRemainingPct: 31 })])], NOW))).toEqual([
      'CLEARED STOP_NEAR WARN',
    ]);
  });

  it('keeps UNPROTECTED critical until a stop exists, and clears alerts of closed positions', () => {
    const t = new MonitorAlertTracker(DEFAULT_MONITOR_POLICY);
    const naked = pos({
      stopPrice: null,
      stopRemainingPct: null,
      initialRisk: null,
      targetProgressPct: 85,
    });
    expect(summary(t.update([view([naked], null)], NOW))).toEqual([
      'RAISED BUFFER WARN', // worst case unknown with a position open
      'RAISED UNPROTECTED CRITICAL',
      'RAISED TARGET_NEAR INFO',
    ]);
    expect(t.list().map((a) => a.kind)).toEqual(['UNPROTECTED', 'BUFFER', 'TARGET_NEAR']);
    // Closed: its alerts clear, and with no open risk the buffer is known (10%) and fine again.
    expect(summary(t.update([view([])], NOW))).toEqual([
      'CLEARED BUFFER WARN',
      'CLEARED UNPROTECTED CRITICAL',
      'CLEARED TARGET_NEAR INFO',
    ]);
    expect(t.list()).toEqual([]);
  });

  it('escalates the account buffer from WARN to CRITICAL and clears below warn − hysteresis', () => {
    const t = new MonitorAlertTracker(DEFAULT_MONITOR_POLICY);
    expect(summary(t.update([view([pos()], 72)], NOW))).toEqual(['RAISED BUFFER WARN']);
    expect(summary(t.update([view([pos()], 93)], NOW))).toEqual(['ESCALATED BUFFER CRITICAL']);
    expect(t.update([view([pos()], 68)], NOW)).toEqual([]); // 68 ≥ 70 − 5
    const cleared = t.update([view([pos()], 60)], NOW);
    expect(summary(cleared)).toEqual(['CLEARED BUFFER CRITICAL']); // the level it had
    expect(cleared[0]!.alert.message).toMatch(/60\.0% of a hard limit/);
  });

  it('warns when an account can no longer be evaluated', () => {
    const t = new MonitorAlertTracker(DEFAULT_MONITOR_POLICY);
    const unknown: AccountMonitorView = {
      ...view([]),
      status: 'UNKNOWN',
      reason: 'account snapshot ERROR: down',
    };
    expect(summary(t.update([unknown], NOW))).toEqual(['RAISED MONITOR_UNKNOWN WARN']);
    expect(summary(t.update([view([])], NOW))).toEqual(['CLEARED MONITOR_UNKNOWN WARN']);
  });

  it('validates the policy', () => {
    expect(() => MonitorPolicySchema.parse({ bufferWarnPct: 95, bufferCriticalPct: 90 })).toThrow(
      /bufferWarnPct must be below/,
    );
  });
});
