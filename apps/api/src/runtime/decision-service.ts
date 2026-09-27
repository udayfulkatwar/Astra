/** Decision orchestration: assemble inputs → decide → persist (or reject) → publish → optional auto-execution. */
import { errorMessage, notObserved, observed, type Clock, type TradeCandidate } from '@astra/core';
import { decisionConfigView, type AstraConfig } from '@astra/config';
import type { DecisionRepository, ExecutionRepository } from '@astra/db';
import {
  DecisionEngine,
  assembleDecisionInputs,
  decideAndRecord,
  type DecisionDataPorts,
  type TradeDecision,
} from '@astra/decision';
import type { ExecutionResult } from '@astra/execution';
import type { MarketDataService } from '@astra/market-data';
import type { AccountService } from './account-service';
import type { CalendarService } from './calendar';
import type { EventBus } from './event-bus';
import type { ExecutionService } from './execution-service';
import type { HealthService } from './health-service';
import type { KillSwitchService } from './kill-switch-service';
import type { ModeService } from './mode-service';

export interface EvaluationResult {
  readonly decision: TradeDecision;
  readonly persisted: boolean;
  readonly execution: ExecutionResult | null;
}

export class DecisionService {
  private readonly engine = new DecisionEngine();

  constructor(
    private readonly deps: {
      config: AstraConfig;
      clock: Clock;
      mode: ModeService;
      killSwitches: KillSwitchService;
      health: HealthService;
      market: MarketDataService;
      calendar: CalendarService;
      accounts: AccountService;
      decisions: DecisionRepository;
      executionStore: ExecutionRepository;
      execution: ExecutionService;
      events: EventBus;
      liveTradingEnvironmentAuthorized: boolean;
    },
  ) {}

  private dataPorts(): DecisionDataPorts {
    const { market, accounts, calendar, decisions, executionStore, clock } = this.deps;
    return {
      quote: (symbol) => Promise.resolve(market.latest(symbol)),
      accountSnapshot: (id) => Promise.resolve(accounts.snapshot(id)),
      tracking: (id) => Promise.resolve(accounts.tracking(id)),
      activity: (id) => accounts.activity(id),
      calendar: () => Promise.resolve(calendar.current()),
      // Phase 4 / Phase 6 engines are not built yet: report that honestly.
      newsRisk: () =>
        Promise.resolve(
          notObserved('UNAVAILABLE', 'news engine not implemented yet (Phase 4)', 'news'),
        ),
      aiAnalysis: () =>
        Promise.resolve(
          notObserved('UNAVAILABLE', 'AI engine not implemented yet (Phase 6)', 'ai'),
        ),
      duplicates: async (accountId, signalId, symbol) => {
        try {
          const [prior, working] = await Promise.all([
            decisions.priorApprovedForSignal(accountId, signalId),
            executionStore.workingOrders(accountId, symbol),
          ]);
          return observed(
            { priorApprovedDecisionId: prior, workingOrderForSymbol: working.length > 0 },
            { source: 'astra-db', sourceKind: 'LIVE', asOf: clock.now().toISOString() },
          );
        } catch (err) {
          return notObserved('ERROR', errorMessage(err), 'astra-db');
        }
      },
    };
  }

  async evaluate(
    candidate: TradeCandidate,
    opts: { autoExecute: boolean; actor: string },
  ): Promise<EvaluationResult> {
    const { config, clock, mode, killSwitches, health, execution, events } = this.deps;
    const inputs = await assembleDecisionInputs({
      candidate,
      config: decisionConfigView(config),
      data: this.dataPorts(),
      state: {
        mode: () => mode.current(),
        killSwitches: (ctx) => killSwitches.evaluate(ctx),
        componentHealth: () => health.registry.snapshot(),
        execution: (account) => execution.readiness(account),
        liveTradingEnvironmentAuthorized: () => this.deps.liveTradingEnvironmentAuthorized,
      },
      clock,
      timeoutMs: config.system.assembler.providerTimeoutMs,
    });
    const recorded = await decideAndRecord(this.engine, inputs, this.deps.decisions);
    const d = recorded.decision;
    await events.emit({
      level: recorded.persisted ? (d.status === 'APPROVED' ? 'INFO' : 'WARN') : 'ERROR',
      component: 'decision-engine',
      type: `DECISION_${d.status}`,
      message:
        d.status === 'APPROVED'
          ? `${d.symbol} ${d.direction} approved: ${d.orderPlan?.quantity} @ ~${d.orderPlan?.entry} (${d.mode})`
          : `${d.symbol} ${d.direction} rejected: ${d.reasons.slice(0, 3).join(' | ')}${d.reasons.length > 3 ? ` (+${d.reasons.length - 3} more)` : ''}`,
      accountId: d.accountId,
      data: { decisionId: d.decisionId, signalId: d.signalId, persisted: recorded.persisted },
    });

    let exec: ExecutionResult | null = null;
    if (opts.autoExecute && d.status === 'APPROVED' && d.approval) {
      const allowed = (config.system.execution.autoExecuteModes as string[]).includes(d.mode);
      if (allowed) exec = await execution.execute(d.approval.approvalId, opts.actor);
    }
    return { decision: d, persisted: recorded.persisted, execution: exec };
  }
}
