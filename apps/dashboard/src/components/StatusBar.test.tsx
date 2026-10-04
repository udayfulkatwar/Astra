import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { heldReply, mockApi, networkDown } from '../test/api';
import { statusBar } from '../test/fixtures';
import { renderPage } from '../test/render';
import { StatusBar } from './StatusBar';

describe('Status bar', () => {
  it('shows CONNECTING, not a healthy state, before ASTRA has answered', async () => {
    const held = heldReply({ body: statusBar() });
    mockApi({ 'GET /api/v1/system/status': held.route });
    renderPage(<StatusBar />);
    expect(await screen.findByText('CONNECTING')).toBeTruthy();
    expect(screen.queryByText('ONLINE')).toBeNull();
    held.release();
  });

  it('an unreachable API is shown as such, with no healthy or tradable claim', async () => {
    mockApi({ 'GET /api/v1/system/status': networkDown });
    renderPage(<StatusBar />);
    expect(await screen.findByText('API UNREACHABLE')).toBeTruthy();
    expect(screen.queryByText('ONLINE')).toBeNull();
    expect(screen.queryByText('ENABLED')).toBeNull();
  });

  it('stale market data and an unknown calendar read as STALE/UNKNOWN and UNKNOWN; trading DISABLED', async () => {
    mockApi({
      'GET /api/v1/system/status': {
        body: statusBar({
          trading: { enabled: false, reasons: ['MARKET_DATA UNKNOWN: no fresh quotes'] },
          data: { status: 'UNKNOWN', detail: 'no fresh quotes' },
          calendar: { status: 'UNKNOWN', highImpactNext4h: null, source: null },
        }),
      },
      'GET /api/v1/accounts': { body: { accounts: [] } },
    });
    renderPage(<StatusBar />);
    expect(await screen.findByText('STALE/UNKNOWN')).toBeTruthy();
    expect(screen.getByText('DISABLED')).toBeTruthy();
    expect(screen.getByText('UNKNOWN')).toBeTruthy(); // the calendar: never "NORMAL"
    expect(screen.queryByText('HEALTHY')).toBeNull();
    expect(screen.queryByText('NORMAL')).toBeNull();
    expect(screen.queryByText('ENABLED')).toBeNull();
  });
});
