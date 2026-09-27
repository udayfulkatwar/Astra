import type { FastifyInstance } from 'fastify';
import type { TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';
import { registerAccountRoutes } from './accounts';
import { registerAutomationRoutes } from './automation';
import { registerDecisionRoutes } from './decisions';
import { registerMarketRoutes } from './market';
import { registerRecordRoutes } from './records';
import { registerSafetyRoutes } from './safety';
import { registerSystemRoutes } from './system';

export function registerRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  registerSystemRoutes(app, runtime, auth);
  registerSafetyRoutes(app, runtime, auth);
  registerAccountRoutes(app, runtime, auth);
  registerDecisionRoutes(app, runtime, auth);
  registerRecordRoutes(app, runtime, auth);
  registerAutomationRoutes(app, runtime, auth);
  registerMarketRoutes(app, runtime, auth);
}
