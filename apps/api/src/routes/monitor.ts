/** Position monitor (Phase 8): live positions, limit buffers and active alerts. Read-only. */
import type { FastifyInstance } from 'fastify';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

export function registerMonitorRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  app.get('/api/v1/monitor/positions', read, () => runtime.monitor.snapshot());
}
