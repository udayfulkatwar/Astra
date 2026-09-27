import { marketStatus } from '@astra/core';
import { useEffect, useState } from 'react';
import { demoRuntime } from './runtime';

/** Explains what the demo is and lets the viewer move the simulated clock. */
export default function DemoBanner() {
  const rt = demoRuntime();
  const [now, setNow] = useState(() => rt.clock.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(rt.clock.now()), 1_000);
    return () => window.clearInterval(t);
  }, [rt]);

  const hours = rt.config.instruments.get('MNQ')?.tradingHours;
  const status = hours ? marketStatus(now, hours) : null;
  const ny = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  const jump = (target: Date) => rt.jumpClock(target);
  const closeSoon = status?.nextClose ? new Date(Date.parse(status.nextClose) - 5 * 60_000) : null;
  const backToOpen = () => {
    const next =
      hours && !status?.open && status?.nextOpen
        ? new Date(Date.parse(status.nextOpen) + 16 * 3_600_000)
        : null;
    if (next) jump(next);
  };

  return (
    <div className="demo-banner" role="note">
      <strong>DEMO</strong>
      <span>
        Runs entirely in your browser: ASTRA’s real safety engines on <b>SIMULATED</b> prices and a
        simulated clock. No broker, no real money.
      </span>
      <span className="demo-clock mono">
        {ny} New York · market {status ? (status.open ? 'OPEN' : 'CLOSED') : 'UNKNOWN'}
      </span>
      <span className="demo-actions">
        {closeSoon && status?.open && (
          <button type="button" className="btn small" onClick={() => jump(closeSoon)}>
            Jump to 5 min before close
          </button>
        )}
        {!status?.open && (
          <button type="button" className="btn small" onClick={backToOpen}>
            Jump to market hours
          </button>
        )}
      </span>
    </div>
  );
}
