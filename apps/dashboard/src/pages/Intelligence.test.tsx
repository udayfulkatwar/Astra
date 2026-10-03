import { eventRiskView } from '@astra/calendar';
import { notObserved } from '@astra/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiError, mockApi } from '../test/api';
import { NOW } from '../test/fixtures';
import { renderPage } from '../test/render';
import { CalendarPage } from './Intelligence';

const RULE = { impactLevels: ['HIGH'] as const, minutesBefore: 15, minutesAfter: 15 };
const STALE = notObserved('STALE', 'last window received 3 h ago (max age 1 h)', 'n8n:calendar', {
  sourceKind: 'MANUAL',
  asOf: '2026-10-03T11:00:00.000Z',
});

describe('Economic Calendar', () => {
  it('a stale calendar makes every instrument UNKNOWN (never CLEAR) and says trades are refused', async () => {
    // The server's own read model (the same code the API runs), built from a stale calendar.
    const view = eventRiskView({
      calendar: STALE,
      symbols: ['EURUSD', 'NQ'],
      now: new Date(NOW),
      rule: { ...RULE, impactLevels: [...RULE.impactLevels] },
    });
    mockApi({
      'GET /api/v1/calendar/risk': { body: view },
      'GET /api/v1/calendar/upcoming': { body: STALE },
    });
    renderPage(<CalendarPage />, { path: '/calendar' });

    const eurusd = within((await screen.findByText('EURUSD')).closest('tr')!);
    expect(eurusd.getByText('UNKNOWN')).toBeTruthy();
    expect(eurusd.getByText(/economic calendar STALE/)).toBeTruthy();
    expect(within(screen.getByText('NQ').closest('tr')!).getByText('UNKNOWN')).toBeTruthy();
    expect(screen.queryByText('CLEAR')).toBeNull();
    expect(
      screen.getByText(/every trade is refused until it is fresh/, { exact: false }),
    ).toBeTruthy();
    expect(await screen.findByText(/Calendar STALE: last window received 3 h ago/)).toBeTruthy();
  });

  it('when event risk cannot be read it says so and shows no instrument as clear', async () => {
    mockApi({
      'GET /api/v1/calendar/risk': apiError(500, 'INTERNAL', 'database unavailable'),
      'GET /api/v1/calendar/upcoming': apiError(500, 'INTERNAL', 'database unavailable'),
    });
    renderPage(<CalendarPage />, { path: '/calendar' });
    // Both cards (event risk and events) report the failure.
    await waitFor(() =>
      expect(screen.getAllByText('Could not load data: database unavailable')).toHaveLength(2),
    );
    expect(screen.queryByText('CLEAR')).toBeNull();
  });
});
