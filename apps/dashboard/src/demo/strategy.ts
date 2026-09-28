/**
 * The server's StrategyRunner logic (ADR-0024) in the browser demo: the owner's LSFVG v1.0 engine
 * on the demo's SIMULATED M5 candles, every setup through the demo gate as a LIMIT signal, and
 * the §26 record kept for the Strategy Manager. History candles only warm the engines up.
 */
import type { ExecutionResult } from '@astra/execution';
import type { Bar } from '@astra/market-data';
import type { StrategyDefinition, TradeCandidate } from '@astra/core';
import type { TradeDecision } from '@astra/decision';
import {
  LsfvgEngine,
  LsfvgParamsSchema,
  decisionRecord,
  gateOutcome,
  toSignal,
  type LsfvgEvent,
} from '@astra/strategy-lsfvg';
import type { StrategyEngineStatus, StrategyRunRecord, StrategyRunnerStatus } from '../api/types';
import type { DemoConfig } from './config';

interface Slot {
  readonly strategy: StrategyDefinition;
  readonly symbol: string;
  readonly engine: LsfvgEngine;
  lastOpenMs: number;
  lastCandle: string | null;
}

export interface DemoStrategyHost {
  readonly config: DemoConfig;
  now(): string;
  evaluate(
    candidate: TradeCandidate,
    autoExecute: boolean,
  ): Promise<{ decision: TradeDecision; execution: ExecutionResult | null }>;
  cancelForSignal(signalId: string, reason: string): Promise<void>;
  emit(level: 'INFO' | 'WARN' | 'ERROR', type: string, message: string, accountId?: string): void;
}

export class DemoStrategyRunner {
  private readonly slots: Slot[] = [];
  private readonly recent: StrategyRunRecord[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: DemoStrategyHost) {
    const { config } = host;
    if (config.system.strategyRunner?.enabled !== true) return;
    for (const strategy of config.strategies.values()) {
      if (strategy.status !== 'ACTIVE' || strategy.rules.engine !== 'lsfvg-v1') continue;
      const params = LsfvgParamsSchema.parse(strategy.rules.params ?? {});
      for (const symbol of strategy.instruments) {
        const spec = config.instruments.get(symbol);
        if (!spec) continue;
        this.slots.push({
          strategy,
          symbol,
          engine: new LsfvgEngine(symbol, spec.tickSize, params),
          lastOpenMs: -Infinity,
          lastCandle: null,
        });
      }
    }
  }

  /** Newly completed bars; `live` false while the demo builds its history (warm-up only). */
  onBars(bars: readonly Bar[], live: boolean): void {
    if (this.slots.length === 0) return;
    const m5 = bars
      .filter((b) => b.timeframe === 'M5' && b.complete)
      .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
    const found: { slot: Slot; event: LsfvgEvent }[] = [];
    for (const b of m5) {
      for (const slot of this.slots) {
        if (slot.symbol !== b.symbol) continue;
        const openMs = Date.parse(b.openTime);
        if (openMs <= slot.lastOpenMs) continue;
        slot.lastOpenMs = openMs;
        slot.lastCandle = b.closeTime;
        for (const event of slot.engine.onM5(b)) found.push({ slot, event });
      }
    }
    if (!live) return;
    this.queue = this.queue.then(async () => {
      for (const f of found) await this.handle(f.slot, f.event);
    });
  }

  private async handle(slot: Slot, e: LsfvgEvent): Promise<void> {
    const { host } = this;
    const strategy = slot.strategy;
    if (e.kind === 'REJECTED') {
      this.remember(strategy.id, null, null, null, decisionRecord({ rejection: e.rejection }));
      host.emit(
        'INFO',
        'STRATEGY_NO_TRADE',
        `${strategy.id} ${e.rejection.symbol} ${e.rejection.direction}: ${e.rejection.stage} — ${e.rejection.reason}`,
      );
      return;
    }
    if (e.kind === 'INVALIDATED') {
      await host.cancelForSignal(`${strategy.id}:${e.setupId}`, e.reason);
      return;
    }
    for (const account of host.config.accounts.values()) {
      if (account.status !== 'ACTIVE' || !account.strategies.includes(strategy.id)) continue;
      const r = await host.evaluate(
        { accountId: account.id, submittedAt: host.now(), signal: toSignal(e.setup, strategy.id) },
        host.config.system.strategyRunner?.autoExecute === true,
      );
      const record = decisionRecord({ setup: e.setup }, gateOutcome(r.decision));
      this.remember(
        strategy.id,
        account.id,
        r.decision.decisionId,
        r.execution ? `${r.execution.outcome}: ${r.execution.reasons.join('; ')}` : null,
        record,
      );
      host.emit(
        r.decision.status === 'APPROVED' ? 'INFO' : 'WARN',
        `STRATEGY_SETUP_${r.decision.status}`,
        `${strategy.id} ${e.setup.symbol} ${e.setup.direction} LIMIT ${e.setup.entry}: ${record.DECISION}`,
        account.id,
      );
    }
  }

  private remember(
    strategyId: string,
    accountId: string | null,
    decisionId: string | null,
    execution: string | null,
    record: StrategyRunRecord['record'],
  ): void {
    this.recent.unshift({
      at: this.host.now(),
      strategyId,
      accountId,
      decisionId,
      execution,
      record,
    });
    if (this.recent.length > 50) this.recent.pop();
  }

  status(): StrategyRunnerStatus {
    return {
      enabled: this.slots.length > 0,
      engines: this.slots.map((s): StrategyEngineStatus => ({
        strategyId: s.strategy.id,
        symbol: s.symbol,
        source: 'simulation',
        lastCandle: s.lastCandle,
        bias: s.engine.bias().bias,
        counters: { ...s.engine.counters },
      })),
      recent: [...this.recent],
    };
  }
}
