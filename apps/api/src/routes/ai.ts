/**
 * AI analysis layer (Phase 6, ADR-0020): status (routes, budget, call log), analyses of signals
 * and post-trade reviews. AI output is CONTEXT — nothing here can approve a trade or change a
 * risk parameter; review proposals are stored for a human to decide on.
 */
import { AstraError, SignalSchema } from '@astra/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const Limit = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function registerAiRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const automation = { preHandler: requireRole(auth, 'automation', 'operator') };
  const operator = { preHandler: requireRole(auth, 'operator') };

  app.get('/api/v1/ai/status', read, () => runtime.ai.status());

  app.get('/api/v1/ai/calls', read, async (req) => {
    const q = Limit.parse(req.query);
    return { calls: await runtime.repos.ai.recentCalls(q.limit) };
  });

  /** Analyse one signal now (n8n may ask ahead of submitting it). Costs one model call. */
  app.post('/api/v1/ai/analyses', automation, async (req) => {
    const { signal } = z.object({ signal: SignalSchema }).parse(req.body);
    if (!runtime.config.instruments.has(signal.symbol)) {
      throw new AstraError('VALIDATION', `instrument ${signal.symbol} is not configured`);
    }
    return { analysis: await runtime.ai.analyze(signal) };
  });

  app.get('/api/v1/ai/analyses', read, async (req) => {
    const q = Limit.parse(req.query);
    return { analyses: await runtime.repos.ai.analyses(q.limit) };
  });

  /** One analysis with the exact brief the model saw. */
  app.get('/api/v1/ai/analyses/:id', read, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const a = await runtime.repos.ai.analysisDetail(id);
    if (!a) throw new AstraError('NOT_FOUND', `analysis ${id} not found`);
    return a;
  });

  /** Post-trade review of a journaled trade (one model call). */
  app.post('/api/v1/ai/reviews', operator, async (req) => {
    const { tradeId } = z.object({ tradeId: z.string().min(1).max(200) }).parse(req.body);
    return runtime.ai.review(tradeId);
  });

  app.get('/api/v1/ai/reviews', read, async (req) => {
    const q = z
      .object({ tradeId: z.string().min(1).max(200).optional() })
      .extend(Limit.shape)
      .parse(req.query);
    return {
      reviews: q.tradeId
        ? await runtime.repos.ai.reviewsForTrade(q.tradeId)
        : await runtime.repos.ai.reviews(q.limit),
    };
  });
}
