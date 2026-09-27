import { NavLink, Outlet } from 'react-router';
import { clearToken } from '../api/client';
import { StatusBar } from './StatusBar';

const NAV: { to: string; label: string; section?: string }[] = [
  { to: '/', label: 'Overview', section: 'Command' },
  { to: '/approvals', label: 'Trade Approval Center' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/risk', label: 'Risk Controls' },
  { to: '/activity', label: 'Live Activity' },
  { to: '/calendar', label: 'Economic Calendar', section: 'Intelligence' },
  { to: '/news', label: 'News Intelligence' },
  { to: '/market', label: 'Market Scanner' },
  { to: '/strategies', label: 'Strategy Manager', section: 'Trading' },
  { to: '/rules', label: 'Prop-Firm Rules' },
  { to: '/paper', label: 'Paper Trading' },
  { to: '/backtesting', label: 'Backtesting' },
  { to: '/health', label: 'System Health', section: 'Operations' },
  { to: '/automation', label: 'Automation Monitor' },
  { to: '/ai', label: 'AI Model Monitor' },
  { to: '/audit', label: 'Audit Log' },
  { to: '/config', label: 'Configuration' },
];

export function Layout() {
  return (
    <div className="app">
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
          <button className="btn ghost logout" onClick={clearToken}>
            Sign out
          </button>
        </nav>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
