/**
 * AI Orchestrator: task → route → provider, with every safety rail in deterministic code.
 *
 * Before a call: kill switch, enabled flag, provider and price present, daily budget (calls and
 * worst-case cost). During: hard timeout. After: JSON parse + schema validation — output that
 * fails is INVALID and never repaired. Every attempt, sent or blocked, is written to the call log.
 */
import {
  errorMessage,
  notObserved,
  observed,
  type Clock,
  type HealthStatus,
  type Observed,
} from '@astra/core';
import type { AiPrice, AiRoute, AiSettings } from './settings';
import type {
  AiBlockReason,
  AiCallRecord,
  AiCallStatus,
  AiProvider,
  AiProviderResponse,
  AiTask,
  AiTaskDefinition,
  AiUsage,
} from './types';

export interface AiRun<O> {
  readonly result: Observed<O>;
  readonly call: AiCallRecord;
}

export interface AiUsageToday {
  /** UTC day the counters belong to. */
  readonly day: string;
  readonly calls: number;
  readonly costUsd: number;
  /** Worst-case cost of calls in flight. */
  readonly reservedUsd: number;
  readonly limits: { readonly dailyCalls: number; readonly dailyCostUsd: number };
}

export interface AiOrchestratorDeps {
  readonly clock: Clock;
  readonly settings: AiSettings;
  readonly providers: ReadonlyMap<string, AiProvider>;
  readonly killSwitchActive: () => boolean;
  /** Call-log sink (append-only table). A failing sink is reported, never hidden. */
  readonly record?: (call: AiCallRecord) => Promise<void> | void;
  readonly onRecordError?: (err: unknown, call: AiCallRecord) => void;
  readonly newCallId: () => string;
}

const RECENT = 50;
/** Rough upper estimate of tokens per character for budget reservation (JSON-heavy prompts). */
const TOKENS_PER_CHAR = 1 / 3;

export function callCostUsd(usage: AiUsage, price: AiPrice): number {
  const usd =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cacheReadTokens * price.cacheReadPerMTok +
      usage.cacheWriteTokens * price.cacheWritePerMTok) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

function worstCaseUsd(chars: number, route: AiRoute, price: AiPrice): number {
  const input = Math.ceil(chars * TOKENS_PER_CHAR);
  // Prompt-cache writes cost more than plain input: reserve at the higher of the two rates.
  const inRate = Math.max(price.inputPerMTok, price.cacheWritePerMTok);
  return (input * inRate + route.maxOutputTokens * price.outputPerMTok) / 1_000_000;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export class AiOrchestrator {
  private day: string;
  private calls = 0;
  private costUsd = 0;
  private reservedUsd = 0;
  private inFlight = 0;
  private readonly recent: AiCallRecord[] = [];

  constructor(private readonly deps: AiOrchestratorDeps) {
    this.day = utcDay(deps.clock.now());
  }

  get settings(): AiSettings {
    return this.deps.settings;
  }

  route(task: AiTask): AiRoute {
    return this.deps.settings.routes[task];
  }

  provider(task: AiTask): AiProvider | undefined {
    return this.deps.providers.get(this.route(task).provider);
  }

  /** Restores today's spend from the call log after a restart (ignored for another day). */
  seedUsage(
    u: { day: string; calls: number; costUsd: number },
    recent: readonly AiCallRecord[] = [],
  ): void {
    this.rollDay();
    if (u.day === this.day) {
      this.calls = u.calls;
      this.costUsd = u.costUsd;
    }
    this.recent.splice(0, this.recent.length, ...recent.slice(0, RECENT));
  }

  usage(): AiUsageToday {
    this.rollDay();
    const b = this.deps.settings.budget;
    return {
      day: this.day,
      calls: this.calls,
      costUsd: Math.round(this.costUsd * 1e6) / 1e6,
      reservedUsd: Math.round(this.reservedUsd * 1e6) / 1e6,
      limits: { dailyCalls: b.dailyCalls, dailyCostUsd: b.dailyCostUsd },
    };
  }

  /** Newest first. */
  recentCalls(): readonly AiCallRecord[] {
    return this.recent;
  }

  health(): { status: HealthStatus; detail: string } {
    const s = this.deps.settings;
    if (!s.enabled) return { status: 'UNKNOWN', detail: 'AI disabled in configuration' };
    if (this.deps.killSwitchActive()) {
      return { status: 'DEGRADED', detail: 'AI kill switch active: no model calls' };
    }
    const missing = (Object.keys(s.routes) as AiTask[]).filter((t) => !this.provider(t));
    if (missing.length === Object.keys(s.routes).length) {
      return { status: 'ERROR', detail: 'no AI provider available (API key not set?)' };
    }
    const u = this.usage();
    const used = Math.max(u.calls / u.limits.dailyCalls, u.costUsd / u.limits.dailyCostUsd);
    const last = this.recent.find((c) => c.status !== 'BLOCKED');
    const lastBad = last && last.status !== 'OK';
    const parts = [
      `${u.calls}/${u.limits.dailyCalls} calls, $${u.costUsd.toFixed(2)}/$${u.limits.dailyCostUsd.toFixed(2)} today`,
    ];
    if (missing.length > 0) parts.push(`no provider for ${missing.join(', ')}`);
    if (lastBad) parts.push(`last call ${last.status}`);
    if (used >= 1)
      return { status: 'DEGRADED', detail: `daily AI budget used: ${parts.join('; ')}` };
    if (used >= s.budget.degradeAt || missing.length > 0 || lastBad) {
      return { status: 'DEGRADED', detail: parts.join('; ') };
    }
    return { status: 'ONLINE', detail: parts.join('; ') };
  }

  async run<I, O>(def: AiTaskDefinition<I, O>, input: I, subjectId: string): Promise<AiRun<O>> {
    const { clock, settings } = this.deps;
    const route = this.route(def.task);
    const started = clock.now();
    const base = {
      callId: this.deps.newCallId(),
      task: def.task,
      subjectId,
      provider: route.provider,
      model: route.model,
      startedAt: started.toISOString(),
    };
    const source = `ai:${route.provider}`;
    const block = async (by: AiBlockReason, reason: string, kind: AiProvider['kind'] | null) => {
      const call: AiCallRecord = {
        ...base,
        providerKind: kind,
        servedModel: null,
        status: 'BLOCKED',
        blockedBy: by,
        latencyMs: 0,
        usage: null,
        costUsd: 0,
        costEstimated: false,
        fallbackUsed: false,
        error: reason,
      };
      await this.log(call);
      return { result: notObserved('UNAVAILABLE', reason, source), call };
    };

    if (this.deps.killSwitchActive()) return block('KILL_SWITCH', 'AI kill switch active', null);
    if (!settings.enabled) return block('DISABLED', 'AI disabled in configuration', null);
    const provider = this.deps.providers.get(route.provider);
    if (!provider) {
      return block('NO_PROVIDER', `AI provider "${route.provider}" not available`, null);
    }
    const price = settings.prices[route.model];
    if (!price) {
      return block(
        'NO_PRICE',
        `no price configured for model ${route.model}: budget cannot be enforced`,
        provider.kind,
      );
    }
    const prompt = def.prompt(input);
    const reserve = worstCaseUsd(def.system.length + prompt.length, route, price);
    this.rollDay();
    const b = settings.budget;
    if (this.calls + this.inFlight >= b.dailyCalls) {
      return block('BUDGET', `daily AI call limit reached (${b.dailyCalls})`, provider.kind);
    }
    if (this.costUsd + this.reservedUsd + reserve > b.dailyCostUsd) {
      return block(
        'BUDGET',
        `daily AI cost limit $${b.dailyCostUsd} would be exceeded (spent $${this.costUsd.toFixed(4)}, this call up to $${reserve.toFixed(4)})`,
        provider.kind,
      );
    }

    this.inFlight += 1;
    this.reservedUsd += reserve;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let response: AiProviderResponse | null = null;
    let failure: string | null = null;
    try {
      response = await Promise.race([
        provider.complete(
          {
            task: def.task,
            model: route.model,
            effort: route.effort,
            maxOutputTokens: route.maxOutputTokens,
            system: def.system,
            prompt,
            input,
            outputSchema: def.outputSchema,
          },
          controller.signal,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error(`no answer within ${route.timeoutMs}ms`));
          }, route.timeoutMs);
        }),
      ]);
    } catch (err) {
      failure = timedOut ? `no answer within ${route.timeoutMs}ms` : errorMessage(err);
    } finally {
      clearTimeout(timer);
      this.inFlight -= 1;
      this.reservedUsd = Math.max(0, this.reservedUsd - reserve);
    }

    const finished = clock.now();
    const servedModel = response?.servedModel ?? null;
    // A timed-out request may still be billed: it is charged at its worst case (an estimate).
    const costEstimated = !response && timedOut;
    const costUsd = response
      ? callCostUsd(response.usage, settings.prices[response.servedModel] ?? price)
      : costEstimated
        ? Math.round(reserve * 1e6) / 1e6
        : 0;
    this.rollDay();
    this.calls += 1;
    this.costUsd += costUsd;

    let status: AiCallStatus;
    let result: Observed<O>;
    let error: string | null = null;
    const meta = {
      source: `${source}/${servedModel ?? route.model}`,
      sourceKind: provider.kind,
      asOf: finished.toISOString(),
    };
    if (!response) {
      status = timedOut ? 'TIMEOUT' : 'ERROR';
      error = failure;
      result = notObserved(status, failure ?? 'provider failed', source);
    } else if (response.stop === 'REFUSED') {
      status = 'REFUSED';
      const r = response.refusal;
      error = `model declined${r?.category ? ` (${r.category})` : ''}${r?.explanation ? `: ${r.explanation}` : ''}`;
      result = notObserved('UNAVAILABLE', error, source);
    } else if (response.stop === 'TRUNCATED') {
      status = 'TRUNCATED';
      error = `output cut off at the ${route.maxOutputTokens}-token limit`;
      result = notObserved('INVALID', error, source);
    } else {
      const parsed = parseOutput(response.text, def.outputSchema);
      if (parsed.ok) {
        status = 'OK';
        result = observed(parsed.value, meta);
      } else {
        status = 'INVALID';
        error = parsed.error;
        result = notObserved('INVALID', `malformed AI output: ${parsed.error}`, source);
      }
    }

    const call: AiCallRecord = {
      ...base,
      providerKind: provider.kind,
      servedModel,
      status,
      blockedBy: null,
      latencyMs: finished.getTime() - started.getTime(),
      usage: response?.usage ?? null,
      costUsd,
      costEstimated,
      fallbackUsed: response?.fallbackUsed ?? false,
      error,
    };
    await this.log(call);
    return { result, call };
  }

  private rollDay(): void {
    const today = utcDay(this.deps.clock.now());
    if (today !== this.day) {
      this.day = today;
      this.calls = 0;
      this.costUsd = 0;
    }
  }

  private async log(call: AiCallRecord): Promise<void> {
    this.recent.unshift(call);
    if (this.recent.length > RECENT) this.recent.pop();
    try {
      await this.deps.record?.(call);
    } catch (err) {
      this.deps.onRecordError?.(err, call);
    }
  }
}

function parseOutput<O>(
  text: string,
  schema: AiTaskDefinition<unknown, O>['outputSchema'],
): { ok: true; value: O } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}
