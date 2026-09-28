/** AI call log, analyses and post-trade reviews (all append-only, ADR-0020). */
import type { AiCallRecord, AiTradeReview, AiUsage } from '@astra/ai';
import type { AiAnalysis, DataSourceKind } from '@astra/core';
import type { Sql } from '../client';
import { iso, jsonb } from '../client';

interface CallRow {
  call_id: string;
  task: AiCallRecord['task'];
  subject_id: string;
  provider: string;
  provider_kind: DataSourceKind | null;
  model: string;
  served_model: string | null;
  status: AiCallRecord['status'];
  blocked_by: AiCallRecord['blockedBy'];
  started_at: Date;
  latency_ms: number;
  usage: AiUsage | null;
  cost_usd: string;
  cost_estimated: boolean;
  fallback_used: boolean;
  error: string | null;
}

const call = (r: CallRow): AiCallRecord => ({
  callId: r.call_id,
  task: r.task,
  subjectId: r.subject_id,
  provider: r.provider,
  providerKind: r.provider_kind,
  model: r.model,
  servedModel: r.served_model,
  status: r.status,
  blockedBy: r.blocked_by,
  startedAt: iso(r.started_at)!,
  latencyMs: r.latency_ms,
  usage: r.usage,
  costUsd: Number(r.cost_usd) + 0,
  costEstimated: r.cost_estimated,
  fallbackUsed: r.fallback_used,
  error: r.error,
});

export interface StoredAiAnalysis {
  readonly analysis: AiAnalysis;
  readonly signalKey: string;
  readonly callId: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
}

export class AiRepository {
  constructor(private readonly sql: Sql) {}

  async recordCall(c: AiCallRecord): Promise<void> {
    await this.sql`
      insert into ai_model_calls
        (call_id, task, subject_id, provider, provider_kind, model, served_model, status,
         blocked_by, started_at, latency_ms, usage, cost_usd, cost_estimated, fallback_used, error)
      values (${c.callId}, ${c.task}, ${c.subjectId}, ${c.provider}, ${c.providerKind}, ${c.model},
        ${c.servedModel}, ${c.status}, ${c.blockedBy}, ${c.startedAt}, ${c.latencyMs},
        ${jsonb(this.sql, c.usage)}, ${c.costUsd}, ${c.costEstimated}, ${c.fallbackUsed},
        ${c.error})`;
  }

  /** Newest first. */
  async recentCalls(limit = 50): Promise<AiCallRecord[]> {
    const rows = await this.sql<CallRow[]>`
      select * from ai_model_calls order by started_at desc, call_id desc limit ${limit}`;
    return rows.map(call);
  }

  /** Calls actually sent (not BLOCKED) since `since`, and what they cost. */
  async usageSince(since: string): Promise<{ calls: number; costUsd: number }> {
    const [row] = await this.sql<{ calls: number; cost: string | null }[]>`
      select count(*)::int as calls, sum(cost_usd) as cost from ai_model_calls
       where started_at >= ${since} and status <> 'BLOCKED'`;
    return { calls: row?.calls ?? 0, costUsd: Number(row?.cost ?? 0) + 0 };
  }

  async recordAnalysis(a: StoredAiAnalysis & { brief: unknown }): Promise<void> {
    await this.sql`
      insert into ai_analyses
        (analysis_id, signal_id, signal_key, call_id, source, source_kind, produced_at, analysis,
         brief)
      values (${a.analysis.analysisId}, ${a.analysis.signalId}, ${a.signalKey}, ${a.callId},
        ${a.source}, ${a.sourceKind}, ${a.analysis.producedAt}, ${jsonb(this.sql, a.analysis)},
        ${jsonb(this.sql, a.brief)})`;
  }

  /** The newest analysis for exactly this signal (id and levels), or null. */
  async latestAnalysis(signalKey: string): Promise<StoredAiAnalysis | null> {
    const rows = await this.sql<Row[]>`
      select analysis, signal_key, call_id, source, source_kind from ai_analyses
       where signal_key = ${signalKey} order by produced_at desc limit 1`;
    return rows[0] ? stored(rows[0]) : null;
  }

  /** Newest first, without the briefs. */
  async analyses(limit = 50): Promise<StoredAiAnalysis[]> {
    const rows = await this.sql<Row[]>`
      select analysis, signal_key, call_id, source, source_kind from ai_analyses
       order by produced_at desc, analysis_id desc limit ${limit}`;
    return rows.map(stored);
  }

  /** One analysis with the brief the model saw. */
  async analysisDetail(
    analysisId: string,
  ): Promise<(StoredAiAnalysis & { brief: unknown }) | null> {
    const rows = await this.sql<(Row & { brief: unknown })[]>`
      select analysis, signal_key, call_id, source, source_kind, brief from ai_analyses
       where analysis_id = ${analysisId}`;
    return rows[0] ? { ...stored(rows[0]), brief: rows[0].brief } : null;
  }

  async recordReview(r: AiTradeReview, callId: string): Promise<void> {
    await this.sql`
      insert into ai_reviews (review_id, trade_id, call_id, produced_at, review)
      values (${r.reviewId}, ${r.tradeId}, ${callId}, ${r.producedAt}, ${jsonb(this.sql, r)})`;
  }

  /** Newest first. */
  async reviews(limit = 50): Promise<AiTradeReview[]> {
    const rows = await this.sql<{ review: AiTradeReview }[]>`
      select review from ai_reviews order by produced_at desc, review_id desc limit ${limit}`;
    return rows.map((r) => r.review);
  }

  async reviewsForTrade(tradeId: string): Promise<AiTradeReview[]> {
    const rows = await this.sql<{ review: AiTradeReview }[]>`
      select review from ai_reviews where trade_id = ${tradeId} order by produced_at desc`;
    return rows.map((r) => r.review);
  }
}

interface Row {
  analysis: AiAnalysis;
  signal_key: string;
  call_id: string;
  source: string;
  source_kind: DataSourceKind;
}

const stored = (r: Row): StoredAiAnalysis => ({
  analysis: r.analysis,
  signalKey: r.signal_key,
  callId: r.call_id,
  source: r.source,
  sourceKind: r.source_kind,
});
