/**
 * "Normalise" — calendar source(s) → one ASTRA calendar window for POST /api/v1/calendar/window.
 *
 * A window asserts that it lists EVERY event between `from` and `to`. For weekly exports that is
 * only claimed from the first to the last listed event (conservative: never beyond what the file
 * covers). Unknown impact labels become UNKNOWN, which ASTRA treats as HIGH (fail-safe). Any
 * malformed field stops the workflow: nothing is pushed, the calendar ages to stale, no trades.
 */
import { fnv, isoOrNull, truncate, type Ctx, type Json } from './shared';

export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly currency?: string;
  readonly impact: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  readonly scheduledAt: string;
  readonly affectedInstruments: string[];
  readonly expected?: string;
  readonly previous?: string;
}

export interface Window {
  readonly from: string;
  readonly to: string;
  readonly events: CalendarEvent[];
}

const FF_IMPACT: Record<string, CalendarEvent['impact']> = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  holiday: 'LOW',
};

const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

export function fromFfWeekly(data: unknown, source: string): Window {
  if (!Array.isArray(data)) throw new Error(`${source}: expected a JSON array of events`);
  if (data.length === 0) throw new Error(`${source}: the export lists no events`);
  const events = data.map((raw: unknown, i): CalendarEvent => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const title = text(e.title);
    const scheduledAt = isoOrNull(e.date);
    if (!title || !scheduledAt) {
      throw new Error(`${source}: event ${i + 1} has no readable title or date`);
    }
    const country = text(e.country);
    const impact = FF_IMPACT[(text(e.impact) ?? '').toLowerCase()] ?? 'UNKNOWN';
    const expected = text(e.forecast);
    const previous = text(e.previous);
    return {
      id: `ff:${fnv(`${title}|${country ?? ''}|${scheduledAt}`)}`,
      title: truncate(
        impact === 'LOW' && /holiday/i.test(String(e.impact)) ? `Holiday: ${title}` : title,
        300,
      ),
      ...(country && /^[A-Z]{3}$/.test(country) ? { currency: country } : {}),
      impact,
      scheduledAt,
      affectedInstruments: [],
      ...(expected ? { expected: truncate(expected, 100) } : {}),
      ...(previous ? { previous: truncate(previous, 100) } : {}),
    };
  });
  const times = events.map((e) => Date.parse(e.scheduledAt)).sort((a, b) => a - b);
  return {
    from: new Date(times[0]!).toISOString(),
    to: new Date(times.at(-1)! + 60_000).toISOString(),
    events,
  };
}

export function fromAstraWindow(data: unknown, source: string): Window {
  const w = (data as { window?: unknown })?.window ?? data;
  const o = (w ?? {}) as Record<string, unknown>;
  const from = isoOrNull(o.from);
  const to = isoOrNull(o.to);
  if (!from || !to || !Array.isArray(o.events)) {
    throw new Error(`${source}: expected { from, to, events[] }`);
  }
  return { from, to, events: o.events as CalendarEvent[] };
}

/**
 * Joins windows that touch or overlap — a gap between two sources must never be claimed as
 * "no events". When sources leave a gap, only the contiguous group that covers `now` (else the
 * next one) is pushed; the others are listed as left out.
 */
export function mergeWindows(
  windows: readonly (Window & { name: string })[],
  now: Date,
): { window: Window; used: string[]; leftOut: string[] } {
  const sorted = [...windows].sort((a, b) => a.from.localeCompare(b.from));
  const groups: (Window & { names: string[] })[] = [];
  for (const w of sorted) {
    const last = groups.at(-1);
    if (last && Date.parse(w.from) <= Date.parse(last.to)) {
      last.names.push(w.name);
      const byId = new Map(last.events.map((e) => [e.id, e]));
      for (const e of w.events) byId.set(e.id, e);
      groups[groups.length - 1] = {
        from: last.from,
        to: w.to > last.to ? w.to : last.to,
        events: [...byId.values()].sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt)),
        names: last.names,
      };
    } else {
      groups.push({ from: w.from, to: w.to, events: [...w.events], names: [w.name] });
    }
  }
  const t = now.getTime();
  const chosen =
    groups.find((g) => Date.parse(g.from) <= t && t < Date.parse(g.to)) ??
    groups.find((g) => Date.parse(g.to) > t) ??
    groups.at(-1)!;
  return {
    window: { from: chosen.from, to: chosen.to, events: chosen.events },
    used: chosen.names,
    leftOut: groups.filter((g) => g !== chosen).flatMap((g) => g.names),
  };
}

export function run(fetched: Json[], ctx: Ctx): Json[] {
  const sources = ctx.extra.sources ?? [];
  if (fetched.length !== sources.length) {
    throw new Error(
      `fetched ${fetched.length} calendar sources but ${sources.length} are configured`,
    );
  }
  const windows = fetched.map((f, i) => {
    const s = sources[i]!;
    const name = String(s.name);
    let data: unknown;
    try {
      data = JSON.parse(String(f.data));
    } catch {
      throw new Error(`calendar source ${name}: the response is not JSON`);
    }
    const w =
      s.format === 'ff-weekly-json' ? fromFfWeekly(data, name) : fromAstraWindow(data, name);
    return { ...w, name };
  });
  const { window, used, leftOut } = mergeWindows(windows, ctx.now);
  return [
    {
      source: `n8n-${used.join('+')}`.slice(0, 100),
      window,
      leftOut,
      workflowRunId: ctx.executionId,
    },
  ];
}
