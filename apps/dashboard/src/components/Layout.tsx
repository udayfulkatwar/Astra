import { Component, lazy, Suspense, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { DEMO, clearToken } from '../api/client';
import { StatusBar } from './StatusBar';

const NAV: { to: string; label: string; section?: string }[] = [
  { to: '/', label: 'Overview', section: 'Command' },
  { to: '/approvals', label: 'Trade Approval Center' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/positions', label: 'Position Monitor' },
  { to: '/risk', label: 'Risk Controls' },
  { to: '/activity', label: 'Live Activity' },
  { to: '/calendar', label: 'Economic Calendar', section: 'Intelligence' },
  { to: '/news', label: 'News Intelligence' },
  { to: '/market', label: 'Market Scanner' },
  { to: '/charts', label: 'Charts' },
  { to: '/strategies', label: 'Strategy Manager', section: 'Trading' },
  { to: '/rules', label: 'Prop-Firm Rules' },
  { to: '/journal', label: 'Trade Journal' },
  { to: '/learning', label: 'Learning Metrics' },
  { to: '/paper', label: 'Paper Trading' },
  { to: '/backtesting', label: 'Backtesting' },
  { to: '/health', label: 'System Health', section: 'Operations' },
  { to: '/automation', label: 'Automation Monitor' },
  { to: '/ai', label: 'AI Model Monitor' },
  { to: '/audit', label: 'Audit Log' },
  { to: '/config', label: 'Configuration' },
];

// Loaded only in demo builds.
const DemoBanner = __ASTRA_DEMO__ ? lazy(() => import('../demo/DemoBanner')) : null;

/** Catches a page chunk that failed to load (offline, or a stale tab after a deploy). */
class PageLoadBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" role="alert">
        <p>This page could not be loaded. Check the connection and reload.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

export function Layout() {
  const { pathname } = useLocation();
  return (
    <div className="app">
      {DemoBanner && (
        <Suspense fallback={null}>
          <DemoBanner />
        </Suspense>
      )}
      <StatusBar />
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            <span className="brand-mark">▲</span>
            <div>
              <div className="brand-name">ASTRA</div>
              <div className="brand-sub">Strategic Trading &amp; Risk Agent</div>
            </div>
          </div>
          {NAV.map((n) => (
            <div key={n.to}>
              {n.section && <div className="nav-section">{n.section}</div>}
              <NavLink
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                {n.label}
              </NavLink>
            </div>
          ))}
          {!DEMO && (
            <button className="btn ghost logout" onClick={clearToken}>
              Sign out
            </button>
          )}
        </nav>
        <main className="main">
          {/* Keyed by route so a load error clears when the operator navigates elsewhere. */}
          <PageLoadBoundary key={pathname}>
            <Suspense
              fallback={
                <div className="empty" role="status">
                  Loading page…
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </PageLoadBoundary>
        </main>
      </div>
    </div>
  );
}
