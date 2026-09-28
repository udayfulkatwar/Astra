/**
 * News intelligence (Phase 4, ADR-0019): push ingestion for n8n, the classified feed, and the
 * news context per instrument (news risk as the gate sees it, provider sentiment, calendar
 * blackout, combined context). Pushed items are labelled MANUAL: acceptable in PAPER, refused
 * in SHADOW/LIVE.
 */
import { eventRiskView } from '@astra/calendar';
import { SymbolSchema } from '@astra/core';
import { mergedBlackout } from '@astra/decision';
import { NEWS_CATEGORIES, NEWS_IMPACTS, newsContextView } from '@astra/news';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const Push = z.object({
  source: z.string().min(1).max(100),
  items: z.array(z.unknown()).max(5_000),
});

export function registerNewsRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const automation = { preHandler: requireRole(auth, 'automation', 'operator') };

  /** A batch (possibly empty — it still proves the feed is alive). Invalid items are reported. */
  app.post('/api/v1/news/items', automation, async (req) => {
    const b = Push.parse(req.body);
    const r = runtime.news.ingest({ items: b.items }, `ingest:${b.source}`, 'MANUAL');
    await runtime.newsItemsRecorded();
    return { accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected };
  });

  app.get('/api/v1/news', read, (req) => {
    const q = z
      .object({
        symbol: SymbolSchema.optional(),
        impact: z.enum(NEWS_IMPACTS).optional(),
        category: z.enum(NEWS_CATEGORIES).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return {
      feed: { ...runtime.news.feedStatus(), health: runtime.news.health() },
      poller: runtime.newsPoller?.status() ?? null,
      items: runtime.news.list({
        symbol: q.symbol,
        minImpact: q.impact,
        category: q.category,
        limit: q.limit,
      }),
    };
  });

  /** News context for every configured instrument. */
  app.get('/api/v1/news/context', read, () => {
    const now = runtime.clock.now();
    const symbols = [...runtime.config.instruments.keys()];
    const calendar = eventRiskView({
      calendar: runtime.calendar.fresh(),
      symbols,
      now,
      rule: mergedBlackout(runtime.config.system.decision.eventBlackout),
    });
    const state = new Map(calendar.instruments.map((i) => [i.symbol, i.state]));
    return newsContextView({
      service: runtime.news,
      symbols,
      now,
      calendarState: (s) => state.get(s) ?? 'UNKNOWN',
      poller: runtime.newsPoller?.status() ?? null,
    });
  });
}
