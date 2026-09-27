/** Audit log, activity events and the live SSE stream (spec §22, §68). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

export function registerRecordRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const operator = { preHandler: requireRole(auth, 'operator') };

  app.get('/api/v1/audit', read, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        beforeSeq: z.coerce.number().int().positive().optional(),
        category: z.string().max(50).optional(),
        entityId: z.string().max(200).optional(),
      })
      .parse(req.query);
    return { entries: await runtime.repos.audit.list(q) };
  });

  app.get('/api/v1/audit/verify', operator, async () => runtime.repos.audit.verifyChain());

  app.get('/api/v1/events', read, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        afterSeq: z.coerce.number().int().optional(),
      })
      .parse(req.query);
    return { events: await runtime.repos.events.recent(q) };
  });

  // Server-Sent Events. Browsers use fetch() streaming (EventSource cannot send auth headers).
  app.get('/api/v1/stream', read, (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = runtime.events.subscribe((e) => {
      reply.raw.write(`event: system-event\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
    keepAlive.unref();
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
}
