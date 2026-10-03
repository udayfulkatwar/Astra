import type { ReactNode } from 'react';
import { toneOf, type Tone } from '../lib/status';

export function Pill({
  status,
  label,
  tone,
}: {
  status: string | null | undefined;
  label?: string;
  tone?: Tone;
}) {
  const t = tone ?? toneOf(status);
  return <span className={`pill tone-${t}`}>{label ?? status ?? 'UNKNOWN'}</span>;
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={`stat ${tone ? `tone-text-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** Limit usage bar with the policy's caution / restricted thresholds marked. */
export function UsageBar({
  pct,
  caution = 40,
  restricted = 70,
  label,
}: {
  pct: number | null | undefined;
  caution?: number;
  restricted?: number;
  label?: string;
}) {
  const known = pct !== null && pct !== undefined && !Number.isNaN(pct);
  const v = known ? Math.max(0, Math.min(100, pct)) : 0;
  const tone: Tone = !known ? 'unknown' : v >= restricted ? 'bad' : v >= caution ? 'warn' : 'ok';
  return (
    <div className="usage" title={label}>
      <div className="usage-track">
        <div className={`usage-fill fill-${tone}`} style={{ width: `${v}%` }} />
        <div className="usage-mark" style={{ left: `${caution}%` }} />
        <div className="usage-mark strong" style={{ left: `${restricted}%` }} />
      </div>
      <span className="usage-text">{known ? `${v.toFixed(1)}%` : 'UNKNOWN'}</span>
    </div>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

/** `title` names what failed: a read by default; an action passes its own (never "load"). */
export function ErrorBox({
  error,
  title = 'Could not load data',
}: {
  error: unknown;
  title?: string;
}) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-box">
      {title}: {msg}
    </div>
  );
}

/** Honest placeholder for capabilities that are not built yet. No fake data. */
export function NotBuilt({
  phase,
  what,
  children,
}: {
  phase: string;
  what: string;
  children?: ReactNode;
}) {
  return (
    <div className="not-built">
      <div className="not-built-tag">{phase}</div>
      <p>
        <strong>{what}</strong> is not implemented yet. ASTRA shows no data here rather than
        simulated values.
      </p>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
