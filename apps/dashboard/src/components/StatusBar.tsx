import { useAccounts, useStatus } from '../api/hooks';
import { Pill } from './ui';

/** Core status bar (spec §67), always visible. Anything not reported shows UNKNOWN. */
export function StatusBar() {
  const { data: s, error } = useStatus();
  const { data: accounts } = useAccounts();
  if (error || !s) {
    return (
      <div className="statusbar">
        <Item k="SYSTEM">
          <Pill
            status={error ? 'ERROR' : 'UNKNOWN'}
            label={error ? 'API UNREACHABLE' : 'CONNECTING'}
          />
        </Item>
      </div>
    );
  }
  const accountLabel =
    accounts?.accounts.length === 1
      ? accounts.accounts[0]!.account.id
      : `${accounts?.accounts.length ?? 0} accounts`;
  return (
    <div className="statusbar" role="status">
      <Item k="SYSTEM">
        <Pill status={s.system} />
      </Item>
      <Item k="MODE">
        <Pill status={s.mode} />
      </Item>
      <Item k="ACCOUNT">
        <span className="mono">{accountLabel}</span>
      </Item>
      <Item k="TRADING">
        <Pill status={s.trading.enabled ? 'ENABLED' : 'DISABLED'} />
      </Item>
      <Item k="RISK">
        <Pill status={s.risk} />
      </Item>
      <Item k="NEWS">
        <Pill status={s.news.status} />
      </Item>
      <Item k="CALENDAR">
        <Pill
          status={s.calendar.highImpactNext4h ? 'HIGH' : s.calendar.status}
          label={
            s.calendar.highImpactNext4h
              ? `HIGH IMPACT ×${s.calendar.highImpactNext4h}`
              : s.calendar.status === 'ONLINE'
                ? 'NORMAL'
                : s.calendar.status
          }
        />
      </Item>
      <Item k="AI">
        <Pill status={s.ai.status} />
      </Item>
      <Item k="N8N">
        <Pill status={s.automation.status} />
      </Item>
      <Item k="DATA">
        <Pill
          status={s.data.status === 'ONLINE' ? 'ONLINE' : s.data.status}
          label={
            s.data.status === 'ONLINE'
              ? 'HEALTHY'
              : s.data.status === 'UNKNOWN'
                ? 'STALE/UNKNOWN'
                : s.data.status
          }
        />
      </Item>
      {s.killSwitchesActive > 0 && (
        <Item k="KILL SWITCHES">
          <Pill status="CRITICAL" label={`${s.killSwitchesActive} ACTIVE`} />
        </Item>
      )}
      {s.simulation && (
        <Item k="FEEDS">
          <Pill status="SHADOW" label="SIMULATED" />
        </Item>
      )}
    </div>
  );
}

function Item({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="sb-item">
      <span className="sb-key">{k}</span>
      {children}
    </div>
  );
}
