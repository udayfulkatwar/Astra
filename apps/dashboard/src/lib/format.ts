/** Display formatting. All timestamps from the API are UTC; the UI shows UTC and local time. */
export function money(v: number | null | undefined, currency = 'USD'): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(v);
}

export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v);
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

export function utcTime(iso: string | null | undefined): string {
  return iso ? `${iso.slice(11, 19)}Z` : '—';
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z · ${d.toLocaleTimeString()} local`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 0) return 'in the future';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortHash(h: string): string {
  return h.replace(/^sha256:/, '').slice(0, 10);
}
