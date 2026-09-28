/**
 * Runs the owner's rule-based strategies inside ASTRA (ADR-0024). Every ACTIVE strategy whose
 * `rules.engine` ASTRA implements (today: `lsfvg-v1`) gets one engine per instrument, fed the
 * closed M5 candles of the market-data service:
 *
 * - SETUP → a LIMIT signal for each ACTIVE account that runs the strategy, through the full gate
 *   (`DecisionService.evaluate`); approvals execute only where `autoExecute` and the mode allow.
 * - INVALIDATED → the resting order of that setup is cancelled (risk-reducing).
 * - Every complete sequence — traded or not — is recorded as the SPEC §26 decision record and
 *   raised as an event.
 *
 * Engines are warmed up from the candles already held (history is never traded), and pairs
 * whose setups complete on the same candle are evaluated in the strategy's instrument order
 * (the deterministic priority when correlated limits allow only one).
 */
import type { AstraConfig } from '@astra/config';
import {
  errorMessage,
  type AccountDefinition,
  type Clock,
  type StrategyDefinition,
} from '@astra/core';
import type { ExecutionRepository } from '@astra/db';
import { isWorking } from '@astra/execution';
import type { Bar, MarketDataService } from '@astra/market-data';
import {
  LsfvgEngine,
  LsfvgParamsSchema,
  decisionRecord,
  gateOutcome,
  toSignal,
  type DecisionRecord,
  type LsfvgCounters,
  type LsfvgEvent,
} from '@astra/strategy-lsfvg';
import type { Logger } from 'pino';
import type { DecisionService } from './decision-service';
import type { EventBus } from './event-bus';
import type { ExecutionService } from './execution-service';

export const LSFVG_ENGINE = 'lsfvg-v1';
const RECENT = 50;

export interface StrategyRunRecord {
  readonly at: string;
  readonly strategyId: string;
  readonly accountId: string | null;
  readonly decisionId: string | null;
  readonly execution: string | null;
  readonly record: DecisionRecord;
}

export interface StrategyEngineStatus {
  readonly strategyId: string;
  readonly symbol: string;
  readonly source: string | null;
  readonly lastCandle: string | null;
  readonly bias: string;
  readonly counters: LsfvgCounters;
}

interface Slot {
  readonly strategy: StrategyDefinition;
  readonly symbol: string;
  engine: LsfvgEngine;
  source: string | null;
  lastOpenMs: number;
  lastCandle: string | null;
}

/** Newly closed M5 candles in the order they are evaluated: by close time, then instrument order. */
function ordered(bars: readonly Bar[], order: readonly string[]): Bar[] {
  const rank = (s: string) => {
    const i = order.indexOf(s);
    return i === -1 ? order.length : i;
  };
  return bars
    .filter((b) => b.timeframe === 'M5' && b.complete)
    .sort(
      (a, b) =>
        Date.parse(a.closeTime) - Date.parse(b.closeTime) || rank(a.symbol) - rank(b.symbol),
    );
}

export class StrategyRunner {
  private readonly slots: Slot[] = [];
  private readonly recent: StrategyRunRecord[] = [];
  private queue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      market: MarketDataService;
      decisions: DecisionService;
      execution: ExecutionService;
      store: ExecutionRepository;
      events: EventBus;
      log: Logger;
    },
  ) {}

  get enabled(): boolean {
    return this.deps.config.system.strategyRunner?.enabled === true;
  }

  /** Strategies ASTRA runs itself (ACTIVE, engine implemented). */
  strategies(): StrategyDefinition[] {
    return [...this.deps.config.strategies.values()].filter(
      (s) => s.status === 'ACTIVE' && s.rules.engine === LSFVG_ENGINE,
    );
  }

  private accountsFor(strategy: StrategyDefinition): AccountDefinition[] {
    return [...this.deps.config.accounts.values()].filter(
      (a) => a.status === 'ACTIVE' && a.strategies.includes(strategy.id),
    );
  }

  /** Builds the engines and warms them up from the candles already held (never traded). */
  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    for (const strategy of this.strategies()) {
      const params = LsfvgParamsSchema.parse(strategy.rules.params ?? {});
      for (const symbol of strategy.instruments) {
        const spec = this.deps.config.instruments.get(symbol);
        if (!spec) continue;
        const slot: Slot = {
          strategy,
          symbol,
          engine: new LsfvgEngine(symbol, spec.tickSize, params),
          source: null,
          lastOpenMs: -Infinity,
          lastCandle: null,
        };
        this.warm(slot);
        this.slots.push(slot);
      }
    }
  }

  private warm(slot: Slot): void {
    const history = this.deps.market.bars(slot.symbol, 'M5').filter((b) => b.complete);
    for (const b of history) this.feed(slot, b); // events from history are discarded
  }

  /** Called with every batch of newly completed bars (serialised; never throws). */
  onBars(bars: readonly Bar[]): void {
    if (!this.started || this.slots.length === 0) return;
    this.queue = this.queue
      .then(() => this.process(bars))
      .catch((err: unknown) =>
        this.deps.log.error({ err: errorMessage(err) }, 'strategy runner failed on a batch'),
      );
  }

  /** Waits until every queued batch has been evaluated (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async process(bars: readonly Bar[]): Promise<void> {
    for (const strategy of this.strategies()) {
      for (const bar of ordered(bars, strategy.instruments)) {
        const slot = this.slots.find(
          (s) => s.strategy.id === strategy.id && s.symbol === bar.symbol,
        );
        if (!slot) continue;
        for (const e of this.feed(slot, bar)) await this.handle(slot, e);
      }
    }
  }

  private feed(slot: Slot, bar: Bar): LsfvgEvent[] {
    const openMs = Date.parse(bar.openTime);
    if (openMs <= slot.lastOpenMs) return [];
    if (slot.source !== null && bar.source !== slot.source) {
      // The feed changed: rebuild from the new source's candles rather than mixing sources.
      const params = slot.engine.params;
      const spec = this.deps.config.instruments.get(slot.symbol)!;
      slot.engine = new LsfvgEngine(slot.symbol, spec.tickSize, params);
      slot.source = bar.source;
      slot.lastOpenMs = -Infinity;
      this.warm(slot);
      return [];
    }
    slot.source = bar.source;
    slot.lastOpenMs = openMs;
    slot.lastCandle = bar.closeTime;
    return slot.engine.onM5(bar);
  }

  private async handle(slot: Slot, e: LsfvgEvent): Promise<void> {
    const strategy = slot.strategy;
    const { events, clock } = this.deps;
    if (e.kind === 'REJECTED') {
      const record = decisionRecord({ rejection: e.rejection });
      this.remember({
        strategyId: strategy.id,
        accountId: null,
        decisionId: null,
        execution: null,
        record,
      });
      await events.emit({
        level: 'INFO',
        component: 'strategy',
        type: 'STRATEGY_NO_TRADE',
        message: `${strategy.id} ${e.rejection.symbol} ${e.rejection.direction}: ${e.rejection.stage} — ${e.rejection.reason}`,
        data: { strategyId: strategy.id, record },
      });
      return;
    }
    if (e.kind === 'INVALIDATED') {
      const signalId = `${strategy.id}:${e.setupId}`;
      for (const o of await this.deps.store.ordersForSignal(signalId)) {
        if (!isWorking(o)) continue;
        await this.deps.execution.cancel(o.clientOrderId, `strategy:${strategy.id} (${e.reason})`);
      }
      return;
    }
    const setup = e.setup;
    const autoExecute = this.deps.config.system.strategyRunner?.autoExecute === true;
    for (const account of this.accountsFor(strategy)) {
      const candidate = {
        accountId: account.id,
        submittedAt: clock.now().toISOString(),
        signal: toSignal(setup, strategy.id),
      };
      try {
        const r = await this.deps.decisions.evaluate(candidate, {
          autoExecute,
          actor: `strategy:${strategy.id}`,
        });
        const record = decisionRecord({ setup }, gateOutcome(r.decision));
        this.remember({
          strategyId: strategy.id,
          accountId: account.id,
          decisionId: r.decision.decisionId,
          execution: r.execution
            ? `${r.execution.outcome}: ${r.execution.reasons.join('; ')}`
            : null,
          record,
        });
        await events.emit({
          level: r.decision.status === 'APPROVED' ? 'INFO' : 'WARN',
          component: 'strategy',
          type: `STRATEGY_SETUP_${r.decision.status}`,
          message: `${strategy.id} ${setup.symbol} ${setup.direction} LIMIT ${setup.entry} (stop ${setup.stop}, target ${setup.target}): ${record.DECISION}${record['REJECTION REASON'] ? ` — ${record['REJECTION REASON']}` : ''}`,
          accountId: account.id,
          data: { strategyId: strategy.id, decisionId: r.decision.decisionId, record },
        });
      } catch (err) {
        await events.emit({
          level: 'ERROR',
          component: 'strategy',
          type: 'STRATEGY_SETUP_ERROR',
          message: `${strategy.id} ${setup.symbol}: evaluation failed (${errorMessage(err)}) — no trade`,
          accountId: account.id,
          data: { strategyId: strategy.id, setupId: setup.id },
        });
      }
    }
  }

  private remember(r: Omit<StrategyRunRecord, 'at'>): void {
    this.recent.unshift({ at: this.deps.clock.now().toISOString(), ...r });
    if (this.recent.length > RECENT) this.recent.pop();
  }

  status(): { enabled: boolean; engines: StrategyEngineStatus[]; recent: StrategyRunRecord[] } {
    return {
      enabled: this.enabled,
      engines: this.slots.map((s) => ({
        strategyId: s.strategy.id,
        symbol: s.symbol,
        source: s.source,
        lastCandle: s.lastCandle,
        bias: s.engine.bias().bias,
        counters: { ...s.engine.counters },
      })),
      recent: [...this.recent],
    };
  }
}
