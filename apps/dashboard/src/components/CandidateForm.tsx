/**
 * Submit a test trade candidate to the decision gate (operator tool for PAPER testing).
 * Entry is the current executable price; stop and target are distances in price points.
 * Presets exist to show approvals AND rejections — they are test signals, not trade ideas.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useAccounts, useConfigSummary, useEvaluate, useQuotes, useStatus } from '../api/hooks';
import type { Quote } from '../api/types';
import { ErrorBox, Pill } from './ui';

interface Preset {
  id: string;
  label: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  stop: number;
  target: number;
}

const PRESETS: Preset[] = [
  { id: 'valid', label: 'Valid MNQ long', symbol: 'MNQ', direction: 'LONG', stop: 10, target: 20 },
  {
    id: 'gold',
    label: 'Valid gold short',
    symbol: 'XAUUSD',
    direction: 'SHORT',
    stop: 3,
    target: 9,
  },
  {
    id: 'poor-rr',
    label: 'Poor reward:risk',
    symbol: 'MNQ',
    direction: 'LONG',
    stop: 10,
    target: 8,
  },
  {
    id: 'too-big',
    label: 'Too much risk (NQ)',
    symbol: 'NQ',
    direction: 'LONG',
    stop: 20,
    target: 40,
  },
  {
    id: 'wrong-stop',
    label: 'Stop on wrong side',
    symbol: 'MNQ',
    direction: 'LONG',
    stop: -10,
    target: 20,
  },
];

function roundTo(value: number, tick: number): number {
  return Number((Math.round(value / tick) * tick).toFixed(10));
}

export function CandidateForm() {
  const accounts = useAccounts();
  const config = useConfigSummary();
  const quotes = useQuotes();
  const status = useStatus();
  const evaluate = useEvaluate();

  const accountList = accounts.data?.accounts ?? [];
  const [accountId, setAccountId] = useState('');
  const account = accountList.find((a) => a.account.id === accountId) ?? accountList[0];
  const strategies = (config.data?.strategies ?? []).filter((s) =>
    account?.account.strategies.includes(s.id),
  );
  const [strategyId, setStrategyId] = useState('');
  const strategy = strategies.find((s) => s.id === strategyId) ?? strategies[0];
  const symbols = (account?.account.instruments ?? []).filter((s) =>
    strategy?.instruments.includes(s),
  );

  const [symbol, setSymbol] = useState('MNQ');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [stopDist, setStopDist] = useState(10);
  const [targetDist, setTargetDist] = useState(20);
  const [autoExecute, setAutoExecute] = useState(true);

  const spec = config.data?.instruments.find((i) => i.symbol === symbol);
  const quote = quotes.data?.quotes.find((q) => q.value.symbol === symbol)?.value;
  const entry = quote ? (direction === 'LONG' ? quote.ask : quote.bid) : null;
  const sign = direction === 'LONG' ? 1 : -1;
  const stop = entry !== null && spec ? roundTo(entry - sign * stopDist, spec.tickSize) : null;
  const target = entry !== null && spec ? roundTo(entry + sign * targetDist, spec.tickSize) : null;

  const applyPreset = (p: Preset) => {
    setSymbol(p.symbol);
    setDirection(p.direction);
    setStopDist(p.stop);
    setTargetDist(p.target);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!account || !strategy || !spec || !status.data) return;
    // Price the candidate from the freshest quote at the moment of submission.
    const fresh = await api<{ quotes: { value: Quote }[] }>('/api/v1/market/quotes');
    const q = fresh.quotes.find((x) => x.value.symbol === symbol)?.value;
    if (!q) return;
    const px = direction === 'LONG' ? q.ask : q.bid;
    evaluate.mutate({
      autoExecute,
      candidate: {
        accountId: account.account.id,
        signal: {
          id: `manual-${Date.now()}`,
          strategyId: strategy.id,
          symbol,
          direction,
          setupState: 'QUALIFIED',
          entryType: 'MARKET',
          entry: px,
          stop: roundTo(px - sign * stopDist, spec.tickSize),
          target: roundTo(px + sign * targetDist, spec.tickSize),
          detectedAt: status.data.now,
          rationale: ['manual test candidate (operator)'],
        },
      },
    });
  };

  const result = evaluate.data;
  return (
    <form className="candidate-form" onSubmit={(e) => void submit(e)}>
      <div className="presets" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="btn small" onClick={() => applyPreset(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Account</span>
          <select
            id="cf-account"
            value={account?.account.id ?? ''}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accountList.map((a) => (
              <option key={a.account.id} value={a.account.id}>
                {a.account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Strategy</span>
          <select
            id="cf-strategy"
            value={strategy?.id ?? ''}
            onChange={(e) => setStrategyId(e.target.value)}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Instrument</span>
          <select id="cf-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {symbols.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Direction</span>
          <select
            id="cf-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'LONG' | 'SHORT')}
          >
            <option>LONG</option>
            <option>SHORT</option>
          </select>
        </label>
        <label className="field">
          <span>Stop distance (points)</span>
          <input
            id="cf-stop"
            type="number"
            step="any"
            value={stopDist}
            onChange={(e) => setStopDist(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Target distance (points)</span>
          <input
            id="cf-target"
            type="number"
            step="any"
            value={targetDist}
            onChange={(e) => setTargetDist(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="row-between">
        <span className="muted small mono">
          {entry === null
            ? `no quote for ${symbol} — market data UNAVAILABLE`
            : `entry ${entry} · stop ${stop} · target ${target}`}
        </span>
        <span className="inline-form">
          <label className="check-label">
            <input
              id="cf-auto"
              type="checkbox"
              checked={autoExecute}
              onChange={(e) => setAutoExecute(e.target.checked)}
            />{' '}
            Execute if approved (paper)
          </label>
          <button
            className="btn primary"
            disabled={entry === null || evaluate.isPending || !strategy}
          >
            {evaluate.isPending ? 'Evaluating…' : 'Submit to the gate'}
          </button>
        </span>
      </div>
      {evaluate.error && <ErrorBox error={evaluate.error} />}
      {result && (
        <div
          className={`result tone-border-${result.decision.status === 'APPROVED' ? 'ok' : 'bad'}`}
        >
          <Pill status={result.decision.status} />{' '}
          <Link to={`/approvals/${result.decision.decisionId}`}>
            {result.decision.explanation.what}
          </Link>
          {result.decision.status === 'REJECTED' && (
            <ul className="reasons">
              {result.decision.reasons.slice(0, 4).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {result.execution && (
            <div className="small">
              Execution:{' '}
              <Pill
                status={
                  result.execution.outcome === 'CONFIRMED'
                    ? 'CONFIRMED'
                    : result.execution.outcome === 'SHADOW_RECORDED'
                      ? 'SHADOW'
                      : 'REJECTED'
                }
                label={result.execution.outcome}
              />{' '}
              {result.execution.reasons.join(' · ')}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
