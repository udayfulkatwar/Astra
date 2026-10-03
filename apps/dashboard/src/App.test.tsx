import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockApi, networkDown, type Route } from './test/api';
import { OPERATOR_TOKEN, statusBar } from './test/fixtures';

const TOKEN_KEY = 'astra.token';

/** What the dashboard shell and the Overview page read once signed in. */
const SHELL: Record<string, Route> = {
  'GET /api/v1/system/mode': { body: { mode: 'PAPER', loaded: true, state: null } },
  'GET /api/v1/system/status': { body: statusBar() },
  'GET /api/v1/accounts': { body: { accounts: [] } },
  'GET /api/v1/decisions': { body: { decisions: [] } },
  'GET /api/v1/kill-switches': { body: { loaded: true, switches: [] } },
  'GET /api/v1/market/quotes': { body: { quotes: [] } },
};

/**
 * A fresh App per test: the app keeps its router and query cache at module level, as in the
 * browser, so each test imports a new copy.
 */
async function renderApp() {
  vi.resetModules();
  const { App } = await import('./App');
  const user = userEvent.setup();
  return { user, ...render(<App />) };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('Login', () => {
  it('without a token shows the login screen and reads no data', async () => {
    const api = mockApi(SHELL);
    await renderApp();
    expect(screen.getByLabelText('Access token')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('a token the API accepts signs in, is kept for this tab and is sent on every request', async () => {
    const api = mockApi(SHELL);
    const { user } = await renderApp();
    await user.type(screen.getByLabelText('Access token'), OPERATOR_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(OPERATOR_TOKEN);
    expect(api.to('GET', '/api/v1/system/mode')[0]!.authorization).toBe(`Bearer ${OPERATOR_TOKEN}`);
    await waitFor(() => expect(api.to('GET', '/api/v1/system/status').length).toBeGreaterThan(0));
    expect(api.calls.every((c) => c.authorization === `Bearer ${OPERATOR_TOKEN}`)).toBe(true);
  });

  it('a token the API rejects keeps the operator out and stores nothing', async () => {
    mockApi({ 'GET /api/v1/system/mode': apiError(401, 'UNAUTHORIZED', 'invalid token') });
    const { user } = await renderApp();
    await user.type(screen.getByLabelText('Access token'), 'wrong-token');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Token rejected by the ASTRA API.')).toBeTruthy();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('an unreachable API is reported as such, not as a wrong token', async () => {
    mockApi({ 'GET /api/v1/system/mode': networkDown });
    const { user } = await renderApp();
    await user.type(screen.getByLabelText('Access token'), OPERATOR_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Cannot reach the ASTRA API.')).toBeTruthy();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe('Signed-in session', () => {
  it('navigates between pages from the main menu', async () => {
    sessionStorage.setItem(TOKEN_KEY, OPERATOR_TOKEN);
    mockApi(SHELL);
    const { user } = await renderApp();
    const menu = await screen.findByRole('navigation', { name: 'Main' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Command Center' })).toBeTruthy();

    await user.click(screen.getByRole('link', { name: 'Risk Controls' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Risk Controls' })).toBeTruthy();
    expect(window.location.pathname).toBe('/risk');

    await user.click(screen.getByRole('link', { name: 'Trade Approval Center' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Trade Approval Center' }),
    ).toBeTruthy();
    expect(menu).toBeTruthy();
  });

  it('an expired or revoked token (401 from the API) signs the operator out', async () => {
    sessionStorage.setItem(TOKEN_KEY, OPERATOR_TOKEN);
    mockApi({
      ...SHELL,
      'GET /api/v1/system/status': apiError(401, 'UNAUTHORIZED', 'token expired'),
    });
    await renderApp();
    expect(await screen.findByLabelText('Access token')).toBeTruthy();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });
});
