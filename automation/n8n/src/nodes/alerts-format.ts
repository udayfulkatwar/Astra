/**
 * "Pick and format" — ASTRA events worth a message → one grouped notification (or nothing).
 *
 * Sent by default: every ERROR and CRITICAL; kill switches, mode changes, account-health
 * changes, position alerts, protective closes, high-impact news, executions and closed trades.
 * Not sent: routine gate rejections and calendar updates (they are in the daily report), and
 * failures of the alert / notify workflows themselves (that would loop). The cursor advances
 * past every event read, sent or not.
 */
import { str, truncate, type Ctx, type Json } from './shared';

export const ALERT_RULES = {
  levels: ['ERROR', 'CRITICAL'],
  types: [
    'KILL_SWITCH_ACTIVATED',
    'KILL_SWITCH_DEACTIVATED',
    'MODE_CHANGED',
    'ACCOUNT_HEALTH_CHANGED',
    'NEWS_HIGH_IMPACT',
    'TRADE_JOURNALED',
  ],
  typePrefixes: ['POSITION_', 'PROTECTIVE_CLOSE_', 'EXECUTION_'],
  /** Workflows whose own failures are not alerted (they deliver the alerts). */
  quietWorkflows: ['ASTRA — Alerts', 'ASTRA — Notify'],
  maxLines: 25,
};

export interface AstraEvent {
  readonly seq: number;
  readonly at: string;
  readonly level: string;
  readonly component: string;
  readonly type: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export function wanted(e: AstraEvent): boolean {
  if (e.type === 'WORKFLOW_ERROR') {
    const wf = str(e.data?.workflow);
    if (ALERT_RULES.quietWorkflows.includes(wf)) return false;
  }
  return (
    ALERT_RULES.levels.includes(e.level) ||
    ALERT_RULES.types.includes(e.type) ||
    ALERT_RULES.typePrefixes.some((p) => e.type.startsWith(p))
  );
}

const line = (e: AstraEvent) =>
  `${e.level === 'INFO' ? '' : `${e.level} `}${e.at.slice(11, 16)}Z ${e.component}: ${e.message}`;

export function format(events: readonly AstraEvent[]): Json | null {
  const picked = events.filter(wanted);
  if (picked.length === 0) return null;
  const worst =
    ['CRITICAL', 'ERROR', 'WARN', 'INFO'].find((l) => picked.some((e) => e.level === l)) ?? 'INFO';
  if (picked.length === 1) {
    const e = picked[0]!;
    return {
      title: `ASTRA ${e.level}: ${e.type.toLowerCase().replace(/_/g, ' ')}`,
      text: truncate(line(e), 1_800),
      level: e.level,
    };
  }
  const shown = picked.slice(-ALERT_RULES.maxLines);
  const more = picked.length - shown.length;
  return {
    title: `ASTRA: ${picked.length} alerts (worst ${worst})`,
    text: truncate(
      [...(more > 0 ? [`… ${more} earlier alert(s) not shown`] : []), ...shown.map(line)].join(
        '\n',
      ),
      3_800,
    ),
    level: worst,
  };
}

export function run(items: Json[], ctx: Ctx): Json[] {
  const events = ((items[0]?.events as AstraEvent[] | undefined) ?? [])
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const after = Number(ctx.extra.cursor?.[0]?.afterSeq ?? 0);
  const last = events.at(-1)?.seq;
  ctx.staticData.lastSeq = typeof last === 'number' ? last : after;
  const message = format(events.filter((e) => e.seq > after));
  return message ? [message] : [];
}
