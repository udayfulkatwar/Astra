/**
 * "Build candidate" — an external alert (e.g. a TradingView webhook) → an ASTRA trade candidate.
 *
 * This only reshapes the alert; it decides nothing. ASTRA's gate checks the strategy, account,
 * prices, news, calendar, risk and prop-firm rules like for any other signal. A retried alert
 * gets the same signal id (same fields within the same minute), so ASTRA's duplicate check
 * refuses to approve it twice. Anything missing or malformed stops the workflow.
 */
import { fnv, isoOrNull, str, truncate, type Ctx, type Json } from './shared';

const DIRECTIONS: Record<string, 'LONG' | 'SHORT'> = {
  long: 'LONG',
  buy: 'LONG',
  short: 'SHORT',
  sell: 'SHORT',
};

function positive(v: unknown, field: string): number {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`alert field "${field}" must be a positive number, got ${JSON.stringify(v)}`);
  }
  return n;
}

function required(v: unknown, field: string, re: RegExp, hint: string): string {
  if (typeof v !== 'string' || !re.test(v)) {
    throw new Error(`alert field "${field}" must be ${hint}, got ${JSON.stringify(v)}`);
  }
  return v;
}

export function alertBody(item: Json): Record<string, unknown> {
  const body = item.body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error('the alert body is not JSON');
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body))
    return body as Record<string, unknown>;
  throw new Error('the alert has no JSON body');
}

export function toCandidate(a: Record<string, unknown>, now: Date, runId: string): Json {
  const accountId = required(
    a.accountId,
    'accountId',
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    'an ASTRA account id',
  );
  const strategyId = required(
    a.strategyId,
    'strategyId',
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    'an ASTRA strategy id',
  );
  const symbol = required(
    typeof a.symbol === 'string' ? a.symbol.toUpperCase() : a.symbol,
    'symbol',
    /^[A-Z0-9][A-Z0-9._-]{0,31}$/,
    'an ASTRA instrument symbol',
  );
  const direction = DIRECTIONS[str(a.direction).trim().toLowerCase()];
  if (!direction) throw new Error('alert field "direction" must be LONG/SHORT (or buy/sell)');
  const entry = positive(a.entry, 'entry');
  const stop = positive(a.stop, 'stop');
  const target = positive(a.target, 'target');
  const detectedAt =
    a.time === undefined || a.time === null
      ? now.toISOString()
      : typeof a.time === 'number'
        ? new Date(a.time).toISOString()
        : isoOrNull(a.time);
  if (!detectedAt)
    throw new Error(`alert field "time" is not a readable time: ${JSON.stringify(a.time)}`);
  const given = typeof a.signalId === 'string' ? a.signalId.trim() : '';
  const id =
    given !== ''
      ? required(given, 'signalId', /^[A-Za-z0-9_.:-]{1,100}$/, 'letters, digits and _ . : -')
      : `wh-${fnv([strategyId, accountId, symbol, direction, entry, stop, target, detectedAt.slice(0, 16)].join('|'))}`;
  const rationale = (Array.isArray(a.rationale) ? a.rationale : a.rationale ? [a.rationale] : [])
    .map((r) => truncate(String(r), 300))
    .slice(0, 10);
  const timeframe =
    typeof a.timeframe === 'string' && a.timeframe.trim() !== '' ? a.timeframe.trim() : undefined;
  return {
    candidate: {
      accountId,
      workflowRunId: runId,
      signal: {
        id,
        strategyId,
        symbol,
        direction,
        setupState: 'QUALIFIED',
        entryType: 'MARKET',
        entry,
        stop,
        target,
        ...(timeframe ? { timeframe } : {}),
        detectedAt,
        rationale: rationale.length > 0 ? rationale : ['external alert via n8n'],
        features: {},
      },
    },
    // Execution still needs an approval in a mode that allows automatic execution (never LIVE).
    autoExecute: a.autoExecute === true,
  };
}

export function run(items: Json[], ctx: Ctx): Json[] {
  return items.map((item) => toCandidate(alertBody(item), ctx.now, ctx.executionId));
}
