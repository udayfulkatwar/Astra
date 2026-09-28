/** Shared by the server and the browser demo: stand-in routing and the status view. */
import type { DataSourceKind, HealthStatus } from '@astra/core';
import type { AiOrchestrator, AiUsageToday } from './orchestrator';
import type { AiSettings } from './settings';
import { SIMULATED_MODEL } from './simulated';
import { AI_TASKS, type AiCallRecord, type AiTask } from './types';

const ZERO = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };

/** Every route → the SIMULATED stand-in (simulation mode with `standInWhenSimulating`). */
export function standInSettings(s: AiSettings): AiSettings {
  const standIn = (r: AiSettings['routes'][AiTask]) => ({
    provider: 'simulated' as const,
    model: SIMULATED_MODEL,
    maxOutputTokens: r.maxOutputTokens,
    timeoutMs: r.timeoutMs,
  });
  return {
    ...s,
    routes: {
      TRADE_ANALYSIS: standIn(s.routes.TRADE_ANALYSIS),
      POST_TRADE_REVIEW: standIn(s.routes.POST_TRADE_REVIEW),
    },
    prices: { ...s.prices, [SIMULATED_MODEL]: ZERO },
  };
}

export interface AiRouteView {
  readonly task: AiTask;
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly available: boolean;
  readonly providerKind: DataSourceKind | null;
  readonly priced: boolean;
}

export interface AiStatusView {
  readonly configured: boolean;
  readonly enabled: boolean;
  /** Simulation mode with the SIMULATED stand-in (fixed rules, not an AI model). */
  readonly standIn: boolean;
  readonly killSwitchActive: boolean;
  readonly health: { readonly status: HealthStatus; readonly detail: string };
  readonly routes: readonly AiRouteView[];
  readonly serverSideFallbacks: boolean;
  /** How the gate uses an analysis (for strategies that require one). */
  readonly gate: { readonly minConfidence: number; readonly maxAgeMs: number };
  readonly budget: AiSettings['budget'];
  readonly usage: AiUsageToday;
  readonly postTradeReviewAuto: boolean;
  readonly recentCalls: readonly AiCallRecord[];
}

export function aiStatusView(
  o: AiOrchestrator,
  x: {
    configured: boolean;
    standIn: boolean;
    killSwitchActive: boolean;
    health: { status: HealthStatus; detail: string };
    gate: { minConfidence: number; maxAgeMs: number };
  },
): AiStatusView {
  const s = o.settings;
  return {
    configured: x.configured,
    enabled: s.enabled,
    standIn: x.standIn,
    killSwitchActive: x.killSwitchActive,
    health: x.health,
    routes: AI_TASKS.map((task) => {
      const r = o.route(task);
      const p = o.provider(task);
      return {
        task,
        provider: r.provider,
        model: r.model,
        effort: r.effort ?? null,
        maxOutputTokens: r.maxOutputTokens,
        timeoutMs: r.timeoutMs,
        available: p !== undefined,
        providerKind: p?.kind ?? null,
        priced: s.prices[r.model] !== undefined,
      };
    }),
    serverSideFallbacks: s.providers.anthropic?.serverSideFallbacks ?? false,
    gate: x.gate,
    budget: s.budget,
    usage: o.usage(),
    postTradeReviewAuto: s.postTradeReview.auto,
    recentCalls: o.recentCalls().slice(0, 25),
  };
}

/** Health text for the stand-in says plainly what it is. */
export function standInHealth(h: { status: HealthStatus; detail: string }) {
  return h.status === 'UNKNOWN'
    ? h
    : { ...h, detail: `SIMULATED stand-in (not an AI model); ${h.detail}` };
}
