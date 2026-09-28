import type { FastifyInstance } from 'fastify';
import type { TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';
import { registerAccountRoutes } from './accounts';
import { registerAutomationRoutes } from './automation';
import { registerBacktestRoutes } from './backtests';
import { registerCalendarRoutes } from './calendar';
import { registerDecisionRoutes } from './decisions';
import { registerJournalRoutes } from './journal';
import { registerLearningRoutes } from './learning';
import { registerMarketRoutes } from './market';
import { registerMonitorRoutes } from './monitor';
import { registerNewsRoutes } from './news';
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
  registerCalendarRoutes(app, runtime, auth);
  registerNewsRoutes(app, runtime, auth);
  registerMarketRoutes(app, runtime, auth);
  registerMonitorRoutes(app, runtime, auth);
  registerJournalRoutes(app, runtime, auth);
  registerBacktestRoutes(app, runtime, auth);
  registerLearningRoutes(app, runtime, auth);
}
