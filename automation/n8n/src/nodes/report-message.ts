/** "Message" — ASTRA's report (computed by ASTRA) → a notification. n8n adds nothing to it. */
import type { Ctx, Json } from './shared';

export function run(items: Json[], _ctx: Ctx): Json[] {
  return items.map((r) => {
    const text = typeof r.text === 'string' ? r.text : '';
    if (text === '') throw new Error('ASTRA returned a report without text');
    const [title, ...rest] = text.split('\n');
    return { title, text: rest.join('\n').trim(), level: 'INFO' };
  });
}

/** Trigger helpers: which report the schedule asked for. */
export function daily(_items: Json[], _ctx: Ctx): Json[] {
  return [{ kind: 'daily' }];
}

export function weekly(_items: Json[], _ctx: Ctx): Json[] {
  return [{ kind: 'weekly' }];
}
