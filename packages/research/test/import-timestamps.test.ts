/**
 * D001 — strict calendar timestamps at the research import boundary. An impossible date/clock
 * component must be COUNTED INVALID and dropped (never shifted or repaired by `Date.UTC`-style
 * normalisation); valid data keeps its exact conversion. The TypeScript loader and the standalone
 * Python kit must agree on every case. Synthetic tiny fixtures only — no market data.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBars, utcMs, type ParseOptions } from '../src';

const KIT_DIR = resolve(import.meta.dirname, '../kit');
const iso = (t: number) => new Date(t).toISOString();

const hd = (t: string) => `${t};1.1;1.2;1.0;1.1;0`;
const mt = (d: string, t: string) =>
  `<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\n${d}\t${t}\t1.1\t1.2\t1.0\t1.1`;
const gen = (t: string) => `time,open,high,low,close\n${t},1.1,1.2,1.0,1.1`;

interface Case {
  readonly label: string;
  readonly text: string;
  readonly opts: ParseOptions;
  /** Expected UTC instant, or null when the row must be counted invalid. */
  readonly utc: string | null;
}
const HD: ParseOptions = { format: 'histdata' };
const FIX: ParseOptions = { format: 'mt5', serverTime: { utcOffsetMinutes: 120 } };
const NY7: ParseOptions = { format: 'mt5', serverTime: 'NY+7' };
const GEN: ParseOptions = { format: 'generic' };

const CASES: Case[] = [
  // ---- HistData (EST, UTC−5 all year): impossible fields invalid, valid conversion unchanged
  { label: 'histdata Feb 30', text: hd('20240230 120000'), opts: HD, utc: null },
  { label: 'histdata Feb 29 non-leap', text: hd('20230229 120000'), opts: HD, utc: null },
  {
    label: 'histdata Feb 29 century non-leap (2100)',
    text: hd('21000229 120000'),
    opts: HD,
    utc: null,
  },
  { label: 'histdata month 13', text: hd('20241301 120000'), opts: HD, utc: null },
  { label: 'histdata month 0', text: hd('20240001 120000'), opts: HD, utc: null },
  { label: 'histdata day 0', text: hd('20240100 120000'), opts: HD, utc: null },
  { label: 'histdata Apr 31', text: hd('20240431 120000'), opts: HD, utc: null },
  { label: 'histdata hour 25', text: hd('20240102 250000'), opts: HD, utc: null },
  { label: 'histdata hour 24', text: hd('20240102 240000'), opts: HD, utc: null },
  { label: 'histdata minute 60', text: hd('20240102 126000'), opts: HD, utc: null },
  { label: 'histdata second 60', text: hd('20240102 120060'), opts: HD, utc: null },
  { label: 'histdata malformed clock', text: hd('20240102 12:00:00'), opts: HD, utc: null },
  {
    label: 'histdata Feb 29 leap',
    text: hd('20240229 120000'),
    opts: HD,
    utc: '2024-02-29T17:00:00.000Z',
  },
  {
    label: 'histdata Feb 29 century leap (2000)',
    text: hd('20000229 120000'),
    opts: HD,
    utc: '2000-02-29T17:00:00.000Z',
  },
  {
    label: 'histdata 31 Dec 23:59:59',
    text: hd('20241231 235959'),
    opts: HD,
    utc: '2025-01-01T04:59:59.000Z',
  },
  {
    label: 'histdata first instant',
    text: hd('20240102 170000'),
    opts: HD,
    utc: '2024-01-02T22:00:00.000Z',
  },
  // ---- MT5 with an explicit fixed offset and NY+7
  ...(['fixed', 'ny7'] as const).flatMap((k): Case[] => {
    const opts = k === 'fixed' ? FIX : NY7;
    return [
      { label: `mt5 ${k} Feb 30`, text: mt('2024.02.30', '12:00:00'), opts, utc: null },
      { label: `mt5 ${k} Feb 29 non-leap`, text: mt('2023.02.29', '12:00:00'), opts, utc: null },
      { label: `mt5 ${k} month 13`, text: mt('2024.13.01', '12:00:00'), opts, utc: null },
      { label: `mt5 ${k} day 0`, text: mt('2024.01.00', '12:00:00'), opts, utc: null },
      { label: `mt5 ${k} Nov 31`, text: mt('2024.11.31', '12:00:00'), opts, utc: null },
      { label: `mt5 ${k} hour 25`, text: mt('2024.01.02', '25:00:00'), opts, utc: null },
      {
        label: `mt5 ${k} hour 24 (not valid in MT5 clocks)`,
        text: mt('2024.01.02', '24:00:00'),
        opts,
        utc: null,
      },
      { label: `mt5 ${k} minute 60`, text: mt('2024.01.02', '12:60:00'), opts, utc: null },
      { label: `mt5 ${k} second 60`, text: mt('2024.01.02', '12:00:60'), opts, utc: null },
      { label: `mt5 ${k} two-digit year`, text: mt('24.01.02', '12:00:00'), opts, utc: null },
      {
        label: `mt5 ${k} extra clock field`,
        text: mt('2024.01.02', '12:00:00:00'),
        opts,
        utc: null,
      },
      {
        label: `mt5 ${k} Feb 29 leap`,
        text: mt('2024.02.29', '12:00:00'),
        opts,
        utc: '2024-02-29T10:00:00.000Z', // +120 min / NY winter (UTC−5) + 7 h = UTC+2 → same
      },
    ];
  }),
  {
    label: 'mt5 fixed minutes-only clock',
    text: mt('2024.01.02', '12:00'),
    opts: FIX,
    utc: '2024-01-02T10:00:00.000Z',
  },
  {
    label: 'mt5 NY+7 winter',
    text: mt('2024.01.03', '00:00:00'),
    opts: NY7,
    utc: '2024-01-02T22:00:00.000Z',
  },
  {
    label: 'mt5 NY+7 summer',
    text: mt('2024.07.03', '00:00:00'),
    opts: NY7,
    utc: '2024-07-02T21:00:00.000Z',
  },
  {
    label: 'mt5 fixed +120 winter',
    text: mt('2024.01.03', '00:00:00'),
    opts: FIX,
    utc: '2024-01-02T22:00:00.000Z',
  },
  // ---- generic ISO-8601 / epoch
  { label: 'generic ISO Feb 30', text: gen('2024-02-30T12:00:00Z'), opts: GEN, utc: null },
  { label: 'generic ISO Feb 29 non-leap', text: gen('2023-02-29T12:00:00Z'), opts: GEN, utc: null },
  { label: 'generic ISO date-only Feb 30', text: gen('2024-02-30'), opts: GEN, utc: null },
  {
    label: 'generic ISO space-separated Feb 30',
    text: gen('2024-02-30 12:00:00'),
    opts: GEN,
    utc: null,
  },
  { label: 'generic ISO month 13', text: gen('2024-13-01T12:00:00Z'), opts: GEN, utc: null },
  { label: 'generic ISO day 0', text: gen('2024-01-00T12:00:00Z'), opts: GEN, utc: null },
  // ---- ISO-8601 end-of-day 24:00 is VALID (next midnight of the validated date)
  {
    label: 'generic ISO 24:00:00Z',
    text: gen('2024-01-02T24:00:00Z'),
    opts: GEN,
    utc: '2024-01-03T00:00:00.000Z',
  },
  {
    label: 'generic ISO 24:00Z',
    text: gen('2024-01-02T24:00Z'),
    opts: GEN,
    utc: '2024-01-03T00:00:00.000Z',
  },
  {
    label: 'generic ISO 24:00:00.000 zero fraction',
    text: gen('2024-01-02T24:00:00.000Z'),
    opts: GEN,
    utc: '2024-01-03T00:00:00.000Z',
  },
  {
    label: 'generic ISO 24:00:00 no zone = UTC',
    text: gen('2024-01-02 24:00:00'),
    opts: GEN,
    utc: '2024-01-03T00:00:00.000Z',
  },
  {
    label: 'generic ISO 24:00:00 with +05:30',
    text: gen('2024-01-02T24:00:00+05:30'),
    opts: GEN,
    utc: '2024-01-02T18:30:00.000Z',
  },
  {
    label: 'generic ISO 31 Dec 24:00 → next year',
    text: gen('2024-12-31T24:00:00Z'),
    opts: GEN,
    utc: '2025-01-01T00:00:00.000Z',
  },
  {
    label: 'generic ISO leap Feb 29 24:00 → 1 March',
    text: gen('2024-02-29T24:00:00Z'),
    opts: GEN,
    utc: '2024-03-01T00:00:00.000Z',
  },
  { label: 'generic ISO 24:01', text: gen('2024-01-02T24:01:00Z'), opts: GEN, utc: null },
  { label: 'generic ISO 24:00:01', text: gen('2024-01-02T24:00:01Z'), opts: GEN, utc: null },
  {
    label: 'generic ISO 24:00:00.5 nonzero fraction',
    text: gen('2024-01-02T24:00:00.5Z'),
    opts: GEN,
    utc: null,
  },
  { label: 'generic ISO 25:00', text: gen('2024-01-02T25:00:00Z'), opts: GEN, utc: null },
  {
    label: 'generic ISO Feb 30 T24:00 (date checked first)',
    text: gen('2024-02-30T24:00:00Z'),
    opts: GEN,
    utc: null,
  },
  {
    label: 'generic ISO non-leap Feb 29 T24:00',
    text: gen('2023-02-29T24:00:00Z'),
    opts: GEN,
    utc: null,
  },
  {
    label: 'generic ISO 24:00 bad offset',
    text: gen('2024-01-02T24:00:00+25:00'),
    opts: GEN,
    utc: null,
  },
  { label: 'generic ISO minute 60', text: gen('2024-01-02T12:60:00Z'), opts: GEN, utc: null },
  { label: 'generic ISO second 60', text: gen('2024-01-02T12:00:60Z'), opts: GEN, utc: null },
  {
    label: 'generic ISO non-ISO separator',
    text: gen('2024/02/05 12:00:00'),
    opts: GEN,
    utc: null,
  },
  { label: 'generic ISO bad offset', text: gen('2024-01-02T12:00:00+25:00'), opts: GEN, utc: null },
  {
    label: 'generic ISO Feb 29 leap',
    text: gen('2024-02-29T12:00:00Z'),
    opts: GEN,
    utc: '2024-02-29T12:00:00.000Z',
  },
  {
    label: 'generic ISO no zone = UTC',
    text: gen('2024-01-02 12:00:00'),
    opts: GEN,
    utc: '2024-01-02T12:00:00.000Z',
  },
  {
    label: 'generic ISO date-only = UTC midnight',
    text: gen('2024-01-02'),
    opts: GEN,
    utc: '2024-01-02T00:00:00.000Z',
  },
  {
    label: 'generic ISO minutes only',
    text: gen('2024-01-02T12:00Z'),
    opts: GEN,
    utc: '2024-01-02T12:00:00.000Z',
  },
  {
    label: 'generic ISO +05:30 offset',
    text: gen('2024-01-02 12:00:00+05:30'),
    opts: GEN,
    utc: '2024-01-02T06:30:00.000Z',
  },
  {
    label: 'generic ISO -0800 offset',
    text: gen('2024-01-02T12:00:00-0800'),
    opts: GEN,
    utc: '2024-01-02T20:00:00.000Z',
  },
  {
    label: 'generic ISO fraction',
    text: gen('2024-01-02T12:00:00.123Z'),
    opts: GEN,
    utc: '2024-01-02T12:00:00.123Z',
  },
  {
    label: 'generic epoch seconds',
    text: gen('1704196800'),
    opts: GEN,
    utc: '2024-01-02T12:00:00.000Z',
  },
  {
    label: 'generic epoch milliseconds',
    text: gen('1704196800000'),
    opts: GEN,
    utc: '2024-01-02T12:00:00.000Z',
  },
];

describe('strict calendar timestamps (TypeScript loader)', () => {
  for (const c of CASES) {
    it(c.label, () => {
      const { bars, report } = parseBars(c.text, c.opts);
      if (c.utc === null) {
        // dropped under the existing ParseReport contract — never shifted into another instant
        expect(report).toMatchObject({ parsed: 0, invalid: 1 });
        expect(bars).toHaveLength(0);
        expect(report.examples[0]).toMatch(/unreadable time/);
      } else {
        expect(report).toMatchObject({ parsed: 1, invalid: 0 });
        expect(iso(bars[0]!.t)).toBe(c.utc);
      }
    });
  }

  it('valid rows around impossible ones keep their exact instants, ordering and duplicate counts', () => {
    const { bars, report } = parseBars(
      [
        hd('20240229 120100'),
        hd('20240230 120000'), // impossible: dropped, NOT moved to 1 March
        hd('20240229 120000'), // out of order
        hd('20240229 120000'), // duplicate
        hd('20240301 120000'),
      ].join('\n'),
      HD,
    );
    expect(report).toMatchObject({ rows: 5, parsed: 3, invalid: 1, duplicates: 1, outOfOrder: 1 });
    expect(bars.map((b) => iso(b.t))).toEqual([
      '2024-02-29T17:00:00.000Z',
      '2024-02-29T17:01:00.000Z',
      '2024-03-01T17:00:00.000Z',
    ]);
    expect(bars[0]).toMatchObject({ o: 1.1, h: 1.2, l: 1, c: 1.1 });
  });

  it('MT5 spread values and an absent server offset are unchanged', () => {
    const text = [
      '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>',
      '2024.01.03\t00:00:00\t1.09400\t1.09410\t1.09390\t1.09405\t50\t0\t3',
    ].join('\n');
    expect(parseBars(text, NY7).bars[0]!.spreadPoints).toBe(3);
    expect(parseBars(text, { format: 'mt5' }).report).toMatchObject({ parsed: 0, invalid: 1 });
  });

  it('utcMs is exact on calendar boundaries', () => {
    expect(iso(utcMs(2024, 2, 29))).toBe('2024-02-29T00:00:00.000Z');
    expect(utcMs(2023, 2, 29)).toBeNaN();
    expect(utcMs(1900, 2, 29)).toBeNaN();
    expect(iso(utcMs(2000, 2, 29))).toBe('2000-02-29T00:00:00.000Z');
    expect(utcMs(2024, 4, 31)).toBeNaN();
    expect(iso(utcMs(2024, 12, 31, 23, 59, 59, 999))).toBe('2024-12-31T23:59:59.999Z');
    expect(iso(utcMs(24, 1, 2))).toBe('0024-01-02T00:00:00.000Z'); // never mapped to 1924 (parsers need 4-digit years)
    expect(utcMs(0, 1, 2)).toBeNaN();
    expect(utcMs(2024, 1, 2, 0, 0, 0, 1000)).toBeNaN();
    expect(utcMs(2024, 1.5, 2)).toBeNaN();
  });
});

describe('TypeScript and Python kit loaders agree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'astra-d001-'));
  const FMT = (o: ParseOptions) => o.format;
  const SERVER = (o: ParseOptions) =>
    o.serverTime === undefined
      ? null
      : o.serverTime === 'NY+7'
        ? 'NY+7'
        : o.serverTime.utcOffsetMinutes;

  it('every case: same parsed/invalid counts and the same UTC instant', () => {
    const files = CASES.map((c, i) => {
      const path = join(dir, `case${i}.txt`);
      writeFileSync(path, c.text);
      return { path, format: FMT(c.opts), server: SERVER(c.opts) };
    });
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(KIT_DIR)})`,
      'import lsfvg_kit as k',
      'out = []',
      'for f in json.load(open(sys.argv[1])):',
      '    bars, rep = k.parse_bars(f["path"], f["format"], f["server"])',
      '    out.append({"parsed": rep["parsed"], "invalid": rep["invalid"], "t": [int(b[0]) for b in bars]})',
      'print(json.dumps(out))',
    ].join('\n');
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(files));
    writeFileSync(join(dir, 'run.py'), script);
    const kit = JSON.parse(
      execFileSync('python3', [join(dir, 'run.py'), join(dir, 'cases.json')], { encoding: 'utf8' }),
    ) as { parsed: number; invalid: number; t: number[] }[];
    CASES.forEach((c, i) => {
      const ts = parseBars(c.text, c.opts);
      expect({ label: c.label, parsed: kit[i]!.parsed, invalid: kit[i]!.invalid }).toEqual({
        label: c.label,
        parsed: ts.report.parsed,
        invalid: ts.report.invalid,
      });
      expect(kit[i]!.t, c.label).toEqual(ts.bars.map((b) => b.t));
    });
  });
});
