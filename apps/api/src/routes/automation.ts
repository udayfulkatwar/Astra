/**
 * n8n integration endpoints (ADR-0005): heartbeats, workflow errors, and DATA ingestion.
 * Ingested data is labelled sourceKind MANUAL: acceptable in PAPER, refused in SHADOW/LIVE
 * (which require first-class LIVE adapters, Phase 2/4).
 */
import { CalendarWindowSchema, QuoteSchema } from '@astra/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

export function registerAutomationRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const automation = { preHandler: requireRole(auth, 'automation', 'operator') };

  const Heartbeat = z.object({
    status: z.enum(['ONLINE', 'DEGRADED', 'ERROR']).default('ONLINE'),
    detail: z.string().max(500).default('heartbeat'),
    workflowRunId: z.string().max(200).optional(),
  });
  app.post('/api/v1/automation/heartbeat', automation, async (req) => {
    const b = Heartbeat.parse(req.body ?? {});
    const at = runtime.clock.now().toISOString();
    runtime.health.report('AUTOMATION', b.status, b.detail);
    await runtime.repos.heartbeats.upsert({
      component: 'AUTOMATION',
      status: b.status,
      detail: b.detail,
      reportedAt: at,
      reportedBy: req.principal!.id,
    });
    return { received: at };
  });

  const WorkflowError = z.object({
    workflow: z.string().min(1).max(200),
    error: z.string().min(1).max(4000),
    workflowRunId: z.string().max(200).optional(),
  });
  app.post('/api/v1/automation/errors', automation, async (req) => {
    const b = WorkflowError.parse(req.body);
    await runtime.events.emit({
      level: 'ERROR',
      component: 'automation',
      type: 'WORKFLOW_ERROR',
      message: `n8n workflow "${b.workflow}" failed: ${b.error}`,
      data: { workflowRunId: b.workflowRunId ?? null },
    });
    return { recorded: true };
  });

  const Quotes = z.object({
    source: z.string().min(1).max(100),
    quotes: z.array(QuoteSchema).min(1).max(500),
  });
  app.post('/api/v1/market/quotes', automation, (req) => {
    const b = Quotes.parse(req.body);
    for (const q of b.quotes) runtime.market.ingest(q, `ingest:${b.source}`, 'MANUAL');
    return { accepted: b.quotes.length };
  });
  app.get('/api/v1/market/quotes', read, () => ({ quotes: runtime.market.all() }));

  const Calendar = z.object({ source: z.string().min(1).max(100), window: CalendarWindowSchema });
  app.post('/api/v1/calendar/window', automation, (req) => {
    const b = Calendar.parse(req.body);
    runtime.calendar.ingest(
      b.window,
      `ingest:${b.source}`,
      'MANUAL',
      runtime.clock.now().toISOString(),
    );
    return { accepted: b.window.events.length };
  });
  app.get('/api/v1/calendar/upcoming', read, (req) => {
    const q = z
      .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
      .parse(req.query);
    const now = runtime.clock.now();
    const w = runtime.calendar.upcoming(
      new Date(now.getTime() - 3_600_000),
      new Date(now.getTime() + q.hours * 3_600_000),
    );
    return w.status === 'OK' ? w : { ...w, value: null };
  });
}
