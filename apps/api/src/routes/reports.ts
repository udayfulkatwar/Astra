/**
 * Daily and weekly reports (Phase 7): computed by ASTRA from its records, delivered by n8n.
 * `day` is a trading-day key (YYYY-MM-DD, the firm's trading day), or `current`; by default the
 * last completed trading day. Weekly covers Monday…Sunday of the week containing that day.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const Query = z.object({
  kind: z.enum(['daily', 'weekly']).default('daily'),
  day: z.union([z.literal('current'), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
});

export function registerReportRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };

  app.get('/api/v1/reports', read, (req) => {
    const q = Query.parse(req.query);
    return runtime.reports.build(q.kind === 'daily' ? 'DAILY' : 'WEEKLY', q.day);
  });
}
