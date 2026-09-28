import { describe, expect, it } from 'vitest';
import { coverage, detectMinutes, pairSides, parseBars, toM5 } from '../src';

describe('historical data import', () => {
  it('reads HistData Generic ASCII (EST without daylight saving → UTC)', () => {
    const { bars, report } = parseBars(
      [
        '20240102 170000;1.104450;1.104480;1.104440;1.104470;0',
        '20240102 170100;1.10447;1.1045;1.1044;1.1045;0',
      ].join('\n'),
      { format: 'histdata' },
    );
    expect(report).toMatchObject({ rows: 2, parsed: 2, invalid: 0 });
    expect(new Date(bars[0]!.t).toISOString()).toBe('2024-01-02T22:00:00.000Z');
    expect(bars[0]).toMatchObject({ o: 1.10445, h: 1.10448, l: 1.10444, c: 1.10447 });
  });

  it('reads MT5 exports with the broker server offset (NY+7 follows US daylight saving)', () => {
    const text = [
      '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>',
      '2024.01.03\t00:00:00\t1.09400\t1.09410\t1.09390\t1.09405\t50\t0\t3',
      '2024.07.03\t00:00:00\t1.07400\t1.07410\t1.07390\t1.07405\t50\t0\t4',
    ].join('\n');
    const { bars } = parseBars(text, { format: 'mt5', serverTime: 'NY+7' });
    // Winter: server midnight = 17:00 New York (EST) = 22:00 UTC; summer: 21:00 UTC.
    expect(new Date(bars[0]!.t).toISOString()).toBe('2024-01-02T22:00:00.000Z');
    expect(new Date(bars[1]!.t).toISOString()).toBe('2024-07-02T21:00:00.000Z');
    expect(bars[0]!.spreadPoints).toBe(3);
    const fixed = parseBars(text, { format: 'mt5', serverTime: { utcOffsetMinutes: 120 } });
    expect(new Date(fixed.bars[0]!.t).toISOString()).toBe('2024-01-02T22:00:00.000Z');
    // Without the server offset the times are unknown: nothing is guessed.
    expect(parseBars(text, { format: 'mt5' }).report).toMatchObject({ parsed: 0, invalid: 2 });
  });

  it('reads dukascopy / generic files; drops invalid rows, duplicates and sorts', () => {
    const text = [
      'timestamp,open,high,low,close,volume',
      '1704232860000,1.1,1.1002,1.0999,1.1001,5',
      '1704232800000,1.1,1.1001,1.0999,1.1,5',
      '1704232800000,1.1,1.1001,1.0999,1.1,5',
      '1704232920000,1.1,1.0990,1.0999,1.1001,5',
      'garbage,row',
    ].join('\n');
    const { bars, report } = parseBars(text, { format: 'dukascopy' });
    expect(bars.map((b) => b.t)).toEqual([1704232800000, 1704232860000]);
    expect(report).toMatchObject({ duplicates: 1, invalid: 2, outOfOrder: 1 });
    const iso = parseBars('time,open,high,low,close\n2024-01-02T22:00:00Z,1,1.1,0.9,1', {
      format: 'generic',
    });
    expect(iso.bars[0]!.t).toBe(Date.parse('2024-01-02T22:00:00Z'));
  });

  it('aggregates M1 to M5 without inventing missing minutes', () => {
    const m1 = [0, 1, 2, 4, 5].map((k) => ({
      t: Date.parse('2024-01-02T22:00:00Z') + k * 60_000,
      o: 1 + k / 100,
      h: 1.1 + k / 100,
      l: 0.9 + k / 100,
      c: 1.05 + k / 100,
    }));
    expect(detectMinutes(m1)).toBe(1);
    const m5 = toM5(m1);
    expect(m5).toHaveLength(2);
    expect(m5[0]).toMatchObject({ o: 1, l: 0.9, c: 1.09 });
    expect(m5[0]!.h).toBeCloseTo(1.14, 10);
    expect(m5[1]).toMatchObject({ t: Date.parse('2024-01-02T22:05:00Z'), o: 1.05 });
  });

  it('pairs bid with ask; otherwise the spread is the file’s or ASSUMED (and said so)', () => {
    const bid = [{ t: 0, o: 1.1, h: 1.101, l: 1.099, c: 1.1 }];
    const ask = [{ t: 0, o: 1.10002, h: 1.10102, l: 1.09902, c: 1.10002 }];
    expect(pairSides({ side: 'BID', bars: bid }, ask, 0.00001, 10)[0]).toMatchObject({
      spread: 'DATA',
      ask: { o: 1.10002 },
    });
    const assumed = pairSides({ side: 'BID', bars: bid }, null, 0.00001, 10)[0]!;
    expect(assumed.spread).toBe('ASSUMED');
    expect(assumed.ask.o).toBeCloseTo(1.1001, 8);
    const midBased = pairSides({ side: 'MID', bars: bid }, null, 0.00001, 10)[0]!;
    expect(midBased.bid.o).toBeCloseTo(1.09995, 8);
    expect(midBased.ask.o).toBeCloseTo(1.10005, 8);
  });

  it('counts weekday gaps, not the weekend close', () => {
    const t0 = Date.parse('2024-01-05T21:55:00Z'); // Friday
    const bar = (t: number) => ({
      t,
      bid: { o: 1, h: 1, l: 1, c: 1 },
      ask: { o: 1, h: 1, l: 1, c: 1 },
      spread: 'ASSUMED' as const,
    });
    const sunday = Date.parse('2024-01-07T22:05:00Z');
    const c = coverage('EURUSD', [bar(t0), bar(sunday), bar(sunday + 3 * 3_600_000)]);
    expect(c).toMatchObject({ gaps: 1, largestGapMinutes: 180, spreadAssumed: 3 });
  });
});
