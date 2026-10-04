/**
 * Deterministic stand-in for the ASTRA API in UI tests: answers `fetch` from a route table and
 * records every request. Unlisted routes answer 404 in the API's error envelope. Nothing leaves
 * the test: no network, no real credentials, no broker, no orders.
 */
import { vi } from 'vitest';

export interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

export type Route = Reply | ((call: ApiCall) => Reply | Promise<Reply>);

/** The API's error envelope (`{ error: { code, message, requestId } }`, apps/api/src/app.ts). */
export const apiError = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { code, message, requestId: 'req-test' } },
});

/** A route whose request fails before any response (server down, connection refused). */
export const networkDown: Route = () => {
  throw new TypeError('Failed to fetch');
};

function urlOf(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, 'http://localhost');
}

export function mockApi(routes: Record<string, Route>) {
  const calls: ApiCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = urlOf(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const call: ApiCall = {
      method,
      path: url.pathname,
      query: url.search,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      authorization: new Headers(init.headers).get('Authorization'),
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    const reply =
      route === undefined
        ? apiError(404, 'NOT_FOUND', `no mock for ${method} ${url.pathname}`)
        : typeof route === 'function'
          ? await route(call)
          : route;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    /** Requests made to one route, in order. */
    to: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

/** A reply held back until `release()`, to observe the UI while the request is in flight. */
export function heldReply(reply: Reply): { route: Route; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    route: async () => {
      await gate;
      return reply;
    },
    release: () => release(),
  };
}
