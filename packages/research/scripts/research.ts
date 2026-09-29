/**
 * Research CLI (SPEC §20–§25): genuine history in, a report out. Nothing is downloaded or made
 * up here — it reads the files a manifest lists.
 *
 *   pnpm --filter @astra/research research -- --manifest data/manifest.json \
 *     --from 2020-01-01 --to 2026-09-01 --oos 2024-01-01 --out research-out [--sensitivity]
 *
 * Manifest (paths relative to the manifest):
 * {
 *   "pairs": {
 *     "EURUSD": { "format": "histdata", "side": "BID", "files": ["eurusd"], "askFiles": [],
 *                 "assumedSpreadTicks": 8 },
 *     "USDJPY": { "format": "dukascopy", "side": "BID", "files": ["usdjpy-bid.csv"],
 *                 "askFiles": ["usdjpy-ask.csv"] }
 *   },
 *   "serverTime": "NY+7",                       // MT5 files only: the broker server's clock
 *   "calendar": { "file": "calendar.csv", "source": "…", "from": "…", "to": "…" }   // optional
 * }
 * A directory in "files" means every .csv / .txt file in it (sorted). The calendar CSV has
 * time (UTC ISO), currency, impact (HIGH/MEDIUM/LOW), title.
 */
/* eslint-disable no-console -- a command-line tool reports progress on the console */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { decisionConfigView, loadAstraConfig } from '@astra/config';
import type { EconomicEvent } from '@astra/core';
import { DEFAULT_MONITOR_POLICY, DEFAULT_PROTECTION_POLICY } from '@astra/risk';
import {
  NO_COSTS,
  REALISTIC_COSTS,
  analyse,
  coverage,
  loadSide,
  metrics,
  pairSides,
  renderStudy,
  runResearch,
  type CalendarSource,
  type CostModel,
  type DataFormat,
  type DataSource,
  type ModelStudy,
  type ParseReport,
  type RawBar,
  type ResearchBar,
  type ResearchEnvironment,
  type ServerTime,
} from '../src';

interface PairManifest {
  readonly format: DataFormat;
  readonly side?: 'BID' | 'MID';
  readonly files: readonly string[];
  readonly askFiles?: readonly string[];
  readonly assumedSpreadTicks?: number;
}
interface Manifest {
  readonly pairs: Record<string, PairManifest>;
  readonly serverTime?: ServerTime;
  readonly calendar?: { file: string; source: string; from: string; to: string };
}

const MODELS = [
  { model: 'A', strategyId: 'lsfvg-a', accountId: 'paper-fx' },
  { model: 'B', strategyId: 'lsfvg-b', accountId: 'paper-fx-b' },
] as const;

function expand(base: string, entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const p = resolve(base, e);
    if (!existsSync(p)) throw new Error(`data file not found: ${p}`);
    if (statSync(p).isDirectory()) {
      out.push(
        ...readdirSync(p)
          .filter((f) => /\.(csv|txt)(\.gz)?$/i.test(f))
          .sort()
          .map((f) => join(p, f)),
      );
    } else out.push(p);
  }
  return out;
}

/** M5 candles of several files (gzip allowed); a period split across two files is merged. */
function loadFiles(
  files: readonly string[],
  format: DataFormat,
  serverTime: ServerTime | undefined,
): { bars: RawBar[]; reports: ParseReport[] } {
  const texts = files.map((name) => {
    const raw = readFileSync(name);
    return { name, text: (name.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8') };
  });
  const { bars, reports, minutes } = loadSide(texts, {
    format,
    ...(serverTime ? { serverTime } : {}),
  });
  files.forEach((file, i) =>
    console.log(
      `  ${file}: ${reports[i]!.parsed} rows (${minutes[i] ?? '?'} min), ${reports[i]!.invalid} invalid`,
    ),
  );
  return { bars, reports };
}

function loadCalendar(base: string, c: NonNullable<Manifest['calendar']>): CalendarSource {
  const text = readFileSync(resolve(base, c.file), 'utf8');
  const events: EconomicEvent[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  for (const [i, line] of lines.entries()) {
    if (i === 0 && /time/i.test(line)) continue;
    const [time, currency, impact, ...title] = line.split(',').map((x) => x.trim());
    const at = Date.parse(time ?? '');
    const imp = (impact ?? '').toUpperCase();
    if (!Number.isFinite(at) || !['HIGH', 'MEDIUM', 'LOW', 'HOLIDAY'].includes(imp)) continue;
    events.push({
      id: `cal-${i}`,
      title: title.join(',') || 'event',
      currency: currency?.toUpperCase(),
      impact: imp as EconomicEvent['impact'],
      scheduledAt: new Date(at).toISOString(),
      affectedInstruments: [],
    });
  }
  return { kind: 'HISTORICAL', source: c.source, from: c.from, to: c.to, events };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // `pnpm … research -- --flags` passes the separator through.
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      manifest: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      oos: { type: 'string' },
      out: { type: 'string', default: 'research-out' },
      config: { type: 'string' },
      models: { type: 'string', default: 'A,B' },
      sensitivity: { type: 'boolean', default: false },
      // Run as the account's prop-firm profile (one evaluation attempt) instead of the study.
      'prop-firm': { type: 'boolean', default: false },
    },
  });
  if (!values.manifest || !values.from || !values.to || !values.oos) {
    console.error(
      'usage: research --manifest m.json --from YYYY-MM-DD --to YYYY-MM-DD --oos YYYY-MM-DD [--out dir] [--models A,B] [--sensitivity] [--prop-firm]',
    );
    process.exit(2);
  }
  const manifestPath = resolve(values.manifest);
  const base = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const configDir = values.config ?? resolve(import.meta.dirname, '../../../config');
  const config = loadAstraConfig(configDir);
  const env: ResearchEnvironment = {
    config: decisionConfigView(config),
    instruments: config.instruments,
    monitorPolicy: config.system.monitors.positions ?? DEFAULT_MONITOR_POLICY,
    protectionPolicy: config.system.protection ?? DEFAULT_PROTECTION_POLICY,
    lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
  };
  const iso = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toISOString();
  const from = iso(values.from);
  const to = iso(values.to);
  const oos = iso(values.oos);

  const data = new Map<string, ResearchBar[]>();
  const sources: DataSource[] = [];
  const assumptions: string[] = [];
  for (const [symbol, p] of Object.entries(manifest.pairs)) {
    const spec = config.instruments.get(symbol);
    if (!spec) throw new Error(`${symbol} is not a configured instrument`);
    console.log(`${symbol}:`);
    const files = expand(base, p.files);
    const primary = loadFiles(files, p.format, manifest.serverTime);
    const askFiles = expand(base, p.askFiles ?? []);
    const ask = askFiles.length ? loadFiles(askFiles, p.format, manifest.serverTime) : null;
    const spreadTicks = p.assumedSpreadTicks ?? 8;
    const bars = pairSides(
      { side: p.side ?? 'BID', bars: primary.bars },
      ask?.bars ?? null,
      spec.tickSize,
      spreadTicks,
    );
    data.set(symbol, bars);
    const cov = coverage(symbol, bars);
    sources.push({
      symbol,
      files: [...files, ...askFiles].map((f) => f.slice(base.length + 1)),
      format: p.format,
      side: p.side ?? 'BID',
      askFile: askFiles.length > 0,
      parse: [...primary.reports, ...(ask?.reports ?? [])],
      coverage: cov,
    });
    if (cov.spreadAssumed > 0)
      assumptions.push(
        `${symbol}: ${cov.spreadAssumed} of ${cov.bars} candles use an ASSUMED spread of ${spreadTicks} ticks (${spreadTicks / 10} pip) — no ask data for them.`,
      );
  }
  const calendar: CalendarSource = manifest.calendar
    ? loadCalendar(base, manifest.calendar)
    : { kind: 'NOT_MODELLED' };
  if (calendar.kind === 'NOT_MODELLED')
    assumptions.push(
      'NEWS FILTER NOT MODELLED: no historical economic calendar was supplied, so the SPEC’s ±30-minute event blackout was not applied. Results include trades the live system would have refused around events.',
    );
  assumptions.push(
    `Costs after costs: spread from the data (or as above), ${REALISTIC_COSTS.slippageTicks} ticks slippage on stops and protective closes, LIMIT fills only ${REALISTIC_COSTS.limitThroughTicks} tick through the limit, commission from the instrument files (7 USD per lot round turn — UNVERIFIED template). Before costs: mid prices, touch fills, no slippage, no commission.`,
    'Instrument specs are UNVERIFIED templates (100k lots, 5/3 digits).',
    values['prop-firm']
      ? 'Prop-firm: the accounts’ own profile (TEMPLATE, not a real firm) — one evaluation attempt: trading stops at a breach or at the profit target.'
      : 'Prop-firm: NOT applied (strategy study) — no firm loss limits, position caps or profit target, so the whole history is traded. Positions are still closed before the weekly close (Fri 16:00 New York; no weekend holding) by ASTRA’s automatic protection.',
    'Signals are sized and filtered by ASTRA’s real gate (0.25 % of equity per trade, compounding; the owner’s strategy limits; the risk policy’s exposure and activity limits).',
  );

  const models: ModelStudy[] = [];
  const wanted = values.models.split(',').map((m) => m.trim().toUpperCase());
  for (const m of MODELS.filter((x) => wanted.includes(x.model))) {
    const run = (costs: CostModel, extra: Partial<Parameters<typeof runResearch>[0]> = {}) =>
      runResearch({
        env,
        accountId: m.accountId,
        strategyId: m.strategyId,
        data,
        costs,
        calendar,
        from,
        to,
        propFirm: values['prop-firm'] ? 'ACCOUNT' : 'STRATEGY',
        ...extra,
      });
    console.log(`Model ${m.model}: after costs …`);
    const after = await run(REALISTIC_COSTS);
    console.log(`Model ${m.model}: before costs …`);
    const before = await run(NO_COSTS);
    const sensitivity: { label: string; metrics: ReturnType<typeof metrics> }[] = [];
    if (values.sensitivity) {
      const variants: [string, CostModel, Partial<Parameters<typeof runResearch>[0]>][] = [
        ['spread × 1.5', { ...REALISTIC_COSTS, spreadMultiplier: 1.5 }, {}],
        ['spread × 2', { ...REALISTIC_COSTS, spreadMultiplier: 2 }, {}],
        ['slippage 5 ticks', { ...REALISTIC_COSTS, slippageTicks: 5 }, {}],
        ['limit fills 3 ticks through', { ...REALISTIC_COSTS, limitThroughTicks: 3 }, {}],
        ['limit fills on touch', { ...REALISTIC_COSTS, limitThroughTicks: 0 }, {}],
        [
          'displacement ≥ 0.7 × ATR',
          REALISTIC_COSTS,
          { paramOverrides: { displacementBodyToAtr: 0.7 } },
        ],
        [
          'displacement ≥ 0.9 × ATR',
          REALISTIC_COSTS,
          { paramOverrides: { displacementBodyToAtr: 0.9 } },
        ],
        [
          'displacement window 4 candles',
          REALISTIC_COSTS,
          { paramOverrides: { displacementWindowCandles: 4 } },
        ],
        [
          'displacement window 8 candles',
          REALISTIC_COSTS,
          { paramOverrides: { displacementWindowCandles: 8 } },
        ],
        ['entry wait 6 M5 candles', REALISTIC_COSTS, { paramOverrides: { entryWaitM5Candles: 6 } }],
        [
          'entry wait 18 M5 candles',
          REALISTIC_COSTS,
          { paramOverrides: { entryWaitM5Candles: 18 } },
        ],
      ];
      for (const [label, costs, extra] of variants) {
        console.log(`Model ${m.model}: sensitivity — ${label} …`);
        sensitivity.push({ label, metrics: metrics((await run(costs, extra)).trades) });
      }
    }
    models.push({
      afterCosts: after,
      beforeCosts: before,
      ...analyse(after, { outOfSampleFrom: oos }),
      sensitivity,
    });
  }

  const study = {
    generatedAt: new Date().toISOString(),
    window: { from, to, outOfSampleFrom: oos },
    data: sources,
    assumptions,
    models,
  };
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.md'), renderStudy(study));
  writeFileSync(join(outDir, 'study.json'), JSON.stringify(study));
  console.log(`report: ${join(outDir, 'report.md')}`);
}

await main();
