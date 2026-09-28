import type { AiCallRecord, AiTradeReview } from '@astra/ai';
import type { AiAnalysis } from '@astra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiRepository } from '../src/repositories/ai';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();

const call = (id: string, o: Partial<AiCallRecord> = {}): AiCallRecord => ({
  callId: id,
  task: 'TRADE_ANALYSIS',
  subjectId: 'sig_1',
  provider: 'anthropic',
  providerKind: 'LIVE',
  model: 'claude-opus-5',
  servedModel: 'claude-opus-5',
  status: 'OK',
  blockedBy: null,
  startedAt: '2026-09-28T14:00:00.000Z',
  latencyMs: 4200,
  usage: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 1000, cacheWriteTokens: 0 },
  costUsd: 0.023,
  costEstimated: false,
  fallbackUsed: false,
  error: null,
  ...o,
});

const analysis: AiAnalysis = {
  analysisId: 'aia_1',
  signalId: 'sig_1',
  model: 'claude-opus-5',
  producedAt: '2026-09-28T14:00:04.200Z',
  verdict: 'SUPPORTS',
  confidence: 0.7,
  setupQuality: 66,
  eventRisk: 'LOW',
  reasons: ['Trend agrees.'],
  invalidation: [],
};

describe.skipIf(!available)('AI repository', () => {
  let db: TestDb;
  let repo: AiRepository;
  beforeAll(async () => {
    db = await createTestDb();
    repo = new AiRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('logs calls append-only and sums today’s sent calls', async () => {
    await repo.recordCall(call('aic_1'));
    await repo.recordCall(
      call('aic_2', {
        status: 'BLOCKED',
        blockedBy: 'BUDGET',
        servedModel: null,
        usage: null,
        costUsd: 0,
        error: 'limit',
        startedAt: '2026-09-28T15:00:00.000Z',
      }),
    );
    await repo.recordCall(call('aic_0', { startedAt: '2026-09-27T23:00:00.000Z', costUsd: 1 }));
    expect(await repo.usageSince('2026-09-28T00:00:00.000Z')).toEqual({ calls: 1, costUsd: 0.023 });
    const recent = await repo.recentCalls(2);
    expect(recent.map((c) => c.callId)).toEqual(['aic_2', 'aic_1']);
    expect(recent[1]).toEqual(call('aic_1'));
    await expect(db.sql`update ai_model_calls set status = 'OK'`).rejects.toThrow(/append-only/);
  });

  it('stores analyses with their brief and reviews with their proposals', async () => {
    await repo.recordAnalysis({
      analysis,
      signalKey: 'sig_1|LONG|18000|17990|18030',
      callId: 'aic_1',
      source: 'ai:anthropic/claude-opus-5',
      sourceKind: 'LIVE',
      brief: { briefVersion: 1 },
    });
    expect(await repo.latestAnalysis('sig_1|LONG|18000|17990|18030')).toMatchObject({
      analysis,
      callId: 'aic_1',
      sourceKind: 'LIVE',
    });
    expect(await repo.latestAnalysis('sig_1|LONG|18000|17980|18030')).toBeNull();
    expect((await repo.analysisDetail('aia_1'))?.brief).toEqual({ briefVersion: 1 });
    expect(await repo.analyses()).toHaveLength(1);

    const review = {
      reviewId: 'air_1',
      tradeId: 'trd_1',
      producedAt: '2026-09-28T16:00:00.000Z',
      classification: 'GOOD_LOSS',
      proposals: [{ parameter: 'p', suggestion: 's', rationale: 'r', status: 'PROPOSED' }],
    } as unknown as AiTradeReview;
    await repo.recordReview(review, 'aic_1');
    expect(await repo.reviewsForTrade('trd_1')).toEqual([review]);
    expect(await repo.reviews()).toEqual([review]);
  });
});
