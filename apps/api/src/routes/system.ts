/** Liveness/readiness, the core status bar (spec §67), component health, mode control. */
import { modePolicy, TradingModeSchema, worstHealth, type HealthStatus } from '@astra/core';
import { pingDb } from '@astra/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { READ_ROLES, requireRole, type TokenAuthenticator } from '../auth';
import type { AstraRuntime } from '../runtime/runtime';

const RISK_ORDER = ['SAFE', 'CAUTION', 'RESTRICTED', 'BREACH_RISK', 'UNKNOWN', 'HALTED'];

export function statusBar(runtime: AstraRuntime) {
  const now = runtime.clock.now();
  const policy = runtime.config.system.decision;
  const components = runtime.health.registry.snapshot();
  const byId = Object.fromEntries(components.map((c) => [c.component, c]));
  const required = policy.requiredComponents.map((c) => byId[c]!.status);
  const system: HealthStatus = runtime.isInitialized() ? worstHealth(required) : 'ERROR';

  const mode = runtime.mode.current();
  const globalSwitch = runtime.killSwitches
    .list()
    .find(
      (s) => s.active && (s.scope === 'GLOBAL' || (s.scope === 'EXECUTION' && s.target === null)),
    );
  const tradingReasons: string[] = [];
  if (!runtime.isInitialized())
    tradingReasons.push(
      `core not initialized${runtime.initializationError() ? `: ${runtime.initializationError()}` : ''}`,
    );
  if (!modePolicy(mode).newTradesAllowed) tradingReasons.push(`mode ${mode}`);
  if (globalSwitch)
    tradingReasons.push(`${globalSwitch.scope} kill switch: ${globalSwitch.reason}`);
  const acceptable = policy.allowDegradedComponents ? ['ONLINE', 'DEGRADED'] : ['ONLINE'];
  for (const c of policy.requiredComponents) {
    if (!acceptable.includes(byId[c]!.status)) tradingReasons.push(`${c} ${byId[c]!.status}`);
  }

  const healths = runtime.accounts.views().map((v) => v.health?.health ?? 'UNKNOWN');
  const risk =
    healths.length === 0
      ? 'UNKNOWN'
      : healths.reduce((w, h) => (RISK_ORDER.indexOf(h) > RISK_ORDER.indexOf(w) ? h : w), 'SAFE');

  const upcoming = runtime.calendar.upcoming(now, new Date(now.getTime() + 4 * 3_600_000));
  const highImpact =
    upcoming.status === 'OK'
      ? upcoming.value.events.filter((e) => e.impact === 'HIGH' || e.impact === 'UNKNOWN').length
      : null;

  return {
    now: now.toISOString(),
    system,
    initialized: runtime.isInitialized(),
    mode,
    trading: { enabled: tradingReasons.length === 0, reasons: tradingReasons },
    risk,
    news: { status: byId.NEWS!.status, detail: byId.NEWS!.detail },
    calendar: {
      status: byId.CALENDAR!.status,
      highImpactNext4h: highImpact,
      source: upcoming.status === 'OK' ? upcoming.sourceKind : null,
    },
    ai: { status: byId.AI!.status, detail: byId.AI!.detail },
    automation: { status: byId.AUTOMATION!.status, detail: byId.AUTOMATION!.detail },
    data: { status: byId.MARKET_DATA!.status, detail: byId.MARKET_DATA!.detail },
    killSwitchesActive: runtime.killSwitches.list().filter((s) => s.active).length,
    simulation: runtime.simulation !== null,
    configHash: runtime.config.hash,
    configWarnings: runtime.config.warnings,
  };
}

export function registerSystemRoutes(
  app: FastifyInstance,
  runtime: AstraRuntime,
  auth: TokenAuthenticator,
): void {
  const read = { preHandler: requireRole(auth, ...READ_ROLES) };
  const operator = { preHandler: requireRole(auth, 'operator') };

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const db = await pingDb(runtime.sql);
    const ready = runtime.isInitialized() && db;
    return reply.status(ready ? 200 : 503).send({
      ready,
      initialized: runtime.isInitialized(),
      database: db ? 'ONLINE' : 'ERROR',
      error: runtime.initializationError(),
    });
  });

  app.get('/api/v1/system/status', read, () => statusBar(runtime));
  app.get('/api/v1/system/health', read, () => ({
    components: runtime.health.registry.snapshot(),
  }));
  app.get('/api/v1/system/mode', read, () => runtime.mode.info());

  const ModeBody = z.object({ mode: TradingModeSchema, reason: z.string().min(3).max(500) });
  app.post('/api/v1/system/mode', operator, async (req) => {
    const body = ModeBody.parse(req.body);
    const state = await runtime.mode.set(
      body.mode,
      { type: 'HUMAN', id: req.principal!.id },
      body.reason,
    );
    return { mode: state.mode, state };
  });

  app.get('/api/v1/config/summary', read, () => {
    const c = runtime.config;
    return {
      hash: c.hash,
      warnings: c.warnings,
      decisionPolicy: c.system.decision,
      profiles: [...c.profiles.values()],
      riskPolicies: [...c.riskPolicies.values()],
      instruments: [...c.instruments.values()],
      strategies: [...c.strategies.values()],
    };
  });
}
