import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setToken } from '../api/client';
import { apiError, heldReply, mockApi, type Route } from '../test/api';
import { OPERATOR_TOKEN, decisionDetail, statusBar } from '../test/fixtures';
import { renderPage } from '../test/render';
import { Approvals, DecisionDetailPage } from './Approvals';

const EXECUTIONS = '/api/v1/executions';
const CONFIRMED = {
  outcome: 'CONFIRMED',
  reasons: ['paper order filled'],
  order: null,
  brokerState: null,
};

function openDecision(detail: ReturnType<typeof decisionDetail>, execute?: Route) {
  setToken(OPERATOR_TOKEN);
  const api = mockApi({
    'GET /api/v1/decisions/dec-test-001': { body: detail },
    'GET /api/v1/system/status': { body: statusBar() },
    ...(execute ? { [`POST ${EXECUTIONS}`]: execute } : {}),
  });
  const view = renderPage(<DecisionDetailPage />, {
    path: '/approvals/:id',
    url: '/approvals/dec-test-001',
  });
  return { api, ...view };
}

/** The Execute button once ASTRA's clock (the status) is known, so expiry is judged on it. */
async function executeButton() {
  await screen.findByText(/state/);
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Execute (operator)' });
}

describe('Trade Approval Center — decision detail', () => {
  it('a rejected decision offers no way to execute', async () => {
    const { api } = openDecision(decisionDetail({ status: 'REJECTED' }));
    expect(await screen.findByText('FINAL STATUS: REJECTED')).toBeTruthy();
    expect(screen.getAllByText(/daily loss limit reached/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();
    expect(api.to('POST', EXECUTIONS)).toHaveLength(0);
  });

  it('a pending approval past its expiry (on ASTRA’s clock) cannot be executed', async () => {
    const { api, user } = openDecision(
      decisionDetail({
        status: 'APPROVED',
        approvalState: 'PENDING',
        expiresAt: '2026-10-03T13:59:59.000Z', // one second before ASTRA's "now"
      }),
    );
    expect(await screen.findByText('(expired)')).toBeTruthy();
    const button = await executeButton();
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(screen.queryByRole('button', { name: /^Confirm/ })).toBeNull();
    expect(api.to('POST', EXECUTIONS)).toHaveLength(0);
  });

  it.each(['EXPIRED', 'CONSUMED'] as const)(
    'an approval the server marks %s cannot be executed',
    async (approvalState) => {
      const { api } = openDecision(decisionDetail({ status: 'APPROVED', approvalState }));
      expect(await screen.findByText(approvalState)).toBeTruthy();
      expect((await executeButton()).disabled).toBe(true);
      expect(api.to('POST', EXECUTIONS)).toHaveLength(0);
    },
  );

  it('a pending approval executes once through POST /api/v1/executions, showing progress, then the result', async () => {
    const held = heldReply({ body: CONFIRMED });
    const { api, user } = openDecision(
      decisionDetail({ status: 'APPROVED', approvalState: 'PENDING' }),
      held.route,
    );
    await user.click(await executeButton());
    await user.click(screen.getByRole('button', { name: 'Confirm LONG 2 MNQ (PAPER)' }));

    // In flight: the request is visible and nothing can be sent a second time.
    expect(await screen.findByText('Sending to the execution gateway…')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /execute/i }).disabled).toBe(true);
    expect(screen.queryByText('CONFIRMED')).toBeNull();
    expect(api.to('POST', EXECUTIONS)).toEqual([
      expect.objectContaining({
        body: { approvalId: 'apr-test-001' },
        authorization: `Bearer ${OPERATOR_TOKEN}`,
      }),
    ]);

    held.release();
    expect(await screen.findByText('CONFIRMED')).toBeTruthy();
    expect(screen.getByText(/paper order filled/)).toBeTruthy();
    expect(screen.queryByText('Sending to the execution gateway…')).toBeNull();
    expect(api.to('POST', EXECUTIONS)).toHaveLength(1);
  });

  it('cancelling the confirmation sends nothing', async () => {
    const { api, user } = openDecision(
      decisionDetail({ status: 'APPROVED', approvalState: 'PENDING' }),
      { body: CONFIRMED },
    );
    await user.click(await executeButton());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Execute (operator)' })).toBeTruthy();
    expect(api.to('POST', EXECUTIONS)).toHaveLength(0);
  });

  it('a gateway rejection is shown as REJECTED with its reason, never as success', async () => {
    const { user } = openDecision(
      decisionDetail({ status: 'APPROVED', approvalState: 'PENDING' }),
      {
        body: {
          outcome: 'REJECTED',
          reasons: ['kill switch ACCOUNT paper-demo is active'],
          order: null,
          brokerState: null,
        },
      },
    );
    await user.click(await executeButton());
    await user.click(screen.getByRole('button', { name: /^Confirm LONG/ }));
    expect(await screen.findByText(/kill switch ACCOUNT paper-demo is active/)).toBeTruthy();
    expect(screen.getByText('REJECTED')).toBeTruthy();
    expect(screen.queryByText('CONFIRMED')).toBeNull();
  });

  it('an outcome the gateway cannot confirm stays UNKNOWN, not CONFIRMED', async () => {
    const { user } = openDecision(
      decisionDetail({ status: 'APPROVED', approvalState: 'PENDING' }),
      {
        body: {
          outcome: 'UNKNOWN',
          reasons: ['broker did not confirm the order; trading halted'],
          order: null,
          brokerState: null,
        },
      },
    );
    await user.click(await executeButton());
    await user.click(screen.getByRole('button', { name: /^Confirm LONG/ }));
    expect(await screen.findByText(/broker did not confirm the order/)).toBeTruthy();
    expect(screen.getByText('UNKNOWN')).toBeTruthy();
    expect(screen.queryByText('CONFIRMED')).toBeNull();
  });

  it('an HTTP failure is reported as a failed execution request', async () => {
    const { user } = openDecision(
      decisionDetail({ status: 'APPROVED', approvalState: 'PENDING' }),
      apiError(503, 'NOT_READY', 'core is initializing'),
    );
    await user.click(await executeButton());
    await user.click(screen.getByRole('button', { name: /^Confirm LONG/ }));
    expect(await screen.findByText('Execution request failed: core is initializing')).toBeTruthy();
    expect(screen.queryByText('CONFIRMED')).toBeNull();
  });

  it('a 403 tells the operator the role is missing', async () => {
    const { user } = openDecision(
      decisionDetail({ status: 'APPROVED', approvalState: 'PENDING' }),
      apiError(403, 'FORBIDDEN', 'role viewer may not do this'),
    );
    await user.click(await executeButton());
    await user.click(screen.getByRole('button', { name: /^Confirm LONG/ }));
    expect(
      await screen.findByText(
        'Execution request failed: Only the operator role may execute approvals.',
      ),
    ).toBeTruthy();
  });
});

describe('Trade Approval Center — list', () => {
  it('lists each decision with its final status and first reason', async () => {
    const rejected = decisionDetail({ status: 'REJECTED' });
    const approved = decisionDetail({ status: 'APPROVED', approvalState: 'PENDING' });
    mockApi({
      'GET /api/v1/decisions': {
        body: {
          decisions: [
            { ...rejected, decision: undefined, inputs: undefined },
            { ...approved, decisionId: 'dec-test-002', decision: undefined, inputs: undefined },
          ],
        },
      },
    });
    renderPage(<Approvals />, { path: '/approvals' });
    expect(
      await screen.findByText('risk.capital-preservation: daily loss limit reached'),
    ).toBeTruthy();
    expect(screen.getAllByText('REJECTED').length).toBeGreaterThan(0);
    expect(screen.getAllByText('APPROVED').length).toBeGreaterThan(0);
    expect(screen.getByText('PENDING')).toBeTruthy();
  });
});
