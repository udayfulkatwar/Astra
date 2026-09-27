import {
  InstrumentSpecSchema,
  SessionDefinitionSchema,
  TradingHoursSchema,
  type InstrumentSpec,
  type SessionDefinition,
} from '@astra/core';
import type { Bar } from '../src/bar';
import type { Timeframe } from '../src/timeframe';

/** CME Globex-style schedule (ET): Sun–Fri 18:00–17:00, daily break 17:00–18:00. */
export const GLOBEX = TradingHoursSchema.parse({
  timeZone: 'America/New_York',
  dayStart: '18:00',
  weekly: [
    { open: { day: 'SUN', time: '18:00' }, close: { day: 'MON', time: '17:00' } },
    { open: { day: 'MON', time: '18:00' }, close: { day: 'TUE', time: '17:00' } },
    { open: { day: 'TUE', time: '18:00' }, close: { day: 'WED', time: '17:00' } },
    { open: { day: 'WED', time: '18:00' }, close: { day: 'THU', time: '17:00' } },
    { open: { day: 'THU', time: '18:00' }, close: { day: 'FRI', time: '17:00' } },
  ],
});

export function instrument(overrides: Record<string, unknown> = {}): InstrumentSpec {
  return InstrumentSpecSchema.parse({
    symbol: 'NQ',
    displayName: 'Test NQ',
    assetClass: 'FUTURES',
    quantityUnit: 'CONTRACTS',
    quoteCurrency: 'USD',
    tickSize: 0.25,
    tickValue: 5,
    quantityStep: 1,
    minQuantity: 1,
    maxSpreadTicks: 4,
    costs: { commissionPerUnitRoundTurn: 5, slippageAllowanceTicks: 2 },
    tradingHours: GLOBEX,
    maxQuoteJumpTicks: 200,
    verification: { status: 'UNVERIFIED' },
    ...overrides,
  });
}

export const SESSIONS: SessionDefinition[] = [
  { id: 'asia', name: 'Asia', timeZone: 'Asia/Tokyo', start: '09:00', end: '15:00' },
  { id: 'london', name: 'London', timeZone: 'Europe/London', start: '08:00', end: '16:30' },
  { id: 'new-york', name: 'New York', timeZone: 'America/New_York', start: '08:00', end: '17:00' },
  { id: 'ny-cash', name: 'NY cash', timeZone: 'America/New_York', start: '09:30', end: '16:00' },
].map((s) => SessionDefinitionSchema.parse({ ...s, days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }));

export const ms = (iso: string) => Date.parse(iso);

export function bar(
  timeframe: Timeframe,
  openTime: string,
  closeTime: string,
  ohlc: { open: number; high: number; low: number; close: number },
  extra: Partial<Bar> = {},
): Bar {
  return {
    symbol: 'NQ',
    timeframe,
    openTime: new Date(openTime).toISOString(),
    closeTime: new Date(closeTime).toISOString(),
    ...ohlc,
    volume: null,
    tickCount: 1,
    complete: true,
    source: 'feed',
    sourceKind: 'LIVE',
    ...extra,
  };
}

/** A complete M1 bar at `openTime` (ISO) with the given high/low (open = low, close = high). */
export function m1(openTime: string, high: number, low: number, extra: Partial<Bar> = {}): Bar {
  const open = ms(openTime);
  return bar(
    'M1',
    openTime,
    new Date(open + 60_000).toISOString(),
    { open: low, high, low, close: high },
    extra,
  );
}
