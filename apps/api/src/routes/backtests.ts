/**
 * Backtests (ADR-0016): run a replay (operator), list runs and read a run's full result. Runs
 * never trade, never change the mode, accounts or kill switches; results are stored as produced.
 */
import { AstraError } from '@astra/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

export function registerBacktestRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const operate = { preHandler: requireRole(auth, 'operator') };

  app.post('/api/v1/backtests', operate, async (req) =>
    runtime.backtests.run(req.body, req.principal!.id),
  );

  app.get('/api/v1/backtests', read, async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return {
      runs: await runtime.repos.backtests.list(q.limit),
      running: runtime.backtests.isRunning(),
    };
  });

  app.get('/api/v1/backtests/:runId', read, async (req) => {
    const { runId } = z.object({ runId: z.string().min(1).max(100) }).parse(req.params);
    const run = await runtime.repos.backtests.get(runId);
    if (!run) throw new AstraError('NOT_FOUND', `backtest ${runId} not found`);
    return run;
  });
}
