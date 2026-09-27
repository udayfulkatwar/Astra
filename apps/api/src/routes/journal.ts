/** Trade journal (Phase 8): recorded trades and descriptive statistics. Read-only. */
import { SlugSchema, SymbolSchema } from '@astra/core';
import { journalSummary } from '@astra/journal';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const Filter = z.object({
  accountId: SlugSchema.optional(),
  strategyId: SlugSchema.optional(),
  symbol: SymbolSchema.optional(),
});

export function registerJournalRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };

  app.get('/api/v1/journal', read, async (req) => {
    const q = Filter.extend({
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    return { entries: await runtime.repos.journal.list(q) };
  });

  /** Statistics over the most recent 5,000 matching trades (n is always reported). */
  app.get('/api/v1/journal/summary', read, async (req) => {
    const q = Filter.parse(req.query);
    const entries = await runtime.repos.journal.list({ ...q, limit: 5_000 });
    return journalSummary(entries);
  });
}
