/**
 * "Sources (edit me)" — the RSS / Atom feeds ASTRA should watch. The owner chooses them.
 * With no feed configured the workflow stops with an error: ASTRA then sees no fresh news feed
 * and approves no new trades (it never treats "not watching" as "no news").
 */
import { requireHttpUrl, requireSlug, type Ctx, type Json } from './shared';

// Add one entry per feed, e.g. { name: 'my-wire', url: 'https://example.com/rss.xml' }.
const SOURCES: { name: string; url: string }[] = [];

export function checkSources(sources: readonly { name: string; url: string }[]): Json[] {
  if (sources.length === 0) {
    throw new Error(
      'No news feeds configured: add RSS or Atom feed URLs in the "Sources (edit me)" node. Until then ASTRA sees no fresh news feed and approves no new trades.',
    );
  }
  const names = new Set<string>();
  return sources.map((s, i) => {
    const name = requireSlug(s.name, `feed ${i + 1} name`);
    if (names.has(name)) throw new Error(`feed name ${name} is used twice`);
    names.add(name);
    return { name, url: requireHttpUrl(s.url, `feed ${name} url`) };
  });
}

export function run(_items: Json[], _ctx: Ctx): Json[] {
  return checkSources(SOURCES);
}
