/**
 * n8n integration endpoints (ADR-0005): heartbeats, workflow errors, and DATA ingestion.
 * Ingested data is labelled sourceKind MANUAL: acceptable in PAPER, refused in SHADOW/LIVE
 * (which require first-class LIVE adapters, Phase 2/4).
 */
import { QuoteSchema } from '@astra/core';
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
    let accepted = 0;
    const ignored: { symbol: string; reason: string }[] = [];
    for (const q of b.quotes) {
      // Unknown instruments and invalid quotes throw (400); out-of-order ones are ignored.
      const r = runtime.market.ingest(q, `ingest:${b.source}`, 'MANUAL');
      if (r.status === 'ACCEPTED') accepted++;
      else ignored.push({ symbol: r.symbol, reason: r.reason });
    }
    return { accepted, ignored };
  });
  app.get('/api/v1/market/quotes', read, () => ({ quotes: runtime.market.all() }));
}
