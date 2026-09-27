/** Accounts: definitions, live state, and history. Broker credential references are not exposed. */
import { AstraError } from '@astra/core';
import type { FastifyInstance } from 'fastify';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AccountView } from '../runtime/account-service';
import type { AstraRuntime } from '../runtime/runtime';

function publicView(v: AccountView) {
  const { credentialsEnv: _hidden, ...broker } = v.account.broker;
  return { ...v, account: { ...v.account, broker } };
}

export function registerAccountRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };

  app.get('/api/v1/accounts', read, () => ({ accounts: runtime.accounts.views().map(publicView) }));

  app.get<{ Params: { id: string } }>('/api/v1/accounts/:id', read, async (req) => {
    const view = runtime.accounts.view(req.params.id);
    if (!view) throw new AstraError('NOT_FOUND', `account ${req.params.id} not found`);
    const [closedTrades, orders] = await Promise.all([
      runtime.repos.accounts.closedTrades(req.params.id, 20),
      runtime.repos.execution.listOrders({ accountId: req.params.id, limit: 20 }),
    ]);
    return { ...publicView(view), closedTrades, orders };
  });
}
