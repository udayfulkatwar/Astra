import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi } from '../test/api';
import { component, statusBar } from '../test/fixtures';
import { renderPage } from '../test/render';
import { Health } from './Operations';

const row = (name: string) => within(screen.getByText(name).closest('tr')!);

describe('System Health', () => {
  it('a silent or degraded component shows its own status, never ONLINE, and BLOCKING when it blocks trading', async () => {
    mockApi({
      'GET /api/v1/system/health': {
        body: {
          components: [
            component('DATABASE', 'ONLINE', 'query ok'),
            component('MARKET_DATA', 'UNKNOWN', 'no fresh quotes for MNQ'),
            component('CALENDAR', 'DEGRADED', 'calendar STALE: last window 3 h ago'),
          ],
        },
      },
      'GET /api/v1/system/status': {
        body: statusBar({
          trading: {
            enabled: false,
            reasons: [
              'MARKET_DATA UNKNOWN: no fresh quotes for MNQ',
              'CALENDAR DEGRADED: calendar STALE',
            ],
          },
        }),
      },
    });
    renderPage(<Health />, { path: '/health' });
    await screen.findByText('MARKET DATA');
    await screen.findAllByText('BLOCKING');

    const market = row('MARKET DATA');
    expect(market.getByText('UNKNOWN')).toBeTruthy();
    expect(market.getByText('BLOCKING')).toBeTruthy();
    expect(market.getByText('never')).toBeTruthy(); // never ONLINE
    expect(market.queryByText('ONLINE')).toBeNull();

    const calendar = row('CALENDAR');
    expect(calendar.getByText('DEGRADED')).toBeTruthy();
    expect(calendar.getByText('BLOCKING')).toBeTruthy();

    const database = row('DATABASE');
    expect(database.getByText('ONLINE')).toBeTruthy();
    expect(database.queryByText('BLOCKING')).toBeNull();
  });

  it('when health cannot be read it says so and shows no component as healthy', async () => {
    mockApi({
      'GET /api/v1/system/health': apiError(503, 'NOT_READY', 'core is initializing'),
      'GET /api/v1/system/status': apiError(503, 'NOT_READY', 'core is initializing'),
    });
    renderPage(<Health />, { path: '/health' });
    expect(await screen.findByText('Could not load data: core is initializing')).toBeTruthy();
    expect(screen.queryByText('ONLINE')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
