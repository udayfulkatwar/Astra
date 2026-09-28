/**
 * Daily / weekly reports (Phase 7). ASTRA computes every figure from its own records; n8n only
 * schedules the request and delivers the text. Periods are trading days of each account's
 * prop-firm profile (its reset time and zone), so "Monday" means the firm's Monday.
 */
import {
  AstraError,
  tradingDayWindow,
  type LocalTimeInZone,
  type TradingDayWindow,
  type TradingMode,
} from '@astra/core';
import type { AstraConfig } from '@astra/config';
import type { AiStats, DecisionStats, EventStats, ReportRepository } from '@astra/db';
import type { JournalEntry } from '@astra/journal';
import type { AccountService } from './account-service';
import type { KillSwitchService } from './kill-switch-service';
import type { HealthService } from './health-service';

export type ReportKind = 'DAILY' | 'WEEKLY';

export interface TradeTotals {
  readonly count: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  /** Net of costs where known, else gross. */
  readonly pnl: number;
  /** Sum / mean / best / worst over trades with a known R multiple. */
  readonly totalR: number;
  readonly avgR: number | null;
  readonly bestR: number | null;
  readonly worstR: number | null;
  readonly byStrategy: readonly {
    strategyId: string;
    count: number;
    pnl: number;
    totalR: number;
  }[];
}

export interface AccountReport {
  readonly accountId: string;
  readonly name: string;
  readonly currency: string;
  readonly profileId: string;
  /** False while the prop-firm profile, risk policy or a strategy is a template. */
  readonly ownerVerified: boolean;
  readonly period: { readonly days: readonly string[]; readonly from: string; readonly to: string };
  readonly trades: TradeTotals;
  readonly decisions: DecisionStats;
  /** Account state at the time of the report (null while not synced). */
  readonly now: {
    readonly balance: number;
    readonly equity: number;
    readonly health: string;
    readonly usagePct: number | null;
    readonly distanceToBreach: number;
    readonly dayLocked: boolean;
    readonly breached: boolean;
    readonly profitTarget: { readonly target: number; readonly progressPct: number } | null;
  } | null;
}

export interface PeriodReport {
  readonly kind: ReportKind;
  readonly generatedAt: string;
  readonly mode: TradingMode;
  readonly simulation: boolean;
  /** The union of the accounts' periods (system-wide figures use it). */
  readonly from: string;
  readonly to: string;
  readonly accounts: readonly AccountReport[];
  readonly ai: AiStats;
  readonly system: EventStats & {
    readonly killSwitches: readonly { scope: string; target: string | null; reason: string }[];
    readonly componentsNotOnline: readonly { component: string; status: string; detail: string }[];
  };
  /** Plain-text rendering for chat / email delivery. */
  readonly text: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const KEY = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 86_400_000;
const keyDate = (key: string) => new Date(`${key}T12:00:00.000Z`);

/** The trading-day window whose key is `key` (a local date in the reset zone). */
export function windowForKey(key: string, reset: LocalTimeInZone): TradingDayWindow {
  if (!KEY.test(key) || Number.isNaN(keyDate(key).getTime()))
    throw new AstraError('VALIDATION', `invalid trading day ${key}`);
  let w = tradingDayWindow(keyDate(key), reset);
  for (let i = 0; i < 4 && w.key !== key; i++) {
    w = tradingDayWindow(new Date(w.key < key ? w.end.getTime() : w.start.getTime() - 1), reset);
  }
  if (w.key !== key) throw new AstraError('INTERNAL', `no trading-day window found for ${key}`);
  return w;
}

/**
 * Trading days covered: DAILY → `day` (default: the last completed trading day, or the current
 * one with `day: 'current'`); WEEKLY → Monday…Sunday keys of the week containing that day.
 */
export function reportDays(
  kind: ReportKind,
  now: Date,
  reset: LocalTimeInZone,
  day?: string,
): string[] {
  const current = tradingDayWindow(now, reset);
  const anchor =
    day === 'current'
      ? current.key
      : (day ?? tradingDayWindow(new Date(current.start.getTime() - 1), reset).key);
  if (!KEY.test(anchor)) throw new AstraError('VALIDATION', `invalid trading day ${anchor}`);
  if (kind === 'DAILY') return [anchor];
  const d = keyDate(anchor);
  const monday = d.getTime() - ((d.getUTCDay() + 6) % 7) * dayMs;
  return Array.from({ length: 7 }, (_, i) =>
    new Date(monday + i * dayMs).toISOString().slice(0, 10),
  );
}

export function tradeTotals(entries: readonly JournalEntry[]): TradeTotals {
  const withR = entries.map((e) => e.result.rMultiple).filter((r): r is number => r !== null);
  const pnlOf = (e: JournalEntry) => e.result.netPnl ?? e.result.grossPnl;
  const groups = new Map<string, { count: number; pnl: number; totalR: number }>();
  for (const e of entries) {
    const key = e.strategyId ?? '(external)';
    const g = groups.get(key) ?? { count: 0, pnl: 0, totalR: 0 };
    g.count += 1;
    g.pnl += pnlOf(e);
    g.totalR += e.result.rMultiple ?? 0;
    groups.set(key, g);
  }
  const totalR = withR.reduce((a, b) => a + b, 0);
  return {
    count: entries.length,
    wins: entries.filter((e) => e.result.outcome === 'WIN').length,
    losses: entries.filter((e) => e.result.outcome === 'LOSS').length,
    breakeven: entries.filter((e) => e.result.outcome === 'BREAKEVEN').length,
    pnl: r2(entries.reduce((a, e) => a + pnlOf(e), 0)),
    totalR: r2(totalR),
    avgR: withR.length > 0 ? r2(totalR / withR.length) : null,
    bestR: withR.length > 0 ? Math.max(...withR) : null,
    worstR: withR.length > 0 ? Math.min(...withR) : null,
    byStrategy: [...groups]
      .map(([strategyId, g]) => ({
        strategyId,
        count: g.count,
        pnl: r2(g.pnl),
        totalR: r2(g.totalR),
      }))
      .sort((a, b) => b.count - a.count || a.strategyId.localeCompare(b.strategyId)),
  };
}

const money = (n: number, ccy: string) =>
  `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
const plain = (n: number, ccy: string) =>
  `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
const signed = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n)}`;

export function renderReportText(r: Omit<PeriodReport, 'text'>): string {
  const lines: string[] = [];
  const first = r.accounts[0]?.period.days;
  const label =
    r.kind === 'DAILY'
      ? `trading day ${first?.[0] ?? '?'}`
      : `week ${first?.[0] ?? '?'} → ${first?.at(-1) ?? '?'}`;
  lines.push(
    `ASTRA ${r.kind === 'DAILY' ? 'daily' : 'weekly'} report — ${label} (${r.mode}${r.simulation ? ', SIMULATED feeds' : ''})`,
  );
  for (const a of r.accounts) {
    lines.push('');
    lines.push(
      `${a.accountId} · ${a.profileId}${a.ownerVerified ? '' : ' · TEMPLATE/UNVERIFIED config'}`,
    );
    const t = a.trades;
    lines.push(
      t.count === 0
        ? '  Trades: none'
        : `  Trades ${t.count}: ${t.wins} won, ${t.losses} lost${t.breakeven ? `, ${t.breakeven} breakeven` : ''} · ${money(t.pnl, a.currency)} · ${signed(t.totalR)} R${t.avgR === null ? '' : ` (avg ${signed(t.avgR)} R, best ${signed(t.bestR!)} R, worst ${signed(t.worstR!)} R)`}`,
    );
    const d = a.decisions;
    lines.push(
      `  Gate: ${d.approved} approved, ${d.rejected} rejected${d.topRejectChecks.length > 0 ? ` (most common: ${d.topRejectChecks.map((c) => `${c.check} ${c.count}`).join(', ')})` : ''}`,
    );
    const n = a.now;
    lines.push(
      n
        ? `  Now: equity ${plain(n.equity, a.currency)} · health ${n.health}${n.usagePct === null ? '' : ` · ${Math.round(n.usagePct)}% of limits used`} · ${plain(n.distanceToBreach, a.currency)} to the nearest limit${n.dayLocked ? ' · DAY LOCKED' : ''}${n.breached ? ' · LIMIT BREACHED' : ''}${n.profitTarget ? ` · profit target ${Math.round(n.profitTarget.progressPct)}%` : ''}`
        : '  Now: account state unknown (not synced)',
    );
  }
  lines.push('');
  lines.push(
    `AI: ${r.ai.sent} calls, $${r.ai.costUsd.toFixed(2)}, ${r.ai.analyses} analyses, ${r.ai.reviews} reviews${r.ai.blocked ? `, ${r.ai.blocked} blocked` : ''}${r.ai.failed ? `, ${r.ai.failed} failed` : ''}`,
  );
  const s = r.system;
  lines.push(
    `System: ${s.critical} critical, ${s.error} errors, ${s.warn} warnings · kill switches: ${s.killSwitches.length === 0 ? 'none' : s.killSwitches.map((k) => `${k.scope}${k.target ? ` ${k.target}` : ''}`).join(', ')}`,
  );
  if (s.componentsNotOnline.length > 0) {
    lines.push(
      `  Not online now: ${s.componentsNotOnline.map((c) => `${c.component} ${c.status}`).join(', ')}`,
    );
  }
  for (const i of s.incidents.slice(0, 5)) {
    lines.push(`  ${i.level} ${i.at.slice(5, 16).replace('T', ' ')}Z ${i.component}: ${i.message}`);
  }
  return lines.join('\n');
}

export class ReportService {
  constructor(
    private readonly deps: {
      config: AstraConfig;
      repo: ReportRepository;
      accounts: AccountService;
      killSwitches: KillSwitchService;
      health: HealthService;
      mode: () => TradingMode;
      simulation: boolean;
      now: () => Date;
    },
  ) {}

  async build(kind: ReportKind, day?: string): Promise<PeriodReport> {
    const { config, repo, accounts } = this.deps;
    const now = this.deps.now();
    const reports: AccountReport[] = [];
    for (const account of config.accounts.values()) {
      if (account.status !== 'ACTIVE') continue;
      const profile = config.profiles.get(account.propFirmProfileId);
      if (!profile) continue;
      const days = reportDays(kind, now, profile.tradingDayReset, day);
      const from = windowForKey(days[0]!, profile.tradingDayReset).start.toISOString();
      const to = windowForKey(days.at(-1)!, profile.tradingDayReset).end.toISOString();
      const [entries, decisions] = await Promise.all([
        repo.journal(account.id, from, to),
        repo.decisions(account.id, from, to),
      ]);
      const view = accounts.view(account.id);
      const st = view?.state ?? null;
      const policy = config.riskPolicies.get(account.riskPolicyId);
      const strategiesVerified = account.strategies.every(
        (id) => config.strategies.get(id)?.ownership === 'USER',
      );
      reports.push({
        accountId: account.id,
        name: account.name,
        currency: account.currency,
        profileId: profile.id,
        ownerVerified:
          profile.verification.status === 'USER_VERIFIED' &&
          policy?.ownership === 'USER' &&
          strategiesVerified,
        period: { days, from, to },
        trades: tradeTotals(entries),
        decisions,
        now: st
          ? {
              balance: st.balance,
              equity: st.equity,
              health: view?.health?.health ?? 'UNKNOWN',
              usagePct: view?.health?.usagePct ?? null,
              distanceToBreach: st.distanceToBreach,
              dayLocked: st.dayLocked,
              breached: st.breached,
              profitTarget: st.profitTarget
                ? {
                    target: st.profitTarget.target,
                    progressPct: st.profitTarget.progressPct,
                  }
                : null,
            }
          : null,
      });
    }
    if (reports.length === 0) throw new AstraError('NOT_FOUND', 'no active accounts to report on');
    const from = reports.map((r) => r.period.from).sort()[0]!;
    const to = reports
      .map((r) => r.period.to)
      .sort()
      .at(-1)!;
    const [ai, events] = await Promise.all([repo.ai(from, to), repo.events(from, to)]);
    const base = {
      kind,
      generatedAt: now.toISOString(),
      mode: this.deps.mode(),
      simulation: this.deps.simulation,
      from,
      to,
      accounts: reports,
      ai,
      system: {
        ...events,
        killSwitches: this.deps.killSwitches
          .list()
          .filter((k) => k.active)
          .map((k) => ({ scope: k.scope, target: k.target, reason: k.reason })),
        componentsNotOnline: this.deps.health.registry
          .snapshot()
          .filter((c) => c.status !== 'ONLINE')
          .map((c) => ({ component: c.component, status: c.status, detail: c.detail })),
      },
    };
    return { ...base, text: renderReportText(base) };
  }
}
