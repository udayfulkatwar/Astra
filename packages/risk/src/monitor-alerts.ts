/**
 * Alerts from position-monitor views, raised once per crossing (with hysteresis) instead of on
 * every evaluation. Pure state machine: feed it the latest views, get the transitions.
 *
 * - UNPROTECTED (CRITICAL): an open position without a stop.
 * - NO_PRICE (WARN): an open position without a fresh quote cannot be monitored.
 * - STOP_NEAR (WARN) / TARGET_NEAR (INFO): per the policy's proximity levels.
 * - BUFFER (WARN → CRITICAL): the worst case uses too much of a hard limit (daily loss,
 *   drawdown, or the trailing path); escalation re-raises, clearing needs the hysteresis margin.
 * - MONITOR_UNKNOWN (WARN): an account with open positions can no longer be evaluated.
 * An alert whose subject disappears (position closed) clears. Missing data never clears an alert.
 */
import type { AccountMonitorView, MonitorPolicy, PositionView } from './monitor';

export type MonitorAlertKind =
  'UNPROTECTED' | 'NO_PRICE' | 'STOP_NEAR' | 'TARGET_NEAR' | 'BUFFER' | 'MONITOR_UNKNOWN';
export type MonitorAlertLevel = 'INFO' | 'WARN' | 'CRITICAL';

export interface MonitorAlert {
  readonly key: string;
  readonly kind: MonitorAlertKind;
  readonly level: MonitorAlertLevel;
  readonly accountId: string;
  readonly positionId: string | null;
  readonly symbol: string | null;
  readonly message: string;
  /** When it was (last) raised. */
  readonly since: string;
}

export interface MonitorAlertChange {
  readonly change: 'RAISED' | 'ESCALATED' | 'CLEARED';
  readonly alert: MonitorAlert;
}

interface Condition {
  readonly key: string;
  readonly kind: MonitorAlertKind;
  readonly level: MonitorAlertLevel;
  readonly positionId: string | null;
  readonly symbol: string | null;
  /** The raise condition holds. */
  readonly active: boolean;
  /** Far enough on the safe side to clear an alert that is up. */
  readonly clearable: boolean;
  readonly message: string;
}

const RANK: Record<MonitorAlertLevel, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

function positionConditions(
  accountId: string,
  p: PositionView,
  policy: MonitorPolicy,
): Condition[] {
  const key = (kind: MonitorAlertKind) => `${accountId}:${p.positionId}:${kind}`;
  const who = `${accountId} ${p.direction} ${p.quantity} ${p.symbol}`;
  const base = { positionId: p.positionId, symbol: p.symbol };
  const h = policy.hysteresisPct;
  const out: Condition[] = [
    {
      ...base,
      key: key('UNPROTECTED'),
      kind: 'UNPROTECTED',
      level: 'CRITICAL',
      active: p.stopPrice === null,
      clearable: p.stopPrice !== null,
      message: `${who} has NO protective stop — open risk is unknown`,
    },
    {
      ...base,
      key: key('NO_PRICE'),
      kind: 'NO_PRICE',
      level: 'WARN',
      active: p.mark === null,
      clearable: p.mark !== null,
      message: `${who} cannot be monitored: ${p.markReason ?? 'no fresh quote'}`,
    },
  ];
  // Without a price the distance is unknown: an alert that is up stays up (never cleared for
  // lack of data); a new one is not raised on a guess.
  if (p.stopPrice !== null) {
    const v = p.stopRemainingPct;
    out.push({
      ...base,
      key: key('STOP_NEAR'),
      kind: 'STOP_NEAR',
      level: 'WARN',
      active: v !== null && v <= policy.stopProximityPct,
      clearable: v !== null && v > policy.stopProximityPct + h,
      message:
        v === null
          ? `${who} near its stop ${p.stopPrice}: distance unknown (no fresh price)`
          : `${who} is near its stop ${p.stopPrice}: ${v.toFixed(0)}% of the stop distance left (${p.stopDistanceTicks} ticks, ${p.rMultiple ?? '?'} R)`,
    });
  }
  if (p.targetPrice !== null) {
    const v = p.targetProgressPct;
    out.push({
      ...base,
      key: key('TARGET_NEAR'),
      kind: 'TARGET_NEAR',
      level: 'INFO',
      active: v !== null && v >= policy.targetProximityPct,
      clearable: v !== null && v < policy.targetProximityPct - h,
      message:
        v === null
          ? `${who} near its target ${p.targetPrice}: progress unknown (no fresh price)`
          : `${who} is near its target ${p.targetPrice}: ${v.toFixed(0)}% of the way (${p.rMultiple ?? '?'} R)`,
    });
  }
  return out;
}

function accountConditions(v: AccountMonitorView, policy: MonitorPolicy): Condition[] {
  const base = { positionId: null, symbol: null };
  const open = v.positions.length > 0;
  const out: Condition[] = [
    {
      ...base,
      key: `${v.accountId}::MONITOR_UNKNOWN`,
      kind: 'MONITOR_UNKNOWN',
      level: 'WARN',
      active: v.status === 'UNKNOWN',
      clearable: v.status === 'OK',
      message: `${v.accountId} cannot be monitored: ${v.reason ?? 'unknown'}`,
    },
  ];
  if (v.status === 'OK') {
    const used = v.bufferUsedPct;
    const parts: [string, number | null | undefined][] = [
      ['daily loss', v.dailyLoss?.worstCaseUsedPct],
      ['drawdown', v.drawdown?.worstCaseUsedPct],
      ['trailing path', v.trailing?.pathUsedPct],
    ];
    const worst = parts
      .filter((x): x is [string, number] => typeof x[1] === 'number')
      .map(([label, value]) => `${label} ${value.toFixed(1)}%`)
      .join(', ');
    out.push({
      ...base,
      key: `${v.accountId}::BUFFER`,
      kind: 'BUFFER',
      level: used !== null && used >= policy.bufferCriticalPct ? 'CRITICAL' : 'WARN',
      // Unknown usage with open positions is itself a buffer warning (fail-safe).
      active: used === null ? open : used >= policy.bufferWarnPct,
      clearable: used !== null && used < policy.bufferWarnPct - policy.hysteresisPct,
      message:
        used === null
          ? `${v.accountId} worst-case limit usage is UNKNOWN${v.trailing ? ` (${v.trailing.note})` : ''}`
          : `${v.accountId} worst case uses ${used.toFixed(1)}% of a hard limit (${worst})`,
    });
  }
  return out;
}

export class MonitorAlertTracker {
  private readonly active = new Map<string, MonitorAlert>();

  constructor(private readonly policy: MonitorPolicy) {}

  /** Applies the latest views; returns the transitions since the previous call. */
  update(views: readonly AccountMonitorView[], now: Date): MonitorAlertChange[] {
    const at = now.toISOString();
    const changes: MonitorAlertChange[] = [];
    const seen = new Set<string>();
    for (const v of views) {
      const conditions = [
        ...accountConditions(v, this.policy),
        ...v.positions.flatMap((p) => positionConditions(v.accountId, p, this.policy)),
      ];
      for (const c of conditions) {
        seen.add(c.key);
        const current = this.active.get(c.key);
        const alert: MonitorAlert = {
          key: c.key,
          kind: c.kind,
          level: c.level,
          accountId: v.accountId,
          positionId: c.positionId,
          symbol: c.symbol,
          message: c.message,
          since: at,
        };
        if (!current) {
          if (c.active) {
            this.active.set(c.key, alert);
            changes.push({ change: 'RAISED', alert });
          }
        } else if (c.clearable) {
          this.active.delete(c.key);
          changes.push({ change: 'CLEARED', alert: { ...current, message: c.message, since: at } });
        } else if (c.active && RANK[c.level] > RANK[current.level]) {
          this.active.set(c.key, alert);
          changes.push({ change: 'ESCALATED', alert });
        } else if (c.active) {
          // Keep the original raise time; refresh the figures in the message.
          this.active.set(c.key, { ...current, message: c.message });
        }
      }
    }
    // Subjects that disappeared (position closed, account removed) clear their alerts.
    for (const [key, alert] of this.active) {
      if (!seen.has(key)) {
        this.active.delete(key);
        changes.push({
          change: 'CLEARED',
          alert: {
            ...alert,
            message: `${alert.message} — no longer applicable (closed)`,
            since: at,
          },
        });
      }
    }
    return changes;
  }

  /** Alerts currently raised, most severe first. */
  list(): MonitorAlert[] {
    return [...this.active.values()].sort(
      (a, b) => RANK[b.level] - RANK[a.level] || a.since.localeCompare(b.since),
    );
  }
}
