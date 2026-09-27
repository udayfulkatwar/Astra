/**
 * Market scanner and OHLC bars (Phase 2). Read-only views over the market-data service; every
 * figure is derived from observed quotes and real bars — missing data is null, never estimated.
 */
import { AstraError, SymbolSchema } from '@astra/core';
import { TimeframeSchema } from '@astra/market-data';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const BarsQuery = z.object({
  symbol: SymbolSchema,
  timeframe: TimeframeSchema,
  limit: z.coerce.number().int().min(1).max(1_000).default(300),
});

export function registerMarketRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };

  app.get('/api/v1/market/scanner', read, () => ({ snapshots: runtime.market.snapshots() }));

  app.get('/api/v1/market/bars', read, (req) => {
    const q = BarsQuery.parse(req.query);
    if (!runtime.config.instruments.has(q.symbol)) {
      throw new AstraError('NOT_FOUND', `instrument ${q.symbol} is not configured`);
    }
    return { bars: runtime.market.bars(q.symbol, q.timeframe, q.limit) };
  });
}
