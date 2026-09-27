/**
 * Automatic protection (ADR-0014): deterministic triggers that CLOSE positions — authorised by the
 * owner. Pure: it decides what to close and why; the core executes it through the execution
 * gateway (risk-reducing only, never while an EXECUTION kill switch is active).
 *
 * Triggers (evaluated on position-monitor views; only accounts that can be evaluated):
 * - LIMIT_PROXIMITY: a hard limit (daily loss or max drawdown, incl. a trailing threshold) is at
 *   least `flattenAtLimitUsagePct` used at the CURRENT mark → close every position and block new
 *   trades on the account (until the next trading day for the daily limit; manual otherwise).
 * - UNPROTECTED: a position without a stop for `unprotectedGraceMs` → close it.
 * - FLAT_BY / WEEKLY_CLOSE: within `flattenMinutesBeforeFlat` of the firm's mandatory flat time or
 *   (weekend holding prohibited) weekly close → close every position; a position opened before
 *   the last such deadline was held through it → close it.
 */
import {
  minutesBetween,
  nextDailyTime,
  nextWeeklyTime,
  type LocalTimeInZone,
  type WeeklyTime,
} from '@astra/core';
import type { HoldingRules } from '@astra/prop-firm';
import { z } from 'zod';
import type { AccountMonitorView, PositionView } from './monitor';

export const ProtectionPolicySchema = z
  .object({
    /** Master switch for automatic closing (owner-authorised; ADR-0014). */
    enabled: z.boolean().default(true),
    /** Close everything when a hard limit is this % used at the current mark. */
    flattenAtLimitUsagePct: z.number().min(50).max(99.9).default(90),
    /** Close a position that has had no stop this long. */
    unprotectedGraceMs: z.number().int().min(0).max(300_000).default(10_000),
    /** Close everything this many minutes before a mandatory flat time / weekly close. */
    flattenMinutesBeforeFlat: z.number().min(0).max(60).default(2),
    /** Failed close attempts per position before ASTRA stops retrying and asks for a human. */
    maxCloseAttempts: z.number().int().min(1).max(10).default(3),
  })
  .strict();
export type ProtectionPolicy = z.infer<typeof ProtectionPolicySchema>;
export const DEFAULT_PROTECTION_POLICY: ProtectionPolicy = ProtectionPolicySchema.parse({});

export type ProtectiveTrigger = 'LIMIT_PROXIMITY' | 'FLAT_BY' | 'WEEKLY_CLOSE' | 'UNPROTECTED';

export interface ProtectiveAction {
  readonly trigger: ProtectiveTrigger;
  readonly accountId: string;
  readonly positionId: string;
  readonly symbol: string;
  readonly reason: string;
  /** Block new trades on the account before closing (limit proximity). */
  readonly blockAccount: 'MANUAL' | 'NEXT_TRADING_DAY' | null;
}

/** What happened when a protective action ran (the core's log / API contract). */
export interface ProtectiveActionRecord {
  readonly at: string;
  readonly trigger: ProtectiveTrigger;
  readonly accountId: string;
  readonly positionId: string;
  readonly symbol: string;
  readonly reason: string;
  /** GAVE_UP: maxCloseAttempts failed — a human must act. */
  readonly outcome: 'CLOSED' | 'ALREADY_FLAT' | 'SKIPPED' | 'REJECTED' | 'UNKNOWN' | 'GAVE_UP';
  readonly detail: string;
  readonly exitPrice: number | null;
  readonly realizedPnl: number | null;
  readonly attempt: number;
}

export interface ProtectionStatus {
  readonly enabled: boolean;
  readonly policy: ProtectionPolicy;
  /** Most recent first. */
  readonly recent: ProtectiveActionRecord[];
}

export interface ProtectionContext {
  readonly now: Date;
  /** The account's prop-firm holding rules (null: none known). */
  readonly holding: (accountId: string) => HoldingRules | null;
}

/** Most important first: one action per position, from the highest-priority trigger. */
const PRIORITY: readonly ProtectiveTrigger[] = [
  'LIMIT_PROXIMITY',
  'FLAT_BY',
  'WEEKLY_CLOSE',
  'UNPROTECTED',
];

/** The latest occurrence of a daily time at or before `now` (DST-safe; `next*Time` are "at or after"). */
function lastDaily(now: Date, at: LocalTimeInZone): Date {
  for (const back of [1, 2]) {
    const d = nextDailyTime(new Date(now.getTime() - back * 86_400_000), at);
    if (d.getTime() <= now.getTime()) {
      const later = nextDailyTime(new Date(d.getTime() + 60_000), at); // the one after d
      return later.getTime() <= now.getTime() ? later : d;
    }
  }
  return new Date(Number.NEGATIVE_INFINITY);
}

function lastWeekly(now: Date, at: WeeklyTime): Date {
  const d = nextWeeklyTime(new Date(now.getTime() - 8 * 86_400_000), at);
  const later = nextWeeklyTime(new Date(d.getTime() + 60_000), at); // the one after d
  return later.getTime() <= now.getTime() ? later : d;
}

export class ProtectionEvaluator {
  /** accountId:positionId → first seen without a stop (epoch ms). */
  private readonly unprotectedSince = new Map<string, number>();

  constructor(readonly policy: ProtectionPolicy) {}

  evaluate(views: readonly AccountMonitorView[], ctx: ProtectionContext): ProtectiveAction[] {
    if (!this.policy.enabled) return [];
    const nowMs = ctx.now.getTime();
    const seen = new Set<string>();
    const actions: ProtectiveAction[] = [];

    for (const v of views) {
      if (v.status !== 'OK' || v.positions.length === 0) continue;
      const candidates: ProtectiveAction[] = [];
      const all = (
        trigger: ProtectiveTrigger,
        reason: string,
        block: ProtectiveAction['blockAccount'],
      ) =>
        v.positions.forEach((p) => candidates.push(action(v.accountId, p, trigger, reason, block)));

      // 1. Hard limit about to be breached at the current mark.
      const daily = v.dailyLoss?.usedPct ?? 0;
      const drawdown = v.drawdown?.usedPct ?? 0;
      const at = this.policy.flattenAtLimitUsagePct;
      if (daily >= at || drawdown >= at) {
        const which = [
          daily >= at ? `daily loss limit ${daily.toFixed(1)}% used` : null,
          drawdown >= at ? `max drawdown ${drawdown.toFixed(1)}% used` : null,
        ]
          .filter((x) => x !== null)
          .join(', ');
        all(
          'LIMIT_PROXIMITY',
          `${which} (flatten at ${at}%)`,
          drawdown >= at ? 'MANUAL' : 'NEXT_TRADING_DAY',
        );
      }

      // 2. Mandatory flat time and weekly close.
      const holding = ctx.holding(v.accountId);
      const buffer = this.policy.flattenMinutesBeforeFlat;
      if (holding?.flatBy) {
        const next = nextDailyTime(ctx.now, holding.flatBy);
        const last = lastDaily(ctx.now, holding.flatBy);
        const label = `${holding.flatBy.time} ${holding.flatBy.timeZone}`;
        if (minutesBetween(ctx.now, next) <= buffer) {
          all(
            'FLAT_BY',
            `mandatory flat time ${label} in ${Math.max(0, minutesBetween(ctx.now, next)).toFixed(1)} min`,
            null,
          );
        } else {
          for (const p of v.positions)
            if (Date.parse(p.openedAt) < last.getTime())
              candidates.push(
                action(
                  v.accountId,
                  p,
                  'FLAT_BY',
                  `held through the mandatory flat time ${label}`,
                  null,
                ),
              );
        }
      }
      if (holding?.weekend === 'PROHIBITED' && holding.weeklyClose) {
        const next = nextWeeklyTime(ctx.now, holding.weeklyClose);
        const last = lastWeekly(ctx.now, holding.weeklyClose);
        const label = `${holding.weeklyClose.day} ${holding.weeklyClose.time} ${holding.weeklyClose.timeZone}`;
        if (minutesBetween(ctx.now, next) <= buffer) {
          all(
            'WEEKLY_CLOSE',
            `weekly close ${label} in ${Math.max(0, minutesBetween(ctx.now, next)).toFixed(1)} min; weekend holding prohibited`,
            null,
          );
        } else {
          for (const p of v.positions)
            if (Date.parse(p.openedAt) < last.getTime())
              candidates.push(
                action(
                  v.accountId,
                  p,
                  'WEEKLY_CLOSE',
                  `held through the weekly close ${label}; weekend holding prohibited`,
                  null,
                ),
              );
        }
      }

      // 3. Positions without a protective stop past the grace period.
      for (const p of v.positions) {
        const key = `${v.accountId}:${p.positionId}`;
        if (p.stopPrice !== null) continue;
        seen.add(key);
        const since = this.unprotectedSince.get(key) ?? nowMs;
        this.unprotectedSince.set(key, since);
        if (nowMs - since >= this.policy.unprotectedGraceMs) {
          candidates.push(
            action(
              v.accountId,
              p,
              'UNPROTECTED',
              `no protective stop for ${Math.round((nowMs - since) / 1000)} s (grace ${this.policy.unprotectedGraceMs / 1000} s)`,
              null,
            ),
          );
        }
      }

      // One action per position, highest priority first.
      for (const p of v.positions) {
        const mine = candidates.filter((c) => c.positionId === p.positionId);
        const best = PRIORITY.map((t) => mine.find((c) => c.trigger === t)).find((c) => c);
        if (best) actions.push(best);
      }
    }
    for (const key of this.unprotectedSince.keys())
      if (!seen.has(key)) this.unprotectedSince.delete(key);
    return actions;
  }
}

function action(
  accountId: string,
  p: PositionView,
  trigger: ProtectiveTrigger,
  reason: string,
  blockAccount: ProtectiveAction['blockAccount'],
): ProtectiveAction {
  return {
    trigger,
    accountId,
    positionId: p.positionId,
    symbol: p.symbol,
    reason: `${p.direction} ${p.quantity} ${p.symbol}: ${reason}`,
    blockAccount,
  };
}
