/** Stored backtest runs: list items carry a small summary; a run carries the full result. */
import type { BacktestResult } from './engine';

export interface BacktestRunSummary {
  readonly label: string;
  readonly trades: number;
  readonly winRatePct: number | null;
  readonly avgR: number | null;
  readonly netChange: number;
  readonly returnPct: number;
  readonly maxDrawdown: number;
  readonly signals: number;
  readonly approved: number;
  readonly warnings: number;
}

export interface BacktestRunListItem {
  readonly runId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly strategyId: string;
  readonly dataKind: 'STORED' | 'SIMULATED';
  readonly from: string;
  readonly to: string;
  readonly configHash: string;
  readonly summary: BacktestRunSummary;
}

export interface BacktestRun extends BacktestRunListItem {
  readonly request: Record<string, unknown>;
  readonly result: BacktestResult;
}

export function summarizeBacktest(r: BacktestResult): BacktestRunSummary {
  return {
    label: r.label,
    trades: r.summary.overall.trades,
    winRatePct: r.summary.overall.winRatePct,
    avgR: r.summary.overall.avgR,
    netChange: r.performance.netChange,
    returnPct: r.performance.returnPct,
    maxDrawdown: r.performance.maxDrawdown,
    signals: r.decisions.signals,
    approved: r.decisions.approved,
    warnings: r.warnings.length,
  };
}

export function backtestListItem(
  run: Omit<
    BacktestRun,
    'summary' | 'accountId' | 'symbol' | 'strategyId' | 'from' | 'to' | 'configHash'
  >,
): BacktestRunListItem {
  const r = run.result;
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    createdBy: run.createdBy,
    accountId: r.account.id,
    symbol: r.data.symbol,
    strategyId: r.strategy.id,
    dataKind: run.dataKind,
    from: r.data.from,
    to: r.data.to,
    configHash: r.configHash,
    summary: summarizeBacktest(r),
  };
}
