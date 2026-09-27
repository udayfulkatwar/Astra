/** Human override controls (spec §76): kill switches. */
import type { FastifyInstance } from 'fastify';
import { KILL_SWITCH_SCOPES } from '@astra/safety';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const Target = z.object({
  scope: z.enum(KILL_SWITCH_SCOPES),
  target: z.string().min(1).max(100).nullable().default(null),
  reason: z.string().min(3).max(500),
});

export function registerSafetyRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const operator = { preHandler: requireRole(auth, 'operator') };

  app.get('/api/v1/kill-switches', read, () => ({
    loaded: runtime.killSwitches.registry.isLoaded(),
    switches: runtime.killSwitches.list(),
  }));

  app.post('/api/v1/kill-switches/activate', operator, async (req) => {
    const body = Target.parse(req.body);
    return runtime.killSwitches.activate({
      ...body,
      actor: { type: 'HUMAN', id: req.principal!.id },
    });
  });

  app.post('/api/v1/kill-switches/deactivate', operator, async (req) => {
    const body = Target.parse(req.body);
    return {
      state: await runtime.killSwitches.deactivate({
        ...body,
        actor: { type: 'HUMAN', id: req.principal!.id },
      }),
    };
  });
}
