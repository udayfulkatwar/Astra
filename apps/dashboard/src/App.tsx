import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, useEffect, useState, type ComponentType } from 'react';
import { createBrowserRouter, createMemoryRouter, RouterProvider } from 'react-router';
import { ApiError, DEMO, getToken } from './api/client';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';

// Every page but the landing Overview is fetched on first visit, so heavy routes (charts,
// backtesting) are not in the entry bundle. Layout shows the loading and load-error states.
const lazyPage = <M extends Record<string, ComponentType>>(load: () => Promise<M>, name: keyof M) =>
  lazy(async () => ({ default: (await load())[name] as ComponentType }));

const AccountDetailPage = lazyPage(() => import('./pages/Accounts'), 'AccountDetailPage');
const Accounts = lazyPage(() => import('./pages/Accounts'), 'Accounts');
const Approvals = lazyPage(() => import('./pages/Approvals'), 'Approvals');
const DecisionDetailPage = lazyPage(() => import('./pages/Approvals'), 'DecisionDetailPage');
const Backtesting = lazyPage(() => import('./pages/Backtesting'), 'Backtesting');
const AiMonitor = lazyPage(() => import('./pages/AiMonitor'), 'AiMonitor');
const CalendarPage = lazyPage(() => import('./pages/Intelligence'), 'CalendarPage');
const NewsPage = lazyPage(() => import('./pages/News'), 'NewsPage');
const MarketScanner = lazyPage(() => import('./pages/MarketScanner'), 'MarketScanner');
const Charts = lazyPage(() => import('./pages/Charts'), 'Charts');
const Journal = lazyPage(() => import('./pages/Journal'), 'Journal');
const Learning = lazyPage(() => import('./pages/Learning'), 'Learning');
const Activity = lazyPage(() => import('./pages/Operations'), 'Activity');
const Audit = lazyPage(() => import('./pages/Operations'), 'Audit');
const Automation = lazyPage(() => import('./pages/Operations'), 'Automation');
const Health = lazyPage(() => import('./pages/Operations'), 'Health');
const Positions = lazyPage(() => import('./pages/Positions'), 'Positions');
const RiskControls = lazyPage(() => import('./pages/RiskControls'), 'RiskControls');
const Configuration = lazyPage(() => import('./pages/Trading'), 'Configuration');
const Paper = lazyPage(() => import('./pages/Trading'), 'Paper');
const Rules = lazyPage(() => import('./pages/Trading'), 'Rules');
const Strategies = lazyPage(() => import('./pages/Trading'), 'Strategies');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const routes = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'approvals', element: <Approvals /> },
      { path: 'approvals/:id', element: <DecisionDetailPage /> },
      { path: 'accounts', element: <Accounts /> },
      { path: 'positions', element: <Positions /> },
      { path: 'journal', element: <Journal /> },
      { path: 'learning', element: <Learning /> },
      { path: 'accounts/:id', element: <AccountDetailPage /> },
      { path: 'risk', element: <RiskControls /> },
      { path: 'activity', element: <Activity /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'news', element: <NewsPage /> },
      { path: 'market', element: <MarketScanner /> },
      { path: 'charts', element: <Charts /> },
      { path: 'strategies', element: <Strategies /> },
      { path: 'rules', element: <Rules /> },
      { path: 'paper', element: <Paper /> },
      { path: 'backtesting', element: <Backtesting /> },
      { path: 'health', element: <Health /> },
      { path: 'automation', element: <Automation /> },
      { path: 'ai', element: <AiMonitor /> },
      { path: 'audit', element: <Audit /> },
      { path: 'config', element: <Configuration /> },
      { path: '*', element: <div className="empty">Page not found.</div> },
    ],
  },
];

// The demo runs inside embedded viewers where the URL is fixed, so it navigates in memory.
const router = DEMO ? createMemoryRouter(routes) : createBrowserRouter(routes);

export function App() {
  const [authed, setAuthed] = useState(() => DEMO || getToken() !== null);
  useEffect(() => {
    const onLogout = () => {
      queryClient.clear();
      setAuthed(false);
    };
    window.addEventListener('astra:logout', onLogout);
    return () => window.removeEventListener('astra:logout', onLogout);
  }, []);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
