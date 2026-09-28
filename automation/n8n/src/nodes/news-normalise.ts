/**
 * "Normalise" — RSS 2.0 / RSS 1.0 / Atom → ASTRA news items (one batch per feed).
 *
 * Only what the feed states is passed on: headline, link, summary, publisher (the feed's title)
 * and publication time. An item without a readable publication time is dropped, never dated by
 * guess. Classification (category, impact, instruments) is ASTRA's job. A document that is not a
 * feed stops the workflow, so nothing is pushed and ASTRA's news freshness is not renewed.
 */
import { fnv, isoOrNull, truncate, type Ctx, type Json } from './shared';

export interface ParsedEntry {
  readonly id: string | null;
  readonly title: string;
  readonly link: string | null;
  readonly summary: string | null;
  readonly published: string | null;
}

export interface ParsedFeed {
  readonly kind: 'RSS' | 'ATOM';
  readonly title: string | null;
  readonly entries: readonly ParsedEntry[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeText(raw: string): string {
  const cdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const decoded = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  // Entities first (escaped HTML becomes markup), then strip tags, then decode once more.
  const noTags = decoded(cdata).replace(/<[^>]*>/g, ' ');
  return decoded(noTags).replace(/\s+/g, ' ').trim();
}

function escapeTag(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inner text of the first <name> element (namespace prefix included in `name`, e.g. dc:date). */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(
    `<${escapeTag(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(name)}>`,
    'i',
  ).exec(xml);
  if (!m) return null;
  const text = decodeText(m[1] ?? '');
  return text === '' ? null : text;
}

function attr(element: string, name: string): string | null {
  const m = new RegExp(`\\s${escapeTag(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(element);
  return m ? decodeText(m[2] ?? m[3] ?? '') : null;
}

function atomLink(entry: string): string | null {
  const links = entry.match(/<link\b[^>]*>/gi) ?? [];
  const alternate =
    links.find((l) => (attr(l, 'rel') ?? 'alternate').toLowerCase() === 'alternate') ?? links[0];
  return alternate ? attr(alternate, 'href') : null;
}

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? '');
  return out;
}

export function parseFeed(xml: string): ParsedFeed {
  const head = xml.slice(0, 4_000);
  if (/<feed\b/i.test(head)) {
    const firstEntry = xml.search(/<entry\b/i);
    return {
      kind: 'ATOM',
      title: tag(firstEntry < 0 ? xml : xml.slice(0, firstEntry), 'title'),
      entries: blocks(xml, 'entry').map((e) => ({
        id: tag(e, 'id'),
        title: tag(e, 'title') ?? '',
        link: atomLink(e),
        summary: tag(e, 'summary') ?? tag(e, 'content'),
        published: tag(e, 'published') ?? tag(e, 'updated'),
      })),
    };
  }
  if (/<rss\b|<rdf:RDF\b/i.test(head)) {
    const firstItem = xml.search(/<item\b/i);
    return {
      kind: 'RSS',
      title: tag(firstItem < 0 ? xml : xml.slice(0, firstItem), 'title'),
      entries: blocks(xml, 'item').map((e) => ({
        id: tag(e, 'guid'),
        title: tag(e, 'title') ?? '',
        link: tag(e, 'link') ?? attr(e.match(/<link\b[^>]*>/i)?.[0] ?? '', 'href'),
        summary: tag(e, 'description') ?? tag(e, 'content:encoded'),
        published: tag(e, 'pubDate') ?? tag(e, 'dc:date') ?? tag(e, 'published'),
      })),
    };
  }
  throw new Error('the response is not an RSS or Atom feed');
}

export interface NormaliseOptions {
  /** Items published earlier than this are skipped (ASTRA keeps 48 h in memory). */
  readonly maxAgeHours: number;
  readonly maxItems: number;
}

export function toNewsItems(
  feed: ParsedFeed,
  now: Date,
  opts: NormaliseOptions,
): { items: Json[]; skipped: number } {
  const oldest = now.getTime() - opts.maxAgeHours * 3_600_000;
  const seen = new Set<string>();
  const items: Json[] = [];
  let skipped = 0;
  for (const e of feed.entries) {
    const publishedAt = isoOrNull(e.published);
    const headline = truncate(e.title, 500);
    if (!publishedAt || headline === '') {
      skipped += 1;
      continue;
    }
    if (Date.parse(publishedAt) < oldest) continue;
    const rawId = e.id ?? e.link ?? `${headline}|${publishedAt}`;
    const id = rawId.length <= 200 ? rawId : `h:${fnv(rawId)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const url = e.link && /^https?:\/\/\S+$/.test(e.link) && e.link.length <= 2_000 ? e.link : null;
    items.push({
      id,
      headline,
      publishedAt,
      ...(e.summary ? { summary: truncate(e.summary, 4_000) } : {}),
      ...(feed.title ? { publisher: truncate(feed.title, 200) } : {}),
      ...(url ? { url } : {}),
    });
    if (items.length >= opts.maxItems) break;
  }
  return { items, skipped };
}

/** One output item per feed: `{ source, items }` for POST /api/v1/news/items (empty = alive). */
export function run(fetched: Json[], ctx: Ctx): Json[] {
  const sources = ctx.extra.sources ?? [];
  if (fetched.length !== sources.length) {
    throw new Error(`fetched ${fetched.length} feeds but ${sources.length} are configured`);
  }
  return fetched.map((f, i) => {
    const name = String(sources[i]?.name);
    const body = f.data;
    if (typeof body !== 'string') throw new Error(`feed ${name}: empty response`);
    let feed: ParsedFeed;
    try {
      feed = parseFeed(body);
    } catch (err) {
      throw new Error(`feed ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { items, skipped } = toNewsItems(feed, ctx.now, { maxAgeHours: 24, maxItems: 200 });
    return { source: `rss:${name}`, items, skipped, workflowRunId: ctx.executionId };
  });
}
