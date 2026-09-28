/**
 * The research report (SPEC §23–§25, §28): everything measured, every assumption stated, and
 * INSUFFICIENT DATA wherever the sample cannot support a statement. Poor results are reported
 * as they are; nothing here says "profitable".
 */
import type { Coverage, ParseReport } from './data';
import {
  breakdown,
  byDirection,
  byMonth,
  byPair,
  bySession,
  byYear,
  metrics,
  type Metrics,
} from './metrics';
import type { ResearchRun } from './simulate';
import {
  MIN_TRADES_FOR_STATISTICS,
  monteCarlo,
  robustness,
  split,
  walkForward,
  type MonteCarlo,
  type Robustness,
} from './validation';

export interface ModelStudy {
  readonly afterCosts: ResearchRun;
  readonly beforeCosts: ResearchRun | null;
  readonly split: ReturnType<typeof split>;
  readonly walkForward: ReturnType<typeof walkForward>;
  readonly monteCarlo: MonteCarlo | null;
  readonly robustness: Robustness;
  /** Re-runs under harsher or different assumptions (never used to choose parameters). */
  readonly sensitivity: readonly { readonly label: string; readonly metrics: Metrics }[];
}

export interface DataSource {
  readonly symbol: string;
  readonly files: readonly string[];
  readonly format: string;
  readonly side: string;
  readonly askFile: boolean;
  readonly parse: readonly ParseReport[];
  readonly coverage: Coverage;
}

export interface Study {
  readonly generatedAt: string;
  readonly window: { readonly from: string; readonly to: string; readonly outOfSampleFrom: string };
  readonly data: readonly DataSource[];
  readonly assumptions: readonly string[];
  readonly models: readonly ModelStudy[];
}

export function analyse(
  run: ResearchRun,
  opts: { outOfSampleFrom: string; walkForwardMonths?: number; seed?: number },
): Pick<ModelStudy, 'split' | 'walkForward' | 'monteCarlo' | 'robustness'> {
  return {
    split: split(run.trades, opts.outOfSampleFrom),
    walkForward: walkForward(
      run.trades,
      run.window.from,
      run.window.to,
      opts.walkForwardMonths ?? 6,
    ),
    monteCarlo: monteCarlo(run.trades, { seed: opts.seed }),
    robustness: robustness(run.trades),
  };
}

/** Why a set of trades cannot support statistics (null when it can). */
export function insufficient(m: Metrics): string | null {
  return m.trades < MIN_TRADES_FOR_STATISTICS
    ? `INSUFFICIENT DATA — ${m.trades} trade(s); at least ${MIN_TRADES_FOR_STATISTICS} are needed for a statement`
    : null;
}

const f = (x: number | null, suffix = '') => (x === null ? '—' : `${x}${suffix}`);

function metricsRow(label: string, m: Metrics): string {
  return `| ${label} | ${m.trades} | ${f(m.winRate, '%')} | ${f(m.avgWinR)} | ${f(m.avgLossR)} | ${f(m.expectancyR)} | ${f(m.profitFactor)} | ${m.totalR} | ${m.netPnl} | ${m.maxDrawdownR} | ${m.maxConsecutiveLosses} | ${f(m.avgDurationMinutes)} |`;
}

const HEAD =
  '| | Trades | Win rate | Avg win R | Avg loss R | Expectancy R | Profit factor | Total R | Net P&L | Max DD R | Max losing streak | Avg minutes |\n|---|---|---|---|---|---|---|---|---|---|---|---|';

function table(rows: { key: string; metrics: Metrics }[]): string {
  return [HEAD, ...rows.map((r) => metricsRow(r.key, r.metrics))].join('\n');
}

export function renderStudy(s: Study): string {
  const out: string[] = [];
  out.push(`# LSFVG v1.0 — research report`);
  out.push('');
  out.push(
    `Generated ${s.generatedAt}. Window ${s.window.from} → ${s.window.to}; out-of-sample from ${s.window.outOfSampleFrom}. The rules were frozen before this run (ADR-0024); nothing below was used to choose them.`,
  );
  out.push('');
  out.push('## Data');
  out.push('');
  out.push(
    '| Pair | Files | Format | Prices | Ask | Candles (M5) | From | To | Gaps > 30 min | Invalid rows | Spread from data / assumed |',
  );
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of s.data) {
    const invalid = d.parse.reduce((a, p) => a + p.invalid, 0);
    out.push(
      `| ${d.symbol} | ${d.files.join(', ')} | ${d.format} | ${d.side} | ${d.askFile ? 'file' : 'assumed / reported'} | ${d.coverage.bars} | ${d.coverage.from ?? '—'} | ${d.coverage.to ?? '—'} | ${d.coverage.gaps} (largest ${d.coverage.largestGapMinutes} min) | ${invalid} | ${d.coverage.spreadFromData} / ${d.coverage.spreadAssumed} |`,
    );
  }
  out.push('');
  out.push('## Assumptions (read before the numbers)');
  out.push('');
  for (const a of s.assumptions) out.push(`- ${a}`);
  out.push('');

  for (const m of s.models) {
    const run = m.afterCosts;
    const all = metrics(run.trades);
    out.push(`## Model ${run.model} — ${run.strategyId} (account ${run.accountId})`);
    out.push('');
    const verdict = insufficient(all);
    if (verdict)
      out.push(
        `> **${verdict}.** The numbers below describe what happened; they support no conclusion.\n`,
      );
    out.push(
      `Starting balance ${run.startingBalance}; ending balance ${run.endingBalance}. Calendar: ${run.calendar.kind === 'NOT_MODELLED' ? '**NOT MODELLED** — the SPEC news filter was not applied' : `historical (${run.calendar.source})`}.`,
    );
    out.push('');
    out.push('### Result (§23)');
    out.push('');
    const rows = [{ key: 'After costs', metrics: all }];
    if (m.beforeCosts) rows.push({ key: 'Before costs', metrics: metrics(m.beforeCosts.trades) });
    out.push(table(rows));
    out.push('');
    out.push('By pair, direction, session:');
    out.push('');
    out.push(
      table([
        ...breakdown(run.trades, byPair),
        ...breakdown(run.trades, byDirection),
        ...breakdown(run.trades, bySession).map((r) => ({ ...r, key: `session ${r.key}` })),
      ]),
    );
    out.push('');
    out.push('By year:');
    out.push('');
    out.push(table(breakdown(run.trades, byYear)));
    out.push('');
    out.push('<details><summary>By month</summary>\n');
    out.push(table(breakdown(run.trades, byMonth)));
    out.push('\n</details>\n');

    out.push('### In-sample vs out-of-sample (§21)');
    out.push('');
    out.push(
      table([
        { key: `before ${m.split.cut.slice(0, 10)}`, metrics: m.split.inSample },
        { key: `from ${m.split.cut.slice(0, 10)} (untouched)`, metrics: m.split.outOfSample },
      ]),
    );
    const oos = insufficient(m.split.outOfSample);
    if (oos) out.push(`\nOut-of-sample: ${oos}.`);
    out.push('');
    out.push('### Walk-forward (§22)');
    out.push('');
    out.push(table(m.walkForward.map((w) => ({ key: `${w.from} → ${w.to}`, metrics: w.metrics }))));
    const withTrades = m.walkForward.filter((w) => w.metrics.trades > 0);
    const positive = withTrades.filter((w) => (w.metrics.expectancyR ?? 0) > 0).length;
    out.push('');
    out.push(`${positive} of ${withTrades.length} windows with trades had a positive expectancy.`);
    out.push('');
    out.push('### Monte Carlo (§22)');
    out.push('');
    if (!m.monteCarlo) out.push('No trades to resample.');
    else {
      const mc = m.monteCarlo;
      out.push(
        `${mc.runs} bootstrap resamples of the ${mc.tradesPerRun} trades' R (seed ${mc.seed}). Total R: 5th ${mc.totalR.p5}, median ${mc.totalR.p50}, 95th ${mc.totalR.p95}. Expectancy per trade: ${mc.expectancyR.p5} … ${mc.expectancyR.p95} R (5th–95th). Max drawdown: median ${mc.maxDrawdownR.p50} R, 95th ${mc.maxDrawdownR.p95} R, 99th ${mc.maxDrawdownR.p99} R.`,
      );
      out.push('');
      out.push(
        `Chance the drawdown reaches: ${mc.drawdownAtLeast.map((d) => `${d.r} R → ${Math.round(d.probability * 1000) / 10}%`).join(' · ')} (at 0.25 % risk, 1 R = 0.25 % of the account).`,
      );
    }
    out.push('');
    out.push('### Robustness (§24)');
    out.push('');
    const r = m.robustness;
    out.push(
      table([
        { key: 'All trades', metrics: r.all },
        {
          key: `Without best year (${r.withoutBestYear.year ?? '—'})`,
          metrics: r.withoutBestYear.metrics,
        },
        {
          key: `Without best pair (${r.withoutBestPair.pair ?? '—'})`,
          metrics: r.withoutBestPair.metrics,
        },
        {
          key: `Without best session (${r.withoutBestSession.session ?? '—'})`,
          metrics: r.withoutBestSession.metrics,
        },
        { key: 'Without the 5 largest winners', metrics: r.withoutTop5Winners },
      ]),
    );
    out.push('');
    if (m.sensitivity.length > 0) {
      out.push('### Sensitivity (§22) — harsher costs and nearby parameters, for stability only');
      out.push('');
      out.push(table(m.sensitivity.map((x) => ({ key: x.label, metrics: x.metrics }))));
      out.push('');
    }
    out.push('### Strategy funnel and gate');
    out.push('');
    out.push(
      '| Pair | Sweeps | Reclaims | Displacements | FVGs | Setups | Refused: bias / target / R:R |',
    );
    out.push('|---|---|---|---|---|---|---|');
    for (const [sym, c] of Object.entries(run.funnel))
      out.push(
        `| ${sym} | ${c.sweeps} | ${c.reclaims} | ${c.displacements} | ${c.fvgs} | ${c.setups} | ${c.rejectedBias} / ${c.rejectedTarget} / ${c.rejectedRewardToRisk} |`,
      );
    out.push('');
    const g = run.gate;
    out.push(
      `Gate: ${g.setups} setups → ${g.approved} approved, ${g.rejected} refused; ${g.filled} filled, ${g.missed} missed (limit not reached), ${g.invalidated} cancelled on invalidation. Protective closes: ${run.protectiveCloses}.`,
    );
    if (g.blockedBy.length > 0) {
      out.push('');
      out.push('| Check that refused | Count | Example |');
      out.push('|---|---|---|');
      for (const b of g.blockedBy.slice(0, 12))
        out.push(`| ${b.checkId} | ${b.count} | ${b.example.replace(/\|/g, '/')} |`);
    }
    out.push('');
    out.push('### Prop-firm simulation (§25)');
    out.push('');
    out.push(
      run.breach
        ? `The account's hard limit was crossed at ${run.breach.at}: ${run.breach.detail}. Trading stopped there.`
        : 'No hard limit of the configured profile was crossed.',
    );
    out.push(
      '\nThe profile is the TEMPLATE in config/prop-firm-profiles — not a real firm. No firm pass/fail is claimed until the owner names the firm and its current rules are entered and verified.',
    );
    out.push('');
  }
  return out.join('\n');
}
