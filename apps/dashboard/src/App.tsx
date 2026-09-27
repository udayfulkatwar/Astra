import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ApiError, getToken } from './api/client';
import { Layout } from './components/Layout';
import { AccountDetailPage, Accounts } from './pages/Accounts';
import { Approvals, DecisionDetailPage } from './pages/Approvals';
import { AiMonitor, Backtesting, CalendarPage, Market, News } from './pages/Intelligence';
import { Login } from './pages/Login';
import { Activity, Audit, Automation, Health } from './pages/Operations';
import { Overview } from './pages/Overview';
import { RiskControls } from './pages/RiskControls';
import { Configuration, Paper, Rules, Strategies } from './pages/Trading';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'approvals', element: <Approvals /> },
      { path: 'approvals/:id', element: <DecisionDetailPage /> },
      { path: 'accounts', element: <Accounts /> },
      { path: 'accounts/:id', element: <AccountDetailPage /> },
      { path: 'risk', element: <RiskControls /> },
      { path: 'activity', element: <Activity /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'news', element: <News /> },
      { path: 'market', element: <Market /> },
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
]);

export function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null);
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
