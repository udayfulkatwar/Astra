/**
 * Minimal API client. The bearer token is typed by the operator at login and kept in
 * sessionStorage for this tab only — it is never part of the bundle.
 */
const TOKEN_KEY = 'astra.token';

/**
 * Demo build (`vite build --mode demo`): every call is answered by the in-browser demo runtime
 * (real engines, SIMULATED data) instead of the ASTRA API. Normal builds never include it.
 */
export const DEMO: boolean = __ASTRA_DEMO__;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: the session will not persist across reloads */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('astra:logout'));
}

export async function api<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  if (__ASTRA_DEMO__) {
    const { handleDemoRequest } = await import('../demo/router');
    const result = await handleDemoRequest(init.method ?? 'GET', path, init.body);
    // Round-trip through JSON exactly like an HTTP response would.
    return JSON.parse(JSON.stringify(result ?? null)) as T;
  }
  const token = getToken();
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; requestId?: string } } | null)
      ?.error;
    if (res.status === 401) clearToken();
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `HTTP ${res.status}`,
      err?.requestId,
    );
  }
  return data as T;
}

/** Validates a token by calling a read endpoint. */
export async function verifyToken(token: string): Promise<boolean> {
  const res = await fetch('/api/v1/system/mode', { headers: { Authorization: `Bearer ${token}` } });
  return res.ok;
}
