/** The strategies ASTRA runs itself (ADR-0024): engine state and recent §26 decision records. */
import type { FastifyInstance } from 'fastify';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

export function registerStrategyRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  app.get('/api/v1/strategies/runner', read, () => runtime.strategies.status());
}
