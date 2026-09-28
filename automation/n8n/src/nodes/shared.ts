/**
 * Helpers shared by every code node. The workflow builder inlines this file into each Code node
 * (n8n code nodes cannot import modules), so it must stay self-contained and dependency-free.
 */
export type Json = Record<string, unknown>;

export interface Ctx {
  readonly now: Date;
  readonly executionId: string;
  /** n8n workflow static data (persisted only for active, trigger-started executions). */
  readonly staticData: Record<string, unknown>;
  /** Outputs of earlier nodes, by the names the builder passes. */
  readonly extra: Record<string, Json[]>;
}

/** FNV-1a 64-bit, hex: short, stable ids for items a source does not identify. */
export function fnv(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** A string field, or `fallback` when the value is missing or not a string. */
export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** ISO-8601 UTC from a date string; null when it cannot be read (never guessed). */
export function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function requireSlug(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) {
    throw new Error(
      `${what} must be a short lowercase name (a-z, 0-9, -), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function requireHttpUrl(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s]+$/.test(value)) {
    throw new Error(`${what} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  return value;
}
