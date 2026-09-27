/**
 * Market scanner, OHLC bars (Phase 2) and market structure (Phase 5 groundwork). Read-only views over the market-data service; every
 * figure is derived from observed quotes and real bars — missing data is null, never estimated.
 */
import { AstraError, SymbolSchema } from '@astra/core';
import { TimeframeSchema } from '@astra/market-data';
import { analyzeStructure } from '@astra/market-structure';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const StructureQuery = z.object({
  symbol: SymbolSchema.optional(),
  timeframe: TimeframeSchema.default('H1'),
});

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

  // Structure of complete bars only (swings, BOS/CHoCH, liquidity, gaps — ADR-0010).
  app.get('/api/v1/market/structure', read, (req) => {
    const q = StructureQuery.parse(req.query);
    const symbols = q.symbol === undefined ? [...runtime.config.instruments.keys()] : [q.symbol];
    return {
      structures: symbols.map((symbol) => {
        const instrument = runtime.config.instruments.get(symbol);
        if (!instrument)
          throw new AstraError('NOT_FOUND', `instrument ${symbol} is not configured`);
        return analyzeStructure({
          symbol,
          timeframe: q.timeframe,
          bars: runtime.market.bars(symbol, q.timeframe),
          tickSize: instrument.tickSize,
          params: runtime.config.system.structure,
        });
      }),
    };
  });

  app.get('/api/v1/market/bars', read, (req) => {
    const q = BarsQuery.parse(req.query);
    if (!runtime.config.instruments.has(q.symbol)) {
      throw new AstraError('NOT_FOUND', `instrument ${q.symbol} is not configured`);
    }
    return { bars: runtime.market.bars(q.symbol, q.timeframe, q.limit) };
  });
}
