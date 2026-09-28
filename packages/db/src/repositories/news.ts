/** News items as accepted and classified (inserted once, never edited). */
import type { ClassifiedNews } from '@astra/news';
import type { Sql } from '../client';
import { jsonb } from '../client';

export class NewsRepository {
  constructor(private readonly sql: Sql) {}

  /** Records new items; items already stored are left as they are. Returns how many were new. */
  async record(items: readonly ClassifiedNews[]): Promise<number> {
    let added = 0;
    for (const n of items) {
      const rows = await this.sql`
        insert into news_items
          (item_key, source, source_kind, published_at, received_at, headline, category, impact,
           affected, classifier, news)
        values (${n.key}, ${n.source}, ${n.sourceKind}, ${n.item.publishedAt}, ${n.receivedAt},
          ${n.item.headline}, ${n.category}, ${n.impact}, ${n.affected.map((a) => a.symbol)},
          ${n.classifier}, ${jsonb(this.sql, n)})
        on conflict (item_key) do nothing
        returning item_key`;
      added += rows.length;
    }
    return added;
  }

  /** Items published at or after `since`, oldest first (at most `limit`, newest kept). */
  async since(since: string, limit = 5_000): Promise<ClassifiedNews[]> {
    const rows = await this.sql<{ news: ClassifiedNews }[]>`
      select news from (
        select news, published_at, item_key from news_items where published_at >= ${since}
         order by published_at desc, item_key limit ${limit}
      ) newest order by published_at asc, item_key`;
    return rows.map((r) => r.news);
  }
}
