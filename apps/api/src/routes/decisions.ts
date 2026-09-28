/** Trade Approval Center (spec §44): evaluate candidates, list and inspect decisions, execute approvals. */
import { AstraError, TradeCandidateSchema } from '@astra/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const EvaluateBody = z.object({
  candidate: TradeCandidateSchema.omit({ submittedAt: true }),
  /** Execute immediately if approved (only in configured auto-execute modes; never LIVE). */
  autoExecute: z.boolean().default(false),
});

const ListQuery = z.object({
  accountId: z.string().optional(),
  status: z.enum(['APPROVED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});

export function registerDecisionRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const submit = { preHandler: requireRole(auth, 'automation', 'operator') };
  const operator = { preHandler: requireRole(auth, 'operator') };

  app.post('/api/v1/decisions/evaluate', submit, async (req) => {
    const body = EvaluateBody.parse(req.body);
    const candidate = { ...body.candidate, submittedAt: runtime.clock.now().toISOString() };
    return runtime.decisions.evaluate(candidate, {
      autoExecute: body.autoExecute,
      actor: req.principal!.id,
    });
  });

  app.get('/api/v1/decisions', read, async (req) => {
    const q = ListQuery.parse(req.query);
    return { decisions: await runtime.repos.decisions.list(q) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/decisions/:id', read, async (req) => {
    const d = await runtime.repos.decisions.get(req.params.id);
    if (!d) throw new AstraError('NOT_FOUND', `decision ${req.params.id} not found`);
    return d;
  });

  const ExecuteBody = z.object({ approvalId: z.string().min(1).max(200) });
  app.post('/api/v1/executions', operator, async (req) => {
    const { approvalId } = ExecuteBody.parse(req.body);
    return runtime.execution.execute(approvalId, req.principal!.id);
  });

  app.post<{ Params: { clientOrderId: string } }>(
    '/api/v1/orders/:clientOrderId/cancel',
    operator,
    async (req) => runtime.execution.cancel(req.params.clientOrderId, req.principal!.id),
  );

  app.get('/api/v1/orders', read, async (req) => {
    const q = z
      .object({
        accountId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return { orders: await runtime.repos.execution.listOrders(q) };
  });
}
