/**
 * Economic calendar (Phase 4, ADR-0011): push ingestion for n8n, upcoming events, and the event
 * risk per instrument — the same blackout assessment the gate's `calendar.event-blackout` uses.
 * Pushed windows are labelled MANUAL: acceptable in PAPER, refused in SHADOW/LIVE.
 */
import { eventRiskView } from '@astra/calendar';
import { CalendarWindowSchema } from '@astra/core';
import { mergedBlackout } from '@astra/decision';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const Push = z.object({ source: z.string().min(1).max(100), window: CalendarWindowSchema });

export function registerCalendarRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const automation = { preHandler: requireRole(auth, 'automation', 'operator') };

  app.post('/api/v1/calendar/window', automation, async (req) => {
    const b = Push.parse(req.body);
    const r = runtime.calendar.ingest(b.window, `ingest:${b.source}`, 'MANUAL');
    await runtime.calendarEventsRecorded();
    return {
      accepted: r.events,
      changes: r.changes.map((c) => ({ type: c.type, eventId: c.event.id })),
    };
  });

  app.get('/api/v1/calendar/upcoming', read, (req) => {
    const q = z
      .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
      .parse(req.query);
    const now = runtime.clock.now();
    const w = runtime.calendar.upcoming(
      new Date(now.getTime() - 3_600_000),
      new Date(now.getTime() + q.hours * 3_600_000),
    );
    return w.status === 'OK' ? w : { ...w, value: null };
  });

  /** Event risk per configured instrument under the global blackout rule (strategies may widen it). */
  app.get('/api/v1/calendar/risk', read, () =>
    eventRiskView({
      calendar: runtime.calendar.fresh(),
      symbols: [...runtime.config.instruments.keys()],
      now: runtime.clock.now(),
      rule: mergedBlackout(runtime.config.system.decision.eventBlackout),
      poller: runtime.calendarPoller?.status() ?? null,
    }),
  );
}
