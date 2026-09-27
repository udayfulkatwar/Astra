/**
 * Backtests (ADR-0016): replays stored (or seeded SIMULATED) M1 bars through @astra/backtest with
 * the live configuration and policies, and records each run. One run at a time; the replay
 * yields to the event loop every 1,000 bars so the real-time safety loop is never starved.
 * A backtest never touches accounts, orders, kill switches or the trading mode.
 */
import {
  BacktestRequestSchema,
  MAX_BACKTEST_BARS,
  backtestConfigOf,
  runBacktest,
  simulateM1Bars,
  type BacktestRequest,
  type BacktestResult,
} from '@astra/backtest';
import { decisionConfigView, type AstraConfig } from '@astra/config';
import { AstraError, newId, type Clock } from '@astra/core';
import type { BacktestRepository, MarketBarRepository } from '@astra/db';
import type { Bar, MarketDataService } from '@astra/market-data';
import { DEFAULT_MONITOR_POLICY, DEFAULT_PROTECTION_POLICY } from '@astra/risk';
import type { EventBus } from './event-bus';

export interface BacktestRunResponse {
  readonly runId: string;
  readonly createdAt: string;
  readonly result: BacktestResult;
}

export class BacktestService {
  private running: string | null = null;

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      bars: MarketBarRepository;
      runs: BacktestRepository;
      market: MarketDataService;
      events: EventBus;
    },
  ) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  async run(input: unknown, actor: string): Promise<BacktestRunResponse> {
    const req = BacktestRequestSchema.parse(input);
    if (this.running)
      throw new AstraError(
        'CONFLICT',
        `backtest ${this.running} is still running; try again later`,
      );
    const runId = newId('backtest');
    this.running = runId;
    try {
      const bars = await this.bars(req);
      const { config } = this.deps;
      const result = await runBacktest({
        config: backtestConfigOf(req),
        bars,
        env: {
          config: decisionConfigView(config),
          monitorPolicy: config.system.monitors.positions ?? DEFAULT_MONITOR_POLICY,
          protectionPolicy: config.system.protection ?? DEFAULT_PROTECTION_POLICY,
          structureParams: config.system.structure,
          lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
        },
        yieldControl: () => new Promise((resolve) => setImmediate(resolve)),
      });
      const createdAt = this.deps.clock.now().toISOString();
      await this.deps.runs.record({
        runId,
        createdAt,
        createdBy: actor,
        dataKind: req.data.kind,
        request: req,
        result,
      });
      const o = result.summary.overall;
      await this.deps.events.emit({
        level: 'INFO',
        component: 'backtest',
        type: 'BACKTEST_COMPLETED',
        message: `backtest ${runId}: ${req.symbol} ${o.trades} trades, net ${result.performance.netChange} ${result.account.currency} (${result.label})`,
        accountId: req.accountId,
        data: { runId, trades: o.trades, signals: result.decisions.signals },
      });
      return { runId, createdAt, result };
    } finally {
      this.running = null;
    }
  }

  private async bars(req: BacktestRequest): Promise<Bar[]> {
    if (req.data.kind === 'SIMULATED') {
      const spec = this.deps.config.instruments.get(req.symbol);
      if (!spec?.tradingHours)
        throw new AstraError(
          'VALIDATION',
          `no instrument spec with trading hours for ${req.symbol}`,
        );
      let start = req.data.startPrice;
      if (start === undefined) {
        const q = this.deps.market.latest(req.symbol);
        if (q.status !== 'OK')
          throw new AstraError(
            'VALIDATION',
            `startPrice required: no current quote for ${req.symbol}`,
          );
        start = (q.value.bid + q.value.ask) / 2;
      }
      const bars = simulateM1Bars({
        symbol: req.symbol,
        tickSize: spec.tickSize,
        startPrice: start,
        from: req.from,
        to: req.to,
        hours: spec.tradingHours,
        seed: req.data.seed,
      });
      if (bars.length === 0)
        throw new AstraError('VALIDATION', 'the market is closed for the whole range');
      return bars;
    }

    const bars = await this.deps.bars.range({
      symbol: req.symbol,
      timeframe: 'M1',
      from: req.from,
      to: req.to,
      limit: MAX_BACKTEST_BARS + 1,
      source: req.data.source,
    });
    if (bars.length === 0)
      throw new AstraError('VALIDATION', `no stored M1 bars for ${req.symbol} in that range`);
    if (bars.length > MAX_BACKTEST_BARS)
      throw new AstraError('VALIDATION', `more than ${MAX_BACKTEST_BARS} bars: shorten the range`);
    const sources = [...new Set(bars.map((b) => b.source))];
    if (sources.length > 1)
      throw new AstraError(
        'VALIDATION',
        `stored bars come from several sources (${sources.join(', ')}): choose one with data.source`,
      );
    return bars;
  }
}
