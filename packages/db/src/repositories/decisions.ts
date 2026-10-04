/**
 * Trade decisions: implements the decision gate's DecisionRecorder. The decision, its full input
 * snapshot and an audit entry are written in ONE transaction; if any part fails, nothing is
 * written and the gate turns the decision into a rejection (spec §54).
 */
import type { DecisionInputs, DecisionRecorder, TradeDecision } from '@astra/decision';
import type { Sql } from '../client';
import { iso, jsonb } from '../client';
import { appendAuditInTx } from './audit';

export interface DecisionSummary {
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly signalId: string;
  readonly symbol: string;
  readonly direction: string;
  readonly mode: string;
  readonly status: 'APPROVED' | 'REJECTED';
  readonly reasons: readonly string[];
  readonly approvalId: string | null;
  readonly approvalState: string | null;
  readonly approvalExpiresAt: string | null;
  readonly configHash: string;
}

export interface DecisionDetail extends DecisionSummary {
  readonly decision: TradeDecision;
  readonly inputs: DecisionInputs;
}

interface Row {
  id: string;
  decided_at: Date;
  account_id: string;
  strategy_id: string;
  signal_id: string;
  symbol: string;
  direction: string;
  mode: string;
  status: 'APPROVED' | 'REJECTED';
  reasons: string[];
  checks: TradeDecision['checks'];
  sizing: TradeDecision['sizing'];
  order_plan: TradeDecision['orderPlan'];
  explanation: TradeDecision['explanation'];
  config_hash: string;
  inputs: DecisionInputs;
  approval_id: string | null;
  approval_expires_at: Date | null;
  approval_state: string | null;
}

function summary(r: Row): DecisionSummary {
  return {
    decisionId: r.id,
    decidedAt: iso(r.decided_at)!,
    accountId: r.account_id,
    strategyId: r.strategy_id,
    signalId: r.signal_id,
    symbol: r.symbol,
    direction: r.direction,
    mode: r.mode,
    status: r.status,
    reasons: r.reasons,
    approvalId: r.approval_id,
    approvalState: r.approval_state,
    approvalExpiresAt: iso(r.approval_expires_at),
    configHash: r.config_hash,
  };
}

export class DecisionRepository implements DecisionRecorder {
  constructor(private readonly sql: Sql) {}

  async record(d: TradeDecision, inputs: DecisionInputs): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into trade_decisions (
          id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status,
          reasons, checks, sizing, order_plan, explanation, config_hash, inputs, workflow_run_id,
          approval_id, approval_expires_at, approval_state, approval_state_changed_at)
        values (
          ${d.decisionId}, ${d.decidedAt}, ${d.accountId}, ${d.strategyId}, ${d.signalId}, ${d.symbol},
          ${d.direction}, ${d.mode}, ${d.status}, ${jsonb(tx, d.reasons)}, ${jsonb(tx, d.checks)},
          ${jsonb(tx, d.sizing)}, ${jsonb(tx, d.orderPlan)}, ${jsonb(tx, d.explanation)}, ${d.configHash},
          ${jsonb(tx, inputs)}, ${inputs.candidate.workflowRunId ?? null},
          ${d.approval?.approvalId ?? null}, ${d.approval?.expiresAt ?? null},
          ${d.approval ? 'PENDING' : null}, ${d.approval ? d.decidedAt : null})`;
      await appendAuditInTx(tx, {
        actor: { type: 'SYSTEM', id: 'decision-engine' },
        category: 'DECISION',
        action: d.status,
        entityType: 'trade_decision',
        entityId: d.decisionId,
        payload: {
          accountId: d.accountId,
          strategyId: d.strategyId,
          signalId: d.signalId,
          symbol: d.symbol,
          direction: d.direction,
          mode: d.mode,
          reasons: d.reasons,
          failedChecks: d.checks.filter((c) => c.verdict !== 'PASS').map((c) => c.checkId),
          quantity: d.orderPlan?.quantity ?? null,
          approvalId: d.approval?.approvalId ?? null,
          configHash: d.configHash,
          workflowRunId: inputs.candidate.workflowRunId ?? null,
        },
        at: d.decidedAt,
      });
    });
  }

  async list(
    params: {
      limit?: number;
      accountId?: string;
      status?: 'APPROVED' | 'REJECTED';
      before?: string;
    } = {},
  ): Promise<DecisionSummary[]> {
    const limit = Math.min(params.limit ?? 50, 200);
    const rows = await this.sql<Row[]>`
      select id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status, reasons,
             config_hash, approval_id, approval_expires_at, approval_state
        from trade_decisions
       where (${params.accountId ?? null}::text is null or account_id = ${params.accountId ?? null})
         and (${params.status ?? null}::text is null or status = ${params.status ?? null})
         and (${params.before ?? null}::timestamptz is null or decided_at < ${params.before ?? null})
       order by decided_at desc
       limit ${limit}`;
    return rows.map(summary);
  }

  async get(decisionId: string): Promise<DecisionDetail | null> {
    const rows = await this.sql<Row[]>`select * from trade_decisions where id = ${decisionId}`;
    const r = rows[0];
    if (!r) return null;
    const decision: TradeDecision = {
      decisionId: r.id,
      accountId: r.account_id,
      strategyId: r.strategy_id,
      signalId: r.signal_id,
      symbol: r.symbol,
      direction: r.direction as TradeDecision['direction'],
      mode: r.mode as TradeDecision['mode'],
      status: r.status,
      reasons: r.reasons,
      checks: r.checks,
      sizing: r.sizing,
      orderPlan: r.order_plan,
      approval: r.approval_id
        ? { approvalId: r.approval_id, expiresAt: iso(r.approval_expires_at)! }
        : null,
      configHash: r.config_hash,
      decidedAt: iso(r.decided_at)!,
      explanation: r.explanation,
    };
    return { ...summary(r), decision, inputs: r.inputs };
  }

  /**
   * An APPROVED decision for the signal, if any. `excludeDecisionId` exempts exactly one decision
   * (the original one being revalidated) IN THE QUERY, so a row we exempt can never mask another
   * approval for the same signal that `limit 1` would otherwise not have returned.
   */
  async priorApprovedForSignal(
    accountId: string,
    signalId: string,
    excludeDecisionId: string | null = null,
  ): Promise<string | null> {
    const rows = await this.sql<{ id: string }[]>`
      select id from trade_decisions
       where account_id = ${accountId} and signal_id = ${signalId} and status = 'APPROVED'
         and (${excludeDecisionId}::text is null or id <> ${excludeDecisionId})
       order by decided_at limit 1`;
    return rows[0]?.id ?? null;
  }

  /** Marks PENDING approvals past their expiry as EXPIRED; returns how many. */
  async expireStaleApprovals(now: string): Promise<number> {
    const rows = await this.sql`
      update trade_decisions set approval_state = 'EXPIRED', approval_state_changed_at = ${now}
       where approval_state = 'PENDING' and approval_expires_at <= ${now}
      returning id`;
    return rows.length;
  }
}
