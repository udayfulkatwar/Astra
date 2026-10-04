/**
 * Pre-submit validation wiring (ADR-0027). Just before an entry is reserved, the ORIGINAL
 * candidate stored with the approved decision is run through the real assembler and Decision
 * Engine on fresh inputs: a fresh executable quote, the broker snapshot the gateway just read
 * (plus every reserved exposure), tracking advanced from THAT snapshot, live activity, calendar,
 * news, readiness and the stored (never re-requested) AI analysis. No paid AI call is made here.
 */
import type { CalendarService } from '@astra/calendar';
import { decisionConfigView, type AstraConfig } from '@astra/config';
import {
  notObserved,
  observed,
  errorMessage,
  type AccountDefinition,
  type Clock,
} from '@astra/core';
import type { DecisionRepository, ExecutionRepository } from '@astra/db';
import {
  DecisionEngine,
  revalidateApprovedEntry,
  type DecisionDataPorts,
  type EntryRevalidation,
  type ExecutionReadiness,
} from '@astra/decision';
import type { EntryRevalidationRequest } from '@astra/execution';
import type { MarketDataService } from '@astra/market-data';
import type { NewsService } from '@astra/news';
import type { AccountService } from './account-service';
import type { AiService } from './ai-service';
import type { HealthService } from './health-service';
import type { KillSwitchService } from './kill-switch-service';
import type { ModeService } from './mode-service';

export class PreSubmitValidator {
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
      readiness: (account: AccountDefinition | null) => ExecutionReadiness;
      liveTradingEnvironmentAuthorized: boolean;
    },
  ) {}

  async revalidate(req: EntryRevalidationRequest): Promise<EntryRevalidation> {
    const { config, clock, decisions } = this.deps;
    const { approval, snapshot } = req;
    const refuse = (reason: string): EntryRevalidation => ({
      ok: false,
      reasons: [`[revalidation] ${reason}`],
    });
    try {
      const detail = await decisions.get(approval.decisionId);
      if (!detail || detail.status !== 'APPROVED' || detail.approvalId !== approval.approvalId)
        return refuse(`the original approved decision ${approval.decisionId} cannot be loaded`);
      const account = config.accounts.get(approval.accountId) ?? null;
      const kind = this.deps.readiness(account).adapterKind === 'PAPER' ? 'SIMULATED' : 'LIVE';
      const meta = { source: 'broker', sourceKind: kind, asOf: snapshot.asOf } as const;
      const candidate = detail.inputs.candidate;
      const data: DecisionDataPorts = {
        quote: (symbol) => Promise.resolve(this.deps.market.latest(symbol)),
        accountSnapshot: () => Promise.resolve(observed(snapshot, meta)),
        tracking: (id) => this.deps.accounts.freshTracking(id, snapshot, kind),
        activity: (id) => this.deps.accounts.activity(id),
        calendar: () => Promise.resolve(this.deps.calendar.current()),
        newsRisk: (symbol) => Promise.resolve(this.deps.news.risk(symbol)),
        // Stored analysis only: validity/freshness is judged by the gate's own AI check.
        aiAnalysis: (c) => this.deps.ai.analysisFor(c.signal),
        duplicates: async (accountId, signalId, symbol) => {
          try {
            const [prior, working] = await Promise.all([
              // Exempts exactly the original decision, in the query.
              decisions.priorApprovedForSignal(accountId, signalId, approval.decisionId),
              this.deps.executionStore
                .workingOrders(accountId, symbol)
                .then((o) => o.filter((x) => x.clientOrderId !== req.ownClientOrderId)),
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
      return await revalidateApprovedEntry({
        engine: this.engine,
        candidate,
        plan: approval.orderPlan,
        originalConfigHash: detail.configHash,
        assemble: {
          config: decisionConfigView(config),
          data,
          state: {
            mode: () => this.deps.mode.current(),
            killSwitches: (ctx) => this.deps.killSwitches.evaluate(ctx),
            componentHealth: () => this.deps.health.registry.snapshot(),
            execution: (a) => this.deps.readiness(a),
            liveTradingEnvironmentAuthorized: () => this.deps.liveTradingEnvironmentAuthorized,
          },
          clock,
          timeoutMs: config.system.assembler.providerTimeoutMs,
        },
      });
    } catch (err) {
      return refuse(`failed: ${errorMessage(err)}`);
    }
  }
}
