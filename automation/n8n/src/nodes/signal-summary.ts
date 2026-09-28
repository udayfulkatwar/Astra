/** "Summarise" — ASTRA's decision → a short reply to the alert sender (no internal detail). */
import type { Ctx, Json } from './shared';

export function run(items: Json[], _ctx: Ctx): Json[] {
  return items.map((r) => {
    const d = (r.decision ?? {}) as Record<string, unknown>;
    const e = r.execution as Record<string, unknown> | null | undefined;
    return {
      status: d.status ?? 'UNKNOWN',
      decisionId: d.decisionId ?? null,
      symbol: d.symbol ?? null,
      direction: d.direction ?? null,
      reasons: Array.isArray(d.reasons) ? d.reasons.slice(0, 5) : [],
      execution: e ? (e.outcome ?? null) : null,
    };
  });
}
