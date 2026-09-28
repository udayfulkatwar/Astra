/**
 * Decision orchestration: assemble inputs → decide → persist (or reject) → publish → optional
 * auto-execution. For a strategy that requires AI analysis, the deterministic checks run first;
 * the (slow, paid) model is asked only when nothing else already rejects the candidate, and the
 * gate then decides on freshly assembled data plus the stored analysis.
 */
import {
  errorMessage,
  notObserved,
  observed,
  type AiAnalysis,
  type Clock,
  type Observed,
  type TradeCandidate,
} from '@astra/core';
import { decisionConfigView, type AstraConfig } from '@astra/config';
import type { DecisionRepository, ExecutionRepository } from '@astra/db';
import {
  DecisionEngine,
  assembleDecisionInputs,
  decideAndRecord,
  type DecisionDataPorts,
  type DecisionInputs,
  type TradeDecision,
} from '@astra/decision';
import type { ExecutionResult } from '@astra/execution';
import type { MarketDataService } from '@astra/market-data';
import type { AccountService } from './account-service';
import type { AiService } from './ai-service';
import type { CalendarService } from '@astra/calendar';
import type { NewsService } from '@astra/news';
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
      news: NewsService;
      ai: AiService;
      accounts: AccountService;
      decisions: DecisionRepository;
      executionStore: ExecutionRepository;
      execution: ExecutionService;
      events: EventBus;
      liveTradingEnvironmentAuthorized: boolean;
    },
  ) {}

  private dataPorts(ai?: Observed<AiAnalysis>): DecisionDataPorts {
    const { market, accounts, calendar, news, decisions, executionStore, clock } = this.deps;
    return {
      quote: (symbol) => Promise.resolve(market.latest(symbol)),
      accountSnapshot: (id) => Promise.resolve(accounts.snapshot(id)),
      tracking: (id) => Promise.resolve(accounts.tracking(id)),
      activity: (id) => accounts.activity(id),
      calendar: () => Promise.resolve(calendar.current()),
      newsRisk: (symbol) => Promise.resolve(news.risk(symbol)),
      aiAnalysis: (candidate) =>
        ai ? Promise.resolve(ai) : this.deps.ai.analysisFor(candidate.signal),
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
    const { config, execution, events } = this.deps;
    const inputs = config.strategies.get(candidate.signal.strategyId)?.requiresAiAnalysis
      ? await this.withAiAnalysis(candidate)
      : await this.assemble(candidate);
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

  private assemble(candidate: TradeCandidate, ai?: Observed<AiAnalysis>): Promise<DecisionInputs> {
    const { config, clock, mode, killSwitches, health, execution } = this.deps;
    return assembleDecisionInputs({
      candidate,
      config: decisionConfigView(config),
      data: this.dataPorts(ai),
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
  }

  /** Deterministic checks first; the model only when they would all pass. */
  private async withAiAnalysis(candidate: TradeCandidate): Promise<DecisionInputs> {
    const pre = await this.assemble(
      candidate,
      notObserved('UNAVAILABLE', 'AI analysis pending', 'ai'),
    );
    const blocking = this.engine
      .evaluate(pre)
      .checks.filter((c) => c.mandatory && c.verdict !== 'PASS' && c.checkId !== 'ai.analysis');
    if (blocking.length > 0) {
      return {
        ...pre,
        aiAnalysis: notObserved(
          'UNAVAILABLE',
          'not requested: other checks already reject this candidate',
          'ai',
        ),
      };
    }
    await this.deps.ai.ensureAnalysis(candidate.signal);
    // Re-assembled: quotes, account and news are judged fresh at the moment of decision.
    return this.assemble(candidate);
  }
}
