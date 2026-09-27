/**
 * Demo backtests: the REAL @astra/backtest engine run in the browser against the bundled
 * configuration. "Recorded" data is the demo's own in-memory bars (themselves SIMULATED);
 * simulated data is the seeded generator. Runs are kept in memory for the session only.
 */
import {
  BacktestRequestSchema,
  backtestConfigOf,
  backtestListItem,
  runBacktest,
  simulateM1Bars,
  type BacktestRequest,
  type BacktestRun,
} from '@astra/backtest';
import { AstraError, newId } from '@astra/core';
import type { Bar } from '@astra/market-data';
import { DEFAULT_MONITOR_POLICY, DEFAULT_PROTECTION_POLICY } from '@astra/risk';
import { ApiError } from '../api/client';
import type { DemoRuntime } from './runtime';

const runs: BacktestRun[] = [];
let running = false;

export function listBacktests() {
  return { runs: runs.map((r) => backtestListItem(r)), running };
}

export function getBacktest(runId: string): BacktestRun {
  const run = runs.find((r) => r.runId === runId);
  if (!run) throw new ApiError(404, 'NOT_FOUND', `backtest ${runId} not found`);
  return run;
}

function bars(rt: DemoRuntime, req: BacktestRequest): Bar[] {
  const spec = rt.config.instruments.get(req.symbol);
  if (!spec?.tradingHours)
    throw new ApiError(
      400,
      'VALIDATION',
      `no instrument spec with trading hours for ${req.symbol}`,
    );
  if (req.data.kind === 'STORED') {
    const from = Date.parse(req.from);
    const to = Date.parse(req.to);
    const recorded = rt.market
      .bars(req.symbol, 'M1', 100_000)
      .filter((b) => b.complete && Date.parse(b.openTime) >= from && Date.parse(b.closeTime) <= to);
    if (recorded.length === 0)
      throw new ApiError(400, 'VALIDATION', `no recorded M1 bars for ${req.symbol} in that range`);
    return recorded;
  }
  let start = req.data.startPrice;
  if (start === undefined) {
    const q = rt.latestQuote(req.symbol);
    if (q.status !== 'OK')
      throw new ApiError(
        400,
        'VALIDATION',
        `startPrice required: no current quote for ${req.symbol}`,
      );
    start = (q.value.bid + q.value.ask) / 2;
  }
  const out = simulateM1Bars({
    symbol: req.symbol,
    tickSize: spec.tickSize,
    startPrice: start,
    from: req.from,
    to: req.to,
    hours: spec.tradingHours,
    seed: req.data.seed,
  });
  if (out.length === 0)
    throw new ApiError(400, 'VALIDATION', 'the market is closed for the whole range');
  return out;
}

export async function runDemoBacktest(rt: DemoRuntime, input: unknown) {
  const parsed = BacktestRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      'VALIDATION',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
    );
  if (running) throw new ApiError(409, 'CONFLICT', 'a backtest is still running; try again later');
  running = true;
  try {
    const req = parsed.data;
    const { config } = rt;
    const result = await runBacktest({
      config: backtestConfigOf(req),
      bars: bars(rt, req),
      env: {
        config: {
          configHash: config.hash,
          policy: config.system.decision,
          account: (id) => config.accounts.get(id),
          profile: (id) => config.profiles.get(id),
          riskPolicy: (id) => config.riskPolicies.get(id),
          strategy: (id) => config.strategies.get(id),
          instrument: (s) => config.instruments.get(s),
          sessions: () => config.system.sessions,
        },
        monitorPolicy: config.system.monitors.positions ?? DEFAULT_MONITOR_POLICY,
        protectionPolicy: config.system.protection ?? DEFAULT_PROTECTION_POLICY,
        structureParams: config.system.structure,
        lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
      },
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
    }).catch((err: unknown) => {
      if (err instanceof AstraError) throw new ApiError(400, err.code, err.message);
      throw err;
    });
    const run: BacktestRun = {
      ...backtestListItem({
        runId: newId('backtest'),
        createdAt: rt.clock.now().toISOString(),
        createdBy: 'operator',
        dataKind: req.data.kind,
        request: req,
        result,
      }),
      request: req,
      result,
    };
    runs.unshift(run);
    rt.emit(
      'INFO',
      'backtest',
      'BACKTEST_COMPLETED',
      `backtest ${run.runId}: ${req.symbol} ${result.summary.overall.trades} trades, net ${result.performance.netChange} ${result.account.currency} (${result.label})`,
      req.accountId,
      { runId: run.runId },
    );
    return { runId: run.runId, createdAt: run.createdAt, result };
  } finally {
    running = false;
  }
}
