/**
 * Demo transport: answers the dashboard's API calls from the in-browser runtime with the same
 * routes and response shapes as the real ASTRA API.
 */
import {
  SignalSchema,
  TimeZoneSchema,
  TradeCandidateSchema,
  modePolicy,
  worstHealth,
  type HealthStatus,
  type TradingMode,
} from '@astra/core';
import { eventRiskView } from '@astra/calendar';
import { journalSummary } from '@astra/journal';
import { learningReport } from '@astra/learning';
import { NEWS_CATEGORIES, NEWS_IMPACTS, newsContextView } from '@astra/news';
import { mergedBlackout } from '@astra/decision';
import { TimeframeSchema } from '@astra/market-data';
import { analyzeStructure } from '@astra/market-structure';
import { KILL_SWITCH_SCOPES, type KillSwitchScope } from '@astra/safety';
import { ApiError } from '../api/client';
import type { AccountView, DecisionSummary, StatusBar } from '../api/types';
import { getBacktest, listBacktests, runDemoBacktest } from './backtests';
import { demoRuntime, type DemoRuntime } from './runtime';

const RISK_ORDER = ['SAFE', 'CAUTION', 'RESTRICTED', 'BREACH_RISK', 'UNKNOWN', 'HALTED'];

function statusBar(rt: DemoRuntime): StatusBar {
  const now = rt.clock.now();
  const policy = rt.config.system.decision;
  const components = rt.health.snapshot();
  const byId = Object.fromEntries(components.map((c) => [c.component, c]));
  const system: HealthStatus = worstHealth(policy.requiredComponents.map((c) => byId[c]!.status));
  const mode = rt.mode.mode;
  const reasons: string[] = [];
  if (!modePolicy(mode).newTradesAllowed) reasons.push(`mode ${mode}`);
  const global = rt.killSwitches
    .active()
    .find((s) => s.scope === 'GLOBAL' || (s.scope === 'EXECUTION' && s.target === null));
  if (global) reasons.push(`${global.scope} kill switch: ${global.reason}`);
  for (const c of policy.requiredComponents)
    if (byId[c]!.status !== 'ONLINE') reasons.push(`${c} ${byId[c]!.status}`);
  const healths = [...rt.accounts.values()].map((a) => a.health?.health ?? 'UNKNOWN');
  const risk = healths.reduce(
    (w, h) => (RISK_ORDER.indexOf(h) > RISK_ORDER.indexOf(w) ? h : w),
    'SAFE',
  );
  return {
    now: now.toISOString(),
    system,
    initialized: true,
    mode,
    trading: { enabled: reasons.length === 0, reasons },
    risk,
    news: { status: byId.NEWS!.status, detail: byId.NEWS!.detail },
    calendar: calendarStatus(rt, byId.CALENDAR!.status),
    ai: { status: byId.AI!.status, detail: byId.AI!.detail },
    automation: { status: byId.AUTOMATION!.status, detail: byId.AUTOMATION!.detail },
    data: { status: byId.MARKET_DATA!.status, detail: byId.MARKET_DATA!.detail },
    killSwitchesActive: rt.killSwitches.active().length,
    simulation: true,
    configHash: rt.config.hash,
    configWarnings: [...rt.config.warnings],
  };
}

function calendarStatus(rt: DemoRuntime, status: HealthStatus): StatusBar['calendar'] {
  const now = rt.clock.now().getTime();
  const w = rt.calendarService.upcoming(new Date(now), new Date(now + 4 * 3_600_000));
  return {
    status,
    highImpactNext4h:
      w.status === 'OK'
        ? w.value.events.filter((e) => e.impact === 'HIGH' || e.impact === 'UNKNOWN').length
        : null,
    source: w.status === 'OK' ? w.sourceKind : null,
  };
}

function accountView(rt: DemoRuntime, id: string): AccountView | null {
  const account = rt.config.accounts.get(id);
  const e = rt.accounts.get(id);
  if (!account || !e) return null;
  const { credentialsEnv: _hidden, ...broker } = account.broker;
  return {
    account: { ...account, broker },
    snapshot: e.snapshot,
    tracking: e.tracking,
    state: e.state,
    health: e.health,
    activity: e.activity,
    error: e.error,
    syncedAt: e.syncedAt,
  };
}

function summary(rt: DemoRuntime, d: DemoRuntime['decisions'][number]): DecisionSummary {
  const x = d.decision;
  const approval = x.approval ? rt.store.approvals.get(x.approval.approvalId) : undefined;
  return {
    decisionId: x.decisionId,
    decidedAt: x.decidedAt,
    accountId: x.accountId,
    strategyId: x.strategyId,
    signalId: x.signalId,
    symbol: x.symbol,
    direction: x.direction,
    mode: x.mode,
    status: x.status,
    reasons: [...x.reasons],
    approvalId: x.approval?.approvalId ?? null,
    approvalState: approval?.state ?? null,
    approvalExpiresAt: x.approval?.expiresAt ?? null,
    configHash: x.configHash,
  };
}

function body<T>(b: unknown): T {
  return (b ?? {}) as T;
}

function scope(v: unknown): KillSwitchScope {
  if (typeof v === 'string' && (KILL_SWITCH_SCOPES as readonly string[]).includes(v))
    return v as KillSwitchScope;
  throw new ApiError(400, 'VALIDATION', 'invalid kill-switch scope');
}

function reason(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length < 3)
    throw new ApiError(400, 'VALIDATION', 'reason must be at least 3 characters');
  return v.trim();
}

function limitOf(q: URLSearchParams, fallback: number): number {
  const n = Number(q.get('limit') ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 200) : fallback;
}

export async function handleDemoRequest(
  method: 'GET' | 'POST',
  fullPath: string,
  requestBody: unknown,
): Promise<unknown> {
  const rt = demoRuntime();
  const url = new URL(fullPath, 'https://demo.local');
  const path = url.pathname;
  const q = url.searchParams;

  if (method === 'GET') {
    if (path === '/api/v1/system/status') return statusBar(rt);
    if (path === '/api/v1/system/health') return { components: rt.health.snapshot() };
    if (path === '/api/v1/system/mode') return { mode: rt.mode.mode, loaded: true, state: rt.mode };
    if (path === '/api/v1/accounts')
      return { accounts: [...rt.config.accounts.keys()].map((id) => accountView(rt, id)!) };
    const acct = /^\/api\/v1\/accounts\/([^/]+)$/.exec(path);
    if (acct) {
      const id = decodeURIComponent(acct[1]!);
      const view = accountView(rt, id);
      if (!view) throw new ApiError(404, 'NOT_FOUND', `account ${id} not found`);
      const orders = [...rt.store.orders.values()]
        .filter((o) => o.accountId === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);
      return { ...view, closedTrades: (rt.closedTrades.get(id) ?? []).slice(0, 20), orders };
    }
    if (path === '/api/v1/decisions') {
      const status = q.get('status');
      const accountId = q.get('accountId');
      const limit = Number(q.get('limit') ?? 50);
      return {
        decisions: rt.decisions
          .filter(
            (d) =>
              (!status || d.decision.status === status) &&
              (!accountId || d.decision.accountId === accountId),
          )
          .slice(0, limit)
          .map((d) => summary(rt, d)),
      };
    }
    const dec = /^\/api\/v1\/decisions\/([^/]+)$/.exec(path);
    if (dec) {
      const d = rt.decisions.find((x) => x.decision.decisionId === decodeURIComponent(dec[1]!));
      if (!d) throw new ApiError(404, 'NOT_FOUND', 'decision not found');
      return { ...summary(rt, d), decision: d.decision, inputs: d.inputs };
    }
    if (path === '/api/v1/orders')
      return {
        orders: [...rt.store.orders.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      };
    if (path === '/api/v1/kill-switches')
      return { loaded: rt.killSwitches.isLoaded(), switches: rt.killSwitches.list() };
    if (path === '/api/v1/audit') {
      const category = q.get('category');
      return {
        entries: rt.audit.filter((a) => !category || a.category === category).slice(0, 200),
      };
    }
    if (path === '/api/v1/audit/verify') return rt.verifyAudit();
    if (path === '/api/v1/events')
      return { events: rt.events.slice(0, Number(q.get('limit') ?? 100)) };
    if (path === '/api/v1/config/summary') {
      const c = rt.config;
      return {
        hash: c.hash,
        warnings: c.warnings,
        decisionPolicy: c.system.decision,
        profiles: [...c.profiles.values()],
        riskPolicies: [...c.riskPolicies.values()],
        instruments: [...c.instruments.values()],
        strategies: [...c.strategies.values()],
      };
    }
    if (path === '/api/v1/market/quotes') return { quotes: rt.allQuotes() };
    if (path === '/api/v1/strategies/runner') return rt.strategies.status();
    if (path === '/api/v1/market/scanner') return { snapshots: rt.snapshots() };
    if (path === '/api/v1/market/structure') {
      const timeframe = TimeframeSchema.safeParse(q.get('timeframe') ?? 'H1');
      if (!timeframe.success) throw new ApiError(400, 'VALIDATION', 'timeframe must be M1…D1');
      const only = q.get('symbol');
      if (only !== null && !rt.config.instruments.has(only))
        throw new ApiError(404, 'NOT_FOUND', `instrument ${only} is not configured`);
      return {
        structures: (only === null ? [...rt.config.instruments.keys()] : [only]).map((symbol) =>
          analyzeStructure({
            symbol,
            timeframe: timeframe.data,
            bars: rt.market.bars(symbol, timeframe.data),
            tickSize: rt.config.instruments.get(symbol)!.tickSize,
            params: rt.config.system.structure,
          }),
        ),
      };
    }
    if (path === '/api/v1/market/bars') {
      const symbol = q.get('symbol') ?? '';
      const timeframe = TimeframeSchema.safeParse(q.get('timeframe'));
      const limit = Number(q.get('limit') ?? 300);
      if (!timeframe.success || !Number.isInteger(limit) || limit < 1 || limit > 1_000)
        throw new ApiError(400, 'VALIDATION', 'timeframe must be M1…D1 and limit 1–1000');
      if (!rt.config.instruments.has(symbol))
        throw new ApiError(404, 'NOT_FOUND', `instrument ${symbol} is not configured`);
      return { bars: rt.market.bars(symbol, timeframe.data, limit) };
    }
    if (path === '/api/v1/calendar/upcoming') {
      const hours = Math.min(168, Math.max(1, Number(q.get('hours') ?? 24) || 24));
      const now = rt.clock.now().getTime();
      const w = rt.calendarService.upcoming(
        new Date(now - 3_600_000),
        new Date(now + hours * 3_600_000),
      );
      return w.status === 'OK' ? w : { ...w, value: null };
    }
    if (path === '/api/v1/journal' || path === '/api/v1/journal/summary') {
      const strategy = q.get('strategyId');
      const account = q.get('accountId');
      const entries = rt.journal.filter(
        (e) => (!strategy || e.strategyId === strategy) && (!account || e.accountId === account),
      );
      return path === '/api/v1/journal'
        ? { entries: entries.slice(0, Number(q.get('limit') ?? 100)) }
        : journalSummary(entries);
    }
    if (path === '/api/v1/news') {
      const impact = q.get('impact');
      const category = q.get('category');
      if (impact && !(NEWS_IMPACTS as readonly string[]).includes(impact))
        throw new ApiError(400, 'VALIDATION', 'invalid impact');
      if (category && !(NEWS_CATEGORIES as readonly string[]).includes(category))
        throw new ApiError(400, 'VALIDATION', 'invalid category');
      return {
        feed: { ...rt.news.feedStatus(), health: rt.news.health() },
        poller: null,
        items: rt.news.list({
          symbol: q.get('symbol') ?? undefined,
          minImpact: (impact ?? undefined) as (typeof NEWS_IMPACTS)[number] | undefined,
          category: (category ?? undefined) as (typeof NEWS_CATEGORIES)[number] | undefined,
          limit: Number(q.get('limit') ?? 100),
        }),
      };
    }
    if (path === '/api/v1/ai/status') return rt.aiStatus();
    if (path === '/api/v1/ai/calls') return { calls: rt.ai.recentCalls() };
    if (path === '/api/v1/ai/analyses') {
      return {
        analyses: rt.aiAnalyses.slice(0, limitOf(q, 50)).map(({ brief: _brief, ...a }) => a),
      };
    }
    if (path.startsWith('/api/v1/ai/analyses/')) {
      const id = decodeURIComponent(path.slice('/api/v1/ai/analyses/'.length));
      const a = rt.aiAnalyses.find((x) => x.analysis.analysisId === id);
      if (!a) throw new ApiError(404, 'NOT_FOUND', `analysis ${id} not found`);
      return a;
    }
    if (path === '/api/v1/ai/reviews') {
      const tradeId = q.get('tradeId');
      return {
        reviews: tradeId
          ? rt.aiReviews.filter((r) => r.tradeId === tradeId)
          : rt.aiReviews.slice(0, limitOf(q, 50)),
      };
    }
    if (path === '/api/v1/news/context') {
      const now = rt.clock.now();
      const symbols = [...rt.config.instruments.keys()];
      const cal = eventRiskView({
        calendar: rt.calendarService.fresh(),
        symbols,
        now,
        rule: mergedBlackout(rt.config.system.decision.eventBlackout),
        poller: null,
      });
      const state = new Map(cal.instruments.map((i) => [i.symbol, i.state]));
      return newsContextView({
        service: rt.news,
        symbols,
        now,
        calendarState: (s) => state.get(s) ?? 'UNKNOWN',
      });
    }
    if (path === '/api/v1/learning') {
      const tz = TimeZoneSchema.safeParse(q.get('timeZone') ?? 'UTC');
      if (!tz.success) throw new ApiError(400, 'VALIDATION', 'timeZone must be an IANA time zone');
      const runId = q.get('runId');
      const mode = q.get('mode');
      const backtest = q.get('source') === 'backtest';
      if (backtest && !runId) throw new ApiError(400, 'VALIDATION', 'runId is required');
      const run = backtest && runId ? getBacktest(runId) : null;
      const entries = run ? run.result.trades : rt.journal.filter((e) => !mode || e.mode === mode);
      return {
        source: {
          kind: backtest ? 'backtest' : 'journal',
          runId: run?.runId ?? null,
          label: run
            ? `Backtest ${run.runId}: ${run.result.label}`
            : 'Trade journal (recorded trades)',
        },
        ...learningReport(entries, { timeZone: tz.data, sessions: rt.config.system.sessions }),
      };
    }
    if (path === '/api/v1/backtests') return listBacktests();
    const bt = /^\/api\/v1\/backtests\/([^/]+)$/.exec(path);
    if (bt) return getBacktest(decodeURIComponent(bt[1]!));
    if (path === '/api/v1/monitor/positions')
      return {
        asOf: rt.monitorAsOf,
        policy: rt.monitorPolicy,
        accounts: rt.monitorViews,
        alerts: rt.monitorAlerts.list(),
        protection: rt.protectionStatus(),
      };
    if (path === '/api/v1/calendar/risk')
      return eventRiskView({
        calendar: rt.calendarService.fresh(),
        symbols: [...rt.config.instruments.keys()],
        now: rt.clock.now(),
        rule: mergedBlackout(rt.config.system.decision.eventBlackout),
        poller: null,
      });
  }

  if (method === 'POST') {
    if (path === '/api/v1/backtests') return runDemoBacktest(rt, requestBody);
    if (path === '/api/v1/news/items') {
      const b = body<{ source?: string; items?: unknown[] }>(requestBody);
      if (!b.source || !Array.isArray(b.items))
        throw new ApiError(400, 'VALIDATION', 'source and items are required');
      try {
        const r = rt.news.ingest({ items: b.items }, `ingest:${b.source}`, 'MANUAL');
        return { accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected };
      } catch (err) {
        throw new ApiError(400, 'VALIDATION', err instanceof Error ? err.message : String(err));
      }
    }
    if (path === '/api/v1/ai/reviews') {
      const { tradeId } = body<{ tradeId?: string }>(requestBody);
      if (!tradeId) throw new ApiError(400, 'VALIDATION', 'tradeId required');
      const r = await rt.reviewTrade(tradeId);
      if (!r) throw new ApiError(404, 'NOT_FOUND', `trade ${tradeId} is not in the journal`);
      return r;
    }
    if (path === '/api/v1/ai/analyses') {
      const parsed = SignalSchema.safeParse(body<{ signal?: unknown }>(requestBody).signal);
      if (!parsed.success)
        throw new ApiError(
          400,
          'VALIDATION',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      return { analysis: await rt.analyzeSignal(parsed.data) };
    }
    if (path === '/api/v1/decisions/evaluate') {
      const b = body<{ candidate?: unknown; autoExecute?: boolean }>(requestBody);
      const parsed = TradeCandidateSchema.omit({ submittedAt: true }).safeParse(b.candidate);
      if (!parsed.success)
        throw new ApiError(
          400,
          'VALIDATION',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      return rt.evaluate(
        { ...parsed.data, submittedAt: rt.clock.now().toISOString() },
        b.autoExecute === true,
      );
    }
    const cancel = /^\/api\/v1\/orders\/([^/]+)\/cancel$/.exec(path);
    if (cancel) return rt.cancelOrder(decodeURIComponent(cancel[1]!));
    if (path === '/api/v1/executions') {
      const { approvalId } = body<{ approvalId?: string }>(requestBody);
      if (!approvalId) throw new ApiError(400, 'VALIDATION', 'approvalId required');
      return rt.execute(approvalId);
    }
    if (path === '/api/v1/system/mode') {
      const b = body<{ mode?: TradingMode; reason?: string }>(requestBody);
      if (b.mode === 'LIVE')
        throw new ApiError(
          403,
          'FORBIDDEN',
          'LIVE mode requires server-side authorization (ADR-0008) — never available in the demo',
        );
      if (!b.mode || !['BACKTEST', 'PAPER', 'SHADOW', 'HALTED'].includes(b.mode))
        throw new ApiError(400, 'VALIDATION', 'invalid mode');
      const state = rt.setMode(b.mode, reason(b.reason));
      return { mode: state.mode, state };
    }
    if (path === '/api/v1/kill-switches/activate') {
      const b = body<{ scope?: string; target?: string | null; reason?: string }>(requestBody);
      try {
        return {
          state: rt.activateKillSwitch(scope(b.scope), b.target ?? null, reason(b.reason), {
            type: 'HUMAN',
            id: 'operator',
          }),
          persisted: true,
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, 'VALIDATION', err instanceof Error ? err.message : String(err));
      }
    }
    if (path === '/api/v1/kill-switches/deactivate') {
      const b = body<{ scope?: string; target?: string | null; reason?: string }>(requestBody);
      try {
        return {
          state: rt.deactivateKillSwitch(scope(b.scope), b.target ?? null, reason(b.reason)),
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(409, 'CONFLICT', err instanceof Error ? err.message : String(err));
      }
    }
  }
  throw new ApiError(404, 'NOT_FOUND', `route ${method} ${path} not available in the demo`);
}

export function subscribeDemoEvents(listener: Parameters<DemoRuntime['subscribe']>[0]): () => void {
  return demoRuntime().subscribe(listener);
}

export function demoClockNow(): Date {
  return demoRuntime().clock.now();
}
