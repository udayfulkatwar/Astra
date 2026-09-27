/** Human override controls (spec §16, §24, §76): mode, kill switches. Operator role required. */
import { useState, type FormEvent } from 'react';
import {
  useAccounts,
  useConfigSummary,
  useKillSwitchAction,
  useKillSwitches,
  useMode,
  useSetMode,
} from '../api/hooks';
import type { TradingMode } from '../api/types';
import { Card, Empty, ErrorBox, KV, Loading, PageHeader, Pill } from '../components/ui';
import { dateTime } from '../lib/format';

const SCOPES = ['GLOBAL', 'ACCOUNT', 'STRATEGY', 'INSTRUMENT', 'EXECUTION', 'AI', 'NEWS'] as const;
const NEEDS_TARGET = new Set(['ACCOUNT', 'STRATEGY', 'INSTRUMENT']);
const OPTIONAL_TARGET = new Set(['EXECUTION', 'NEWS']);

export function RiskControls() {
  return (
    <div className="page">
      <PageHeader
        title="Risk Controls"
        subtitle="PAUSE · HALT · DISABLE STRATEGY · DISABLE ACCOUNT · DISABLE EXECUTION · EMERGENCY STOP"
      />
      <div className="grid cols-2">
        <EmergencyStop />
        <ModeControl />
      </div>
      <KillSwitchForm />
      <KillSwitchList />
    </div>
  );
}

function EmergencyStop() {
  const action = useKillSwitchAction();
  return (
    <Card title="Emergency stop">
      <p className="muted">
        Activates the GLOBAL kill switch: no new trades on any account, strategy or instrument until
        an operator clears it.
      </p>
      <button
        className="btn danger big"
        disabled={action.isPending}
        onClick={() => {
          const reason = window.prompt(
            'Reason for the emergency stop (recorded in the audit log):',
            'operator emergency stop',
          );
          if (reason && reason.trim().length >= 3)
            action.mutate({
              action: 'activate',
              scope: 'GLOBAL',
              target: null,
              reason: reason.trim(),
            });
        }}
      >
        EMERGENCY STOP
      </button>
      {action.error && <ErrorBox error={action.error} />}
    </Card>
  );
}

function ModeControl() {
  const { data, error } = useMode();
  const setMode = useSetMode();
  const [mode, setModeValue] = useState<TradingMode>('HALTED');
  const [reason, setReason] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (
      mode === 'LIVE' &&
      !window.confirm(
        'LIVE mode sends real orders. It also requires server authorization, verified configuration and account authorization. Continue?',
      )
    )
      return;
    setMode.mutate({ mode, reason });
  };
  return (
    <Card title="Trading mode">
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <KV
            rows={[
              ['Current', <Pill key="m" status={data.mode} />],
              ['Loaded from database', data.loaded ? 'yes' : 'NO — effective mode is HALTED'],
              [
                'Changed',
                data.state ? `${dateTime(data.state.changedAt)} by ${data.state.changedBy}` : '—',
              ],
              ['Reason', data.state?.reason ?? '—'],
            ]}
          />
          <form className="inline-form" onSubmit={submit}>
            <select
              value={mode}
              onChange={(e) => setModeValue(e.target.value as TradingMode)}
              aria-label="New mode"
            >
              {(['HALTED', 'PAPER', 'SHADOW', 'BACKTEST', 'LIVE'] as const).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="reason (audited)"
              minLength={3}
              required
            />
            <button className="btn" disabled={setMode.isPending}>
              Change mode
            </button>
          </form>
          {setMode.error && <ErrorBox error={setMode.error} />}
        </>
      )}
    </Card>
  );
}

function KillSwitchForm() {
  const action = useKillSwitchAction();
  const accounts = useAccounts();
  const cfg = useConfigSummary();
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('ACCOUNT');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const options =
    scope === 'ACCOUNT' || scope === 'EXECUTION'
      ? (accounts.data?.accounts ?? []).map((a) => a.account.id)
      : scope === 'STRATEGY'
        ? (cfg.data?.strategies ?? []).map((s) => s.id)
        : scope === 'INSTRUMENT' || scope === 'NEWS'
          ? (cfg.data?.instruments ?? []).map((i) => i.symbol)
          : [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    action.mutate({
      action: 'activate',
      scope,
      target: NEEDS_TARGET.has(scope) || (OPTIONAL_TARGET.has(scope) && target) ? target : null,
      reason,
    });
    setReason('');
  };
  return (
    <Card title="Activate a kill switch">
      <form className="inline-form" onSubmit={submit}>
        <select
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as (typeof SCOPES)[number]);
            setTarget('');
          }}
          aria-label="Scope"
        >
          {SCOPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        {(NEEDS_TARGET.has(scope) || OPTIONAL_TARGET.has(scope)) && (
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required={NEEDS_TARGET.has(scope)}
            aria-label="Target"
          >
            <option value="">{NEEDS_TARGET.has(scope) ? 'select target…' : 'all'}</option>
            {options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        )}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (audited)"
          minLength={3}
          required
        />
        <button className="btn danger" disabled={action.isPending}>
          Activate
        </button>
      </form>
      {action.error && <ErrorBox error={action.error} />}
    </Card>
  );
}

function KillSwitchList() {
  const { data, error } = useKillSwitches();
  const action = useKillSwitchAction();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const active = data.switches.filter((s) => s.active);
  return (
    <Card title={`Kill switches (${active.length} active)`}>
      {!data.loaded && (
        <div className="error-box">
          Kill-switch state NOT loaded — everything is blocked (fail-closed).
        </div>
      )}
      {data.switches.length === 0 ? (
        <Empty>No kill switch has ever been activated.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Target</th>
              <th>State</th>
              <th>Reason</th>
              <th>Changed</th>
              <th>Clears</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.switches.map((s) => (
              <tr key={`${s.scope}:${s.target ?? '*'}`}>
                <td className="strong">{s.scope}</td>
                <td className="mono">{s.target ?? 'all'}</td>
                <td>
                  <Pill
                    status={s.active ? 'HALTED' : 'ONLINE'}
                    label={s.active ? 'ACTIVE' : 'CLEARED'}
                  />
                </td>
                <td>{s.reason}</td>
                <td className="muted">
                  {dateTime(s.changedAt)} · {s.changedBy.type}:{s.changedBy.id}
                </td>
                <td>
                  {s.clearPolicy === 'NEXT_TRADING_DAY'
                    ? `auto at ${dateTime(s.autoClearAt)}`
                    : 'operator only'}
                </td>
                <td>
                  {s.active && (
                    <button
                      className="btn small"
                      disabled={action.isPending}
                      onClick={() => {
                        const reason = window.prompt(
                          `Why is it safe to clear the ${s.scope} kill switch?`,
                        );
                        if (reason && reason.trim().length >= 3)
                          action.mutate({
                            action: 'deactivate',
                            scope: s.scope,
                            target: s.target,
                            reason: reason.trim(),
                          });
                      }}
                    >
                      Clear
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {action.error && <ErrorBox error={action.error} />}
    </Card>
  );
}
