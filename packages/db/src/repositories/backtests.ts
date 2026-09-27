/** Backtest runs (append-only): the request and the full result of each run, as produced. */
import {
  summarizeBacktest,
  type BacktestResult,
  type BacktestRun,
  type BacktestRunListItem,
  type BacktestRunSummary,
} from '@astra/backtest';
import type { Sql } from '../client';
import { iso, jsonb } from '../client';

interface Row {
  run_id: string;
  created_at: Date;
  created_by: string;
  account_id: string;
  symbol: string;
  strategy_id: string;
  data_kind: 'STORED' | 'SIMULATED';
  from_time: Date;
  to_time: Date;
  config_hash: string;
  summary: BacktestRunSummary;
}

const item = (r: Row): BacktestRunListItem => ({
  runId: r.run_id,
  createdAt: iso(r.created_at)!,
  createdBy: r.created_by,
  accountId: r.account_id,
  symbol: r.symbol,
  strategyId: r.strategy_id,
  dataKind: r.data_kind,
  from: iso(r.from_time)!,
  to: iso(r.to_time)!,
  configHash: r.config_hash,
  summary: r.summary,
});

export class BacktestRepository {
  constructor(private readonly sql: Sql) {}

  async record(run: {
    runId: string;
    createdAt: string;
    createdBy: string;
    dataKind: 'STORED' | 'SIMULATED';
    request: Record<string, unknown>;
    result: BacktestResult;
  }): Promise<void> {
    const r = run.result;
    await this.sql`
      insert into backtest_runs
        (run_id, created_at, created_by, account_id, symbol, strategy_id, data_kind, from_time,
         to_time, config_hash, request, summary, result)
      values (${run.runId}, ${run.createdAt}, ${run.createdBy}, ${r.account.id}, ${r.data.symbol},
        ${r.strategy.id}, ${run.dataKind}, ${r.data.from}, ${r.data.to}, ${r.configHash},
        ${jsonb(this.sql, run.request)}, ${jsonb(this.sql, summarizeBacktest(r))},
        ${jsonb(this.sql, r)})`;
  }

  /** Newest first, without the full results. */
  async list(limit = 50): Promise<BacktestRunListItem[]> {
    const rows = await this.sql<Row[]>`
      select run_id, created_at, created_by, account_id, symbol, strategy_id, data_kind,
             from_time, to_time, config_hash, summary
        from backtest_runs order by created_at desc, run_id limit ${Math.min(Math.max(limit, 1), 200)}`;
    return rows.map(item);
  }

  async get(runId: string): Promise<BacktestRun | null> {
    const [row] = await this.sql<
      (Row & { request: Record<string, unknown>; result: BacktestResult })[]
    >`select * from backtest_runs where run_id = ${runId}`;
    return row ? { ...item(row), request: row.request, result: row.result } : null;
  }
}
