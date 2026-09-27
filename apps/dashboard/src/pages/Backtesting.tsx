/**
 * Backtesting (ADR-0016): replay past minutes through the same decision gate, sizing, prop-firm
 * rules, automatic protection and journal that run live, and read the result. Every result is
 * labelled with what it is (SIMULATED data → an engine test, not evidence of performance) and
 * lists its assumptions and warnings. Running a backtest never trades or changes any state.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import {
  useAccounts,
  useBacktest,
  useBacktests,
  useConfigSummary,
  useRunBacktest,
} from '../api/hooks';
import type { BacktestRequestInput, BacktestResult, BacktestRunListItem } from '../api/types';
import { EquityChart } from '../components/EquityChart';
import { JournalBreakdown, JournalEntries, JournalTiles } from '../components/JournalViews';
import { Card, Empty, ErrorBox, KV, Loading, PageHeader, Pill, Stat } from '../components/ui';
import { astraNow, money, num } from '../lib/format';

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1'] as const;
type StrategyTf = (typeof TIMEFRAMES)[number];

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const tone = (v: number) => (v > 0 ? 'ok' : v < 0 ? 'bad' : undefined);

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={o.value === value ? 'active' : undefined}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RunForm({ onDone }: { onDone: (runId: string) => void }) {
  const accounts = useAccounts();
  const run = useRunBacktest();
  const list = accounts.data?.accounts ?? [];
  const [accountId, setAccountId] = useState<string | null>(null);
  const account = list.find((a) => a.account.id === accountId) ?? list[0];
  const [symbol, setSymbol] = useState<string | null>(null);
  const specs = useConfigSummary().data?.instruments ?? [];
  const tickValue = (sym: string) =>
    specs.find((x) => x.symbol === sym)?.tickValue ?? Number.POSITIVE_INFINITY;
  const instruments = account?.account.instruments ?? [];
  // Default: the instrument with the smallest value per tick (most room within a risk budget).
  const fallback = [...instruments].sort((a, b) => tickValue(a) - tickValue(b))[0];
  const sym = symbol && instruments.includes(symbol) ? symbol : fallback;
  const today = Date.parse(`${day(astraNow())}T00:00:00Z`);
  const [from, setFrom] = useState(day(today - 14 * 86_400_000));
  const [to, setTo] = useState(day(today));
  const [data, setData] = useState<'SIMULATED' | 'STORED'>('SIMULATED');
  const [seed, setSeed] = useState(1);
  const [startPrice, setStartPrice] = useState('');
  const [source, setSource] = useState('');
  const [calendar, setCalendar] = useState<'SIMULATED_SCHEDULE' | 'NOT_MODELLED' | null>(null);
  const [timeframe, setTimeframe] = useState<StrategyTf>('M15');
  const [rr, setRr] = useState(2);
  const [minStop, setMinStop] = useState(8);
  const [spread, setSpread] = useState(1);
  const [slippage, setSlippage] = useState(1);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!account || !sym || !calendar) return;
    const body: BacktestRequestInput = {
      symbol: sym,
      accountId: account.account.id,
      from: `${from}T00:00:00Z`,
      to: `${to}T00:00:00Z`,
      calendar,
      strategy: {
        id: 'structure-breakout-template',
        timeframe,
        rewardToRisk: rr,
        minStopTicks: minStop,
      },
      spreadTicks: spread,
      slippageTicks: slippage,
      data:
        data === 'SIMULATED'
          ? { kind: 'SIMULATED', seed, ...(startPrice ? { startPrice: Number(startPrice) } : {}) }
          : { kind: 'STORED', ...(source.trim() ? { source: source.trim() } : {}) },
    };
    run.mutate(body, { onSuccess: (r) => onDone(r.runId) });
  };

  if (accounts.error) return <ErrorBox error={accounts.error} />;
  if (!accounts.data) return <Loading />;
  return (
    <form className="candidate-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span>Account (its prop-firm rules and risk policy apply)</span>
          <select
            id="bt-account"
            value={account?.account.id ?? ''}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {list.map((a) => (
              <option key={a.account.id} value={a.account.id}>
                {a.account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Instrument</span>
          <select id="bt-symbol" value={sym ?? ''} onChange={(e) => setSymbol(e.target.value)}>
            {instruments.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>From (UTC)</span>
          <input id="bt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>To (UTC, exclusive)</span>
          <input id="bt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="form-grid">
        <Segmented
          label="Price data"
          value={data}
          onChange={setData}
          options={[
            { value: 'SIMULATED', label: 'Simulated (seeded)' },
            { value: 'STORED', label: 'Recorded by ASTRA' },
          ]}
        />
        {data === 'SIMULATED' ? (
          <>
            <label className="field">
              <span>Seed (same seed → same prices)</span>
              <input
                id="bt-seed"
                type="number"
                min={0}
                step={1}
                value={seed}
                onChange={(e) => setSeed(Math.max(0, Math.trunc(Number(e.target.value))))}
              />
            </label>
            <label className="field">
              <span>Start price (empty = current quote)</span>
              <input
                id="bt-start"
                type="number"
                step="any"
                min={0}
                value={startPrice}
                placeholder="current quote"
                onChange={(e) => setStartPrice(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="field">
            <span>Source (only if several recorded one instrument)</span>
            <input
              id="bt-source"
              value={source}
              placeholder="any single source"
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
        )}
        <Segmented
          label="Economic events (choose one)"
          value={calendar}
          onChange={setCalendar}
          options={[
            { value: 'SIMULATED_SCHEDULE', label: 'Simulated schedule' },
            { value: 'NOT_MODELLED', label: 'Not modelled' },
          ]}
        />
      </div>
      <div className="form-grid">
        <label className="field">
          <span>TEMPLATE strategy timeframe</span>
          <select
            id="bt-tf"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as StrategyTf)}
          >
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Reward : risk</span>
          <input
            id="bt-rr"
            type="number"
            step="0.25"
            min={0.5}
            max={10}
            value={rr}
            onChange={(e) => setRr(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Minimum stop (ticks)</span>
          <input
            id="bt-minstop"
            type="number"
            step={1}
            min={1}
            value={minStop}
            onChange={(e) => setMinStop(Math.max(1, Math.trunc(Number(e.target.value))))}
          />
        </label>
        <label className="field">
          <span>Spread (ticks)</span>
          <input
            id="bt-spread"
            type="number"
            step="0.5"
            min={0}
            value={spread}
            onChange={(e) => setSpread(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Slippage (ticks)</span>
          <input
            id="bt-slippage"
            type="number"
            step="0.5"
            min={0}
            value={slippage}
            onChange={(e) => setSlippage(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="row-between">
        <span className="muted small">
          {calendar === null
            ? 'Choose how economic events are handled — there is no silent default.'
            : 'A backtest never trades and never changes accounts, the mode or kill switches.'}
        </span>
        <button
          id="bt-run"
          className="btn primary"
          disabled={run.isPending || !account || !sym || calendar === null}
        >
          {run.isPending ? 'Replaying…' : 'Run backtest'}
        </button>
      </div>
      {run.error && <ErrorBox error={run.error} />}
    </form>
  );
}

function Runs({
  runs,
  selected,
  onSelect,
}: {
  runs: BacktestRunListItem[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (runs.length === 0) return <Empty>No backtests yet. Run one above.</Empty>;
  return (
    <div className="table-scroll">
      <table className="table compact runs">
        <thead>
          <tr>
            <th>Run</th>
            <th>Instrument · period</th>
            <th>Data</th>
            <th className="num">Trades</th>
            <th className="num">Win rate</th>
            <th className="num">Net change</th>
            <th className="num">Max drawdown</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr
              key={r.runId}
              className={r.runId === selected ? 'selected' : undefined}
              onClick={() => onSelect(r.runId)}
            >
              <td>
                <button
                  type="button"
                  className="linklike mono small"
                  onClick={() => onSelect(r.runId)}
                >
                  {r.createdAt.slice(0, 16).replace('T', ' ')}
                </button>
              </td>
              <td>
                <span className="strong">{r.symbol}</span>{' '}
                <span className="muted small">
                  {r.from.slice(0, 10)} → {r.to.slice(0, 10)} · {r.accountId}
                </span>
              </td>
              <td>
                <span className="tag">{r.dataKind}</span>
              </td>
              <td className="num">{r.summary.trades}</td>
              <td className="num">
                {r.summary.winRatePct === null ? '—' : `${num(r.summary.winRatePct, 0)}%`}
              </td>
              <td
                className={`num ${r.summary.netChange > 0 ? 'tone-text-ok' : r.summary.netChange < 0 ? 'tone-text-bad' : ''}`}
              >
                {money(r.summary.netChange)}
              </td>
              <td className="num">{money(r.summary.maxDrawdown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bt-section">
      <h3 className="chart-title">{title}</h3>
      {children}
    </div>
  );
}

function Result({ runId, result }: { runId: string; result: BacktestResult }) {
  const p = result.performance;
  const d = result.decisions;
  const c = result.account.currency;
  const simulated = result.data.sourceKinds.includes('SIMULATED');
  return (
    <>
      <Card
        title={`${result.data.symbol} · ${result.data.from.slice(0, 10)} → ${result.data.to.slice(0, 10)}`}
        actions={
          <Pill
            status={simulated ? 'SIMULATED' : 'HISTORICAL'}
            tone={simulated ? 'warn' : 'info'}
          />
        }
      >
        <div className="warn-box bt-label">
          <strong>{result.label}.</strong>
          <ul>
            {result.warnings
              .filter((w) => w !== `${result.label}.`)
              .map((w) => (
                <li key={w}>{w}</li>
              ))}
          </ul>
        </div>
        <div className="grid cols-4">
          <Stat
            label="Net change"
            value={money(p.netChange, c)}
            sub={`${num(p.returnPct, 2)}% of ${money(p.startingBalance, c)}`}
            tone={tone(p.netChange)}
          />
          <Stat
            label="Max drawdown"
            value={money(p.maxDrawdown, c)}
            sub={`${num(p.maxDrawdownPct, 2)}% from the peak`}
          />
          <Stat
            label="Signals → trades"
            value={`${d.signals} → ${d.filled}`}
            sub={`${d.approved} approved · ${d.rejected} blocked by the gate`}
          />
          <Stat
            label="Ending equity"
            value={money(p.endingEquity, c)}
            sub={
              result.openAtEnd.length
                ? `${result.openAtEnd.length} position(s) still open`
                : `balance ${money(p.endingBalance, c)}`
            }
          />
        </div>
        <EquityChart result={result} />
        {result.breach && (
          <div className="error-box">
            Prop-firm hard limit crossed at {result.breach.at} — the evaluation would have failed
            here. {result.breach.detail}
          </div>
        )}
        <p className="muted small mono">run {runId}</p>
      </Card>

      <Card title="Trade statistics">
        <JournalTiles s={result.summary.overall} />
        {result.summary.overall.trades > 0 && (
          <div className="breakdowns">
            <JournalBreakdown title="By exit" groups={result.summary.byExitReason} />
          </div>
        )}
      </Card>

      <Card title="What the safety gate did">
        <div className="breakdowns">
          <Section title="Blocked by (mandatory checks)">
            {d.blockedBy.length === 0 ? (
              <Empty>Nothing was blocked.</Empty>
            ) : (
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th className="num">Times</th>
                    <th>Example reason</th>
                  </tr>
                </thead>
                <tbody>
                  {d.blockedBy.map((b) => (
                    <tr key={b.checkId}>
                      <td className="mono small">{b.checkId}</td>
                      <td className="num">{b.count}</td>
                      <td className="small">{b.example}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title="Automatic protection">
            {result.protective.length === 0 ? (
              <Empty>No protective close was needed.</Empty>
            ) : (
              <ul className="plain-list small">
                {result.protective.map((a) => (
                  <li key={`${a.positionId}-${a.at}`}>
                    <span className="tag">{a.trigger}</span> {a.at.slice(0, 16).replace('T', ' ')} —{' '}
                    {a.reason}
                  </li>
                ))}
              </ul>
            )}
            {d.skipped.length > 0 && (
              <p className="muted small">
                Setups skipped by the strategy:{' '}
                {d.skipped.map((s) => `${s.reason} (${s.count})`).join('; ')}
              </p>
            )}
            {d.expired > 0 && (
              <p className="muted small">
                {d.expired} approval(s) expired before the next bar opened (data gap).
              </p>
            )}
          </Section>
        </div>
      </Card>

      <Card title={`Trades (${result.trades.length})`}>
        <JournalEntries
          entries={[...result.trades].reverse()}
          empty="No trade was taken in this replay."
        />
      </Card>

      <Card title="Assumptions and data">
        <ul className="plain-list small">
          {result.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <KV
          rows={[
            [
              'Strategy',
              `${result.strategy.name} (v${result.strategy.version}, ${result.strategy.ownership})`,
            ],
            ['Account', `${result.account.id} · profile ${result.account.profileId}`],
            [
              'Bars replayed',
              `${num(result.data.m1Bars, 0)} M1 → ${num(result.data.strategyBars, 0)} ${result.config.strategy.timeframe}`,
            ],
            [
              'Data',
              `${result.data.sourceKinds.join(', ')} from ${result.data.sources.join(', ')}`,
            ],
            ['Gaps over 5 min', `${result.data.gaps} (closed markets or missing data)`],
            ['Configuration', result.configHash],
          ]}
        />
      </Card>
    </>
  );
}

export function Backtesting() {
  const runs = useBacktests();
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected ?? runs.data?.runs[0]?.runId ?? null;
  const run = useBacktest(current);
  const notAvailable = runs.error instanceof ApiError && runs.error.status === 404;
  return (
    <div className="page">
      <PageHeader
        title="Backtesting"
        subtitle="Replay past minutes through the same safety gate, position sizing, prop-firm rules, automatic protection and trade journal that run live. Results describe the replay only."
      />
      {notAvailable ? (
        <Card>
          <Empty>Backtesting is not available from this ASTRA server yet.</Empty>
        </Card>
      ) : (
        <>
          <Card title="Run a backtest">
            <RunForm onDone={setSelected} />
          </Card>
          <Card title="Runs">
            {runs.error ? (
              <ErrorBox error={runs.error} />
            ) : !runs.data ? (
              <Loading />
            ) : (
              <Runs runs={runs.data.runs} selected={current} onSelect={setSelected} />
            )}
          </Card>
          {current &&
            (run.error ? (
              <Card>
                <ErrorBox error={run.error} />
              </Card>
            ) : !run.data ? (
              <Card>
                <Loading />
              </Card>
            ) : (
              <Result runId={run.data.runId} result={run.data.result} />
            ))}
        </>
      )}
    </div>
  );
}
