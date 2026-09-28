/**
 * Learning metrics (Phase 8, ADR-0018): what recorded trades say — from the trade journal or
 * from one backtest run — broken down by strategy, instrument, session, time, setup and event
 * context. Read-only; observations never change configuration.
 */
import {
  AstraError,
  SlugSchema,
  SymbolSchema,
  TimeZoneSchema,
  TradingModeSchema,
} from '@astra/core';
import { learningReport } from '@astra/learning';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const Query = z.object({
  source: z.enum(['journal', 'backtest']).default('journal'),
  runId: z.string().min(1).max(100).optional(),
  accountId: SlugSchema.optional(),
  strategyId: SlugSchema.optional(),
  symbol: SymbolSchema.optional(),
  mode: TradingModeSchema.optional(),
  timeZone: TimeZoneSchema.default('UTC'),
  minSample: z.coerce.number().int().min(5).max(500).default(30),
});

export function registerLearningRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };

  /** Journal: the most recent 5,000 matching trades. Backtest: every trade of the run. */
  app.get('/api/v1/learning', read, async (req) => {
    const q = Query.parse(req.query);
    let entries;
    let label: string;
    if (q.source === 'backtest') {
      if (!q.runId) throw new AstraError('VALIDATION', 'runId is required for source=backtest');
      const run = await runtime.repos.backtests.get(q.runId);
      if (!run) throw new AstraError('NOT_FOUND', `backtest ${q.runId} not found`);
      entries = run.result.trades;
      label = `Backtest ${run.runId}: ${run.result.label}`;
    } else {
      entries = (
        await runtime.repos.journal.list({
          accountId: q.accountId,
          strategyId: q.strategyId,
          symbol: q.symbol,
          limit: 5_000,
        })
      ).filter((e) => !q.mode || e.mode === q.mode);
      label = 'Trade journal (recorded trades)';
    }
    return {
      source: { kind: q.source, runId: q.runId ?? null, label },
      ...learningReport(entries, {
        timeZone: q.timeZone,
        sessions: runtime.config.system.sessions,
        minSample: q.minSample,
      }),
    };
  });
}
