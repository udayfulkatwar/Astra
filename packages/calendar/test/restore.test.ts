import { ManualClock, type EconomicEvent, type ObservedOk } from '@astra/core';
import { describe, expect, it, vi } from 'vitest';
import { CalendarService } from '../src/service';

const event = (id: string, at: string): EconomicEvent => ({
  id,
  title: id,
  impact: 'HIGH',
  scheduledAt: at,
  affectedInstruments: [],
});

describe('CalendarService restore', () => {
  it('preserves the original observation time so stale data stays stale and does not re-persist', () => {
    const clock = new ManualClock('2026-09-28T14:30:00.000Z');
    const onWindow = vi.fn();
    const service = new CalendarService({
      clock,
      freshness: { maxAgeMs: 3_600_000, maxFutureSkewMs: 2_000 },
      instruments: new Map([['NQ', { eventCurrencies: ['USD'] }]]),
      onWindow,
    });
    const saved: ObservedOk<{
      from: string;
      to: string;
      events: EconomicEvent[];
    }> = {
      status: 'OK',
      source: 'ingest:n8n',
      sourceKind: 'MANUAL',
      asOf: '2026-09-28T12:00:00.000Z',
      value: {
        from: '2026-09-28T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
        events: [event('cpi', '2026-09-28T15:00:00.000Z')],
      },
    };

    service.restore(saved);

    expect(service.current()).toEqual(saved);
    expect(service.fresh()).toMatchObject({
      status: 'STALE',
      source: 'ingest:n8n',
      sourceKind: 'MANUAL',
      asOf: '2026-09-28T12:00:00.000Z',
    });
    expect(service.health().status).toBe('DEGRADED');
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('uses a restored window as the baseline for later change detection', () => {
    const clock = new ManualClock('2026-09-28T14:00:00.000Z');
    const changes = vi.fn();
    const service = new CalendarService({
      clock,
      freshness: { maxAgeMs: 3_600_000, maxFutureSkewMs: 2_000 },
      instruments: new Map(),
      onChanges: changes,
    });
    service.restore({
      status: 'OK',
      source: 'provider',
      sourceKind: 'LIVE',
      asOf: '2026-09-28T13:55:00.000Z',
      value: {
        from: '2026-09-28T00:00:00.000Z',
        to: '2026-09-29T00:00:00.000Z',
        events: [event('cpi', '2026-09-28T15:00:00.000Z')],
      },
    });

    const result = service.ingest(
      {
        from: '2026-09-28T00:00:00.000Z',
        to: '2026-09-29T00:00:00.000Z',
        events: [event('cpi', '2026-09-28T15:30:00.000Z')],
      },
      'provider',
      'LIVE',
    );

    expect(result.changes.map((c) => c.type)).toEqual(['RESCHEDULED']);
    expect(changes).toHaveBeenCalledTimes(1);
  });
});
