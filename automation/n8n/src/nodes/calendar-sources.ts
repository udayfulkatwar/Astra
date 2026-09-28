/**
 * "Sources (edit me)" — where the economic calendar comes from. The owner chooses the provider.
 *
 * Formats:
 * - `astra-window`: the source returns ASTRA's calendar window JSON ({ from, to, events }) —
 *   e.g. a small proxy in front of a paid provider.
 * - `ff-weekly-json`: a weekly JSON export in the ForexFactory style (title, country, date,
 *   impact, forecast, previous). UNVERIFIED here: check it against the live export before relying
 *   on it. Any field that does not match stops the workflow (nothing is pushed).
 *
 * No source → the workflow stops with an error: ASTRA's calendar goes stale and no new trades
 * are approved.
 */
import { requireHttpUrl, requireSlug, type Ctx, type Json } from './shared';

const FORMATS = ['astra-window', 'ff-weekly-json'] as const;

// Add one entry per source, e.g. { name: 'this-week', url: 'https://…', format: 'astra-window' }.
const SOURCES: { name: string; url: string; format: string }[] = [];

export function checkSources(
  sources: readonly { name: string; url: string; format: string }[],
): Json[] {
  if (sources.length === 0) {
    throw new Error(
      'No calendar source configured: add one in the "Sources (edit me)" node. Until then ASTRA has no fresh calendar and approves no new trades.',
    );
  }
  return sources.map((s, i) => {
    const name = requireSlug(s.name, `calendar source ${i + 1} name`);
    if (!(FORMATS as readonly string[]).includes(s.format)) {
      throw new Error(`calendar source ${name}: format must be one of ${FORMATS.join(', ')}`);
    }
    return { name, url: requireHttpUrl(s.url, `calendar source ${name} url`), format: s.format };
  });
}

export function run(_items: Json[], _ctx: Ctx): Json[] {
  return checkSources(SOURCES);
}
