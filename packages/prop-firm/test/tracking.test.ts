import { describe, expect, it } from 'vitest';
import { initAccountTracking, mergeAccountTracking, updateAccountTracking } from '../src/tracking';
import { makeSnapshot, makeTracking } from './fixtures';

const reset = { timeZone: 'America/New_York', time: '17:00' };
const opts = { reset, tradedToday: false, lateObservationThresholdMs: 5 * 60_000 };

describe('account tracking', () => {
  it('initialises from the first snapshot', () => {
    const t = initAccountTracking({
      accountId: 'acct-a',
      initialBalance: 50_000,
      snapshot: makeSnapshot(),
      reset,
    });
    expect(t.tradingDayKey).toBe('2026-09-28');
    expect(t.dayStartSource).toBe('INITIAL');
    expect(t.equityPeak).toBe(50_000);
  });

  it('tracks peaks within a day', () => {
    const t = updateAccountTracking(
      makeTracking(),
      makeSnapshot({ equity: 50_700, balance: 50_200 }),
      opts,
    );
    expect(t.equityPeak).toBe(50_700);
    expect(t.balancePeak).toBe(50_200);
    expect(t.lastBalance).toBe(50_200);
    expect(t.tradingDayKey).toBe('2026-09-28');
  });

  it('closes out the day on rollover', () => {
    const prev = makeTracking({
      lastBalance: 50_400,
      dayStartBalance: 50_000,
      updatedAt: '2026-09-28T20:59:00.000Z',
    });
    const t = updateAccountTracking(
      prev,
      makeSnapshot({ asOf: '2026-09-28T21:00:30.000Z', balance: 50_400, equity: 50_350 }),
      opts,
    );
    expect(t.tradingDayKey).toBe('2026-09-29');
    expect(t.completedDays).toEqual([{ day: '2026-09-28', pnl: 400 }]);
    expect(t.endOfDayBalancePeak).toBe(50_400);
    expect(t.dayStartBalance).toBe(50_400);
    expect(t.dayStartEquity).toBe(50_350);
    expect(t.dayStartSource).toBe('OBSERVED_AT_RESET');
  });

  it('uses conservative (higher) day-start values when the first snapshot is late', () => {
    const prev = makeTracking({ lastBalance: 50_400, updatedAt: '2026-09-28T20:00:00.000Z' });
    const t = updateAccountTracking(
      prev,
      makeSnapshot({ asOf: '2026-09-29T02:00:00.000Z', balance: 50_100, equity: 50_600 }),
      opts,
    );
    expect(t.dayStartSource).toBe('OBSERVED_LATE');
    expect(t.dayStartBalance).toBe(50_400);
    expect(t.dayStartEquity).toBe(50_600);
  });

  it('prefers firm-reported day-start values', () => {
    const prev = makeTracking({ updatedAt: '2026-09-28T20:00:00.000Z' });
    const t = updateAccountTracking(
      prev,
      makeSnapshot({
        asOf: '2026-09-29T02:00:00.000Z',
        reported: { dayStartBalance: 50_010, dayStartEquity: 50_020 },
      }),
      opts,
    );
    expect(t.dayStartSource).toBe('REPORTED');
    expect(t.dayStartBalance).toBe(50_010);
  });

  it('counts a trading day once', () => {
    let t = updateAccountTracking(makeTracking(), makeSnapshot(), { ...opts, tradedToday: true });
    t = updateAccountTracking(t, makeSnapshot({ asOf: '2026-09-28T15:00:00.000Z' }), {
      ...opts,
      tradedToday: true,
    });
    expect(t.tradingDaysCount).toBe(1);
  });

  it('rejects out-of-order and foreign snapshots', () => {
    expect(() =>
      updateAccountTracking(
        makeTracking(),
        makeSnapshot({ asOf: '2026-09-28T12:00:00.000Z' }),
        opts,
      ),
    ).toThrow(/out-of-order/);
    expect(() =>
      updateAccountTracking(makeTracking(), makeSnapshot({ accountId: 'acct-b' }), opts),
    ).toThrow(/different account/);
  });
});

describe('mergeAccountTracking (a stale writer can never lower a peak)', () => {
  const base = makeTracking();
  it('keeps the higher peaks of a newer stored state when an older, lower state arrives', () => {
    const stored = {
      ...base,
      equityPeak: 55_000,
      balancePeak: 54_000,
      updatedAt: '2026-09-28T14:00:10.000Z',
    };
    const stale = {
      ...base,
      equityPeak: 50_000,
      balancePeak: 50_000,
      lastBalance: 49_000,
      updatedAt: '2026-09-28T14:00:05.000Z',
    };
    const m = mergeAccountTracking(stored, stale);
    expect(m).toMatchObject({
      equityPeak: 55_000,
      balancePeak: 54_000,
      updatedAt: stored.updatedAt,
      lastBalance: stored.lastBalance,
    });
  });
  it('takes the newer observation as the state but never a lower peak', () => {
    const stored = { ...base, equityPeak: 55_000, updatedAt: '2026-09-28T14:00:05.000Z' };
    const newer = {
      ...base,
      equityPeak: 51_000,
      lastBalance: 48_000,
      updatedAt: '2026-09-28T14:00:10.000Z',
    };
    const m = mergeAccountTracking(stored, newer);
    expect(m).toMatchObject({
      equityPeak: 55_000,
      lastBalance: 48_000,
      updatedAt: newer.updatedAt,
    });
  });
  it('refuses to merge different accounts', () => {
    expect(() => mergeAccountTracking(base, { ...base, accountId: 'other' })).toThrow(
      /different accounts/,
    );
  });
});
