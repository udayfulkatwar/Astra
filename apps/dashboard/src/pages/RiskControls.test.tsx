import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi, type ApiCall, type Reply, type Route } from '../test/api';
import { killSwitch, statusBar } from '../test/fixtures';
import { renderPage } from '../test/render';
import { RiskControls } from './RiskControls';
import type { KillSwitchState } from '../api/types';

const ACTIVATE = '/api/v1/kill-switches/activate';
const DEACTIVATE = '/api/v1/kill-switches/deactivate';

const accounts = {
  accounts: [{ account: { id: 'paper-demo' } }, { account: { id: 'paper-fx' } }],
};

/**
 * Risk Controls against a mock API whose kill-switch list is the server's truth: a successful
 * activate/deactivate changes it; a failed one leaves it as it was.
 */
function openRiskControls(
  opts: {
    switches?: KillSwitchState[];
    loaded?: boolean;
    activate?: (call: ApiCall) => Reply;
    deactivate?: (call: ApiCall) => Reply;
    setMode?: Route;
  } = {},
) {
  let switches = opts.switches ?? [];
  const apply = (call: ApiCall, active: boolean) => {
    const b = call.body as {
      scope: KillSwitchState['scope'];
      target: string | null;
      reason: string;
    };
    switches = [
      ...switches.filter((s) => !(s.scope === b.scope && s.target === b.target)),
      killSwitch({ scope: b.scope, target: b.target, reason: b.reason, active }),
    ];
    return { body: { ok: true } };
  };
  const api = mockApi({
    'GET /api/v1/kill-switches': () => ({
      body: { loaded: opts.loaded ?? true, switches },
    }),
    [`POST ${ACTIVATE}`]: (call) => opts.activate?.(call) ?? apply(call, true),
    [`POST ${DEACTIVATE}`]: (call) => opts.deactivate?.(call) ?? apply(call, false),
    'GET /api/v1/system/mode': {
      body: { mode: 'PAPER', loaded: true, state: null },
    },
    'POST /api/v1/system/mode': opts.setMode ?? { body: { mode: 'PAPER' } },
    'GET /api/v1/system/status': { body: statusBar() },
    'GET /api/v1/accounts': { body: accounts },
    'GET /api/v1/config/summary': { body: { strategies: [], instruments: [] } },
  });
  return { api, ...renderPage(<RiskControls />, { path: '/risk' }) };
}

const card = (title: string) => {
  const heading = screen.getByRole('heading', { name: title });
  return within(heading.closest('section')!);
};

describe('Risk Controls — emergency stop', () => {
  it('needs a confirmation, then activates the GLOBAL kill switch once', async () => {
    const { api, user } = openRiskControls();
    await user.click(screen.getByRole('button', { name: 'EMERGENCY STOP' }));
    expect(api.to('POST', ACTIVATE)).toHaveLength(0); // the first click only arms it

    await user.click(screen.getByRole('button', { name: 'Confirm: stop all new trading' }));
    await waitFor(() => expect(api.to('POST', ACTIVATE)).toHaveLength(1));
    expect(api.to('POST', ACTIVATE)[0]!.body).toEqual({
      scope: 'GLOBAL',
      target: null,
      reason: 'operator emergency stop',
    });
    // Success is what the server then reports, not a local message.
    const list = await screen.findByRole('heading', { name: 'Kill switches (1 active)' });
    expect(within(list.closest('section')!).getByText('GLOBAL')).toBeTruthy();
  });

  it('cancel sends nothing', async () => {
    const { api, user } = openRiskControls();
    await user.click(screen.getByRole('button', { name: 'EMERGENCY STOP' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'EMERGENCY STOP' })).toBeTruthy();
    expect(api.to('POST', ACTIVATE)).toHaveLength(0);
  });

  it('cannot be sent without a reason of at least 3 characters', async () => {
    const { user } = openRiskControls();
    await user.clear(screen.getByLabelText('Reason (recorded in the audit log)'));
    await user.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'no');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'EMERGENCY STOP' }).disabled).toBe(
      true,
    );
  });

  it('a refused request is reported as failed and nothing shows as active', async () => {
    const { user } = openRiskControls({
      activate: () => apiError(403, 'FORBIDDEN', 'role viewer may not do this'),
    });
    await user.click(screen.getByRole('button', { name: 'EMERGENCY STOP' }));
    await user.click(screen.getByRole('button', { name: 'Confirm: stop all new trading' }));
    expect(
      await card('Emergency stop').findByText(
        'Kill-switch request failed: role viewer may not do this',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Kill switches (0 active)' })).toBeTruthy();
    expect(screen.queryByText('ACTIVE')).toBeNull();
  });
});

describe('Risk Controls — activate a kill switch', () => {
  it('sends the chosen scope, target and reason', async () => {
    const { api, user } = openRiskControls();
    const form = card('Activate a kill switch');
    await screen.findByRole('option', { name: 'paper-demo' });
    await user.selectOptions(form.getByLabelText('Target'), 'paper-demo');
    await user.type(form.getByPlaceholderText('reason (audited)'), 'manual review');
    await user.click(form.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(api.to('POST', ACTIVATE)).toHaveLength(1));
    expect(api.to('POST', ACTIVATE)[0]!.body).toEqual({
      scope: 'ACCOUNT',
      target: 'paper-demo',
      reason: 'manual review',
    });
  });

  it('a GLOBAL switch has no target', async () => {
    const { api, user } = openRiskControls();
    const form = card('Activate a kill switch');
    await user.selectOptions(form.getByLabelText('Scope'), 'GLOBAL');
    expect(form.queryByLabelText('Target')).toBeNull();
    await user.type(form.getByPlaceholderText('reason (audited)'), 'halt everything');
    await user.click(form.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(api.to('POST', ACTIVATE)).toHaveLength(1));
    expect(api.to('POST', ACTIVATE)[0]!.body).toEqual({
      scope: 'GLOBAL',
      target: null,
      reason: 'halt everything',
    });
  });

  it('a failed request is reported and keeps the typed reason (no reset that looks like success)', async () => {
    const { user } = openRiskControls({
      activate: () => apiError(500, 'INTERNAL', 'database unavailable'),
    });
    const form = card('Activate a kill switch');
    await screen.findByRole('option', { name: 'paper-demo' });
    await user.selectOptions(form.getByLabelText('Target'), 'paper-demo');
    await user.type(form.getByPlaceholderText('reason (audited)'), 'manual review');
    await user.click(form.getByRole('button', { name: 'Activate' }));
    expect(await form.findByText('Kill-switch request failed: database unavailable')).toBeTruthy();
    expect(form.getByPlaceholderText<HTMLInputElement>('reason (audited)').value).toBe(
      'manual review',
    );
  });
});

describe('Risk Controls — clear a kill switch', () => {
  const active = killSwitch({ scope: 'ACCOUNT', target: 'paper-demo', active: true });

  it('requires a written reason and sends the switch’s scope and target', async () => {
    const { api, user } = openRiskControls({ switches: [active] });
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    const why = screen.getByLabelText('Why is it safe to clear this kill switch?');
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Clear switch' });
    expect(submit.disabled).toBe(true);
    await user.type(why, 'reviewed, safe');
    await user.click(submit);
    await waitFor(() => expect(api.to('POST', DEACTIVATE)).toHaveLength(1));
    expect(api.to('POST', DEACTIVATE)[0]!.body).toEqual({
      scope: 'ACCOUNT',
      target: 'paper-demo',
      reason: 'reviewed, safe',
    });
    expect(await screen.findByRole('heading', { name: 'Kill switches (0 active)' })).toBeTruthy();
  });

  it('a failed clear is reported, the switch stays ACTIVE and the reason is kept', async () => {
    const { user } = openRiskControls({
      switches: [active],
      deactivate: () => apiError(403, 'FORBIDDEN', 'only an operator may clear kill switches'),
    });
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    await user.type(
      screen.getByLabelText('Why is it safe to clear this kill switch?'),
      'reviewed, safe',
    );
    await user.click(screen.getByRole('button', { name: 'Clear switch' }));
    expect(
      await screen.findByText(
        'Kill-switch request failed: only an operator may clear kill switches',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Kill switches (1 active)' })).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLInputElement>('Why is it safe to clear this kill switch?').value,
    ).toBe('reviewed, safe');
  });

  it('kill-switch state not loaded is shown as everything blocked', async () => {
    openRiskControls({ loaded: false });
    expect(
      await screen.findByText(
        'Kill-switch state NOT loaded — everything is blocked (fail-closed).',
      ),
    ).toBeTruthy();
  });
});

describe('Risk Controls — trading mode', () => {
  it('LIVE needs a second, explicit confirmation before anything is sent', async () => {
    const { api, user } = openRiskControls();
    const mode = card('Trading mode');
    await mode.findByText('Current');
    await user.selectOptions(mode.getByLabelText('New mode'), 'LIVE');
    await user.type(mode.getByPlaceholderText('reason (audited)'), 'owner go-live');
    await user.click(mode.getByRole('button', { name: 'Change mode' }));
    expect(api.to('POST', '/api/v1/system/mode')).toHaveLength(0);
    expect(mode.getByText(/LIVE mode sends real orders/)).toBeTruthy();

    await user.click(mode.getByRole('button', { name: 'Confirm LIVE (real orders)' }));
    await waitFor(() => expect(api.to('POST', '/api/v1/system/mode')).toHaveLength(1));
    expect(api.to('POST', '/api/v1/system/mode')[0]!.body).toEqual({
      mode: 'LIVE',
      reason: 'owner go-live',
    });
  });

  it('a refused mode change is reported as failed; the current mode stays as the server says', async () => {
    const { user } = openRiskControls({
      setMode: apiError(409, 'LIVE_NOT_AUTHORIZED', 'live trading is not authorized'),
    });
    const mode = card('Trading mode');
    await mode.findByText('Current');
    await user.selectOptions(mode.getByLabelText('New mode'), 'LIVE');
    await user.type(mode.getByPlaceholderText('reason (audited)'), 'owner go-live');
    await user.click(mode.getByRole('button', { name: 'Change mode' }));
    await user.click(mode.getByRole('button', { name: 'Confirm LIVE (real orders)' }));
    expect(
      await mode.findByText('Mode change failed: live trading is not authorized'),
    ).toBeTruthy();
    // The "Current" mode badge (not the dropdown option) still says PAPER.
    expect(mode.getByText('PAPER', { selector: '.pill' })).toBeTruthy();
    expect(mode.queryByText('LIVE', { selector: '.pill' })).toBeNull();
  });
});
