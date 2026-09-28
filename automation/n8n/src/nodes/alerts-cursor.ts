/**
 * "Cursor" — where the last alert run stopped. On the very first run it starts at the newest
 * event, so the backlog is not replayed as a burst of alerts.
 */
import type { Ctx, Json } from './shared';

export function run(_items: Json[], ctx: Ctx): Json[] {
  const latest = ctx.extra.latest?.[0]?.events;
  const newest = Array.isArray(latest) && latest.length > 0 ? Number((latest[0] as Json).seq) : 0;
  const saved = ctx.staticData.lastSeq;
  const afterSeq = typeof saved === 'number' && Number.isFinite(saved) ? saved : newest;
  return [{ afterSeq }];
}
