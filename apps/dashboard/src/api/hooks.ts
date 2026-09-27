import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, getToken } from './client';
import { syncAstraClock } from '../lib/format';
import type {
  AccountDetail,
  AccountView,
  AuditEntry,
  Bar,
  CalendarWindow,
  ComponentHealth,
  ConfigSummary,
  DecisionDetail,
  DecisionSummary,
  EventRiskView,
  ExecutionResult,
  KillSwitchState,
  MarketSnapshot,
  MarketStructure,
  TradeDecision,
  ModeInfo,
  Observed,
  OrderRecord,
  PositionMonitor,
  Quote,
  StatusBar,
  SystemEvent,
  Timeframe,
  TradingMode,
} from './types';

export const useStatus = () =>
  useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      const status = await api<StatusBar>('/api/v1/system/status');
      syncAstraClock(status.now);
      return status;
    },
    refetchInterval: 3_000,
  });

export const useHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ components: ComponentHealth[] }>('/api/v1/system/health'),
    refetchInterval: 5_000,
  });

export const useMode = () =>
  useQuery({ queryKey: ['mode'], queryFn: () => api<ModeInfo>('/api/v1/system/mode') });

export const useAccounts = () =>
  useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: AccountView[] }>('/api/v1/accounts'),
    refetchInterval: 3_000,
  });

export const useAccount = (id: string) =>
  useQuery({
    queryKey: ['account', id],
    queryFn: () => api<AccountDetail>(`/api/v1/accounts/${encodeURIComponent(id)}`),
    refetchInterval: 3_000,
  });

export const useDecisions = (filter: { status?: string; accountId?: string } = {}) => {
  const qs = new URLSearchParams({
    limit: '100',
    ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)),
  });
  return useQuery({
    queryKey: ['decisions', filter],
    queryFn: () => api<{ decisions: DecisionSummary[] }>(`/api/v1/decisions?${qs.toString()}`),
    refetchInterval: 5_000,
  });
};

export const useDecision = (id: string) =>
  useQuery({
    queryKey: ['decision', id],
    queryFn: () => api<DecisionDetail>(`/api/v1/decisions/${encodeURIComponent(id)}`),
  });

export const useKillSwitches = () =>
  useQuery({
    queryKey: ['kill-switches'],
    queryFn: () => api<{ loaded: boolean; switches: KillSwitchState[] }>('/api/v1/kill-switches'),
    refetchInterval: 5_000,
  });

export const useAudit = (category?: string) =>
  useQuery({
    queryKey: ['audit', category],
    queryFn: () =>
      api<{ entries: AuditEntry[] }>(
        `/api/v1/audit?limit=200${category ? `&category=${encodeURIComponent(category)}` : ''}`,
      ),
  });

export const useConfigSummary = () =>
  useQuery({
    queryKey: ['config'],
    queryFn: () => api<ConfigSummary>('/api/v1/config/summary'),
    staleTime: 60_000,
  });

export const useQuotes = () =>
  useQuery({
    queryKey: ['quotes'],
    queryFn: () =>
      api<{ quotes: (Observed<Quote> & { status: 'OK'; value: Quote })[] }>(
        '/api/v1/market/quotes',
      ),
    refetchInterval: 2_000,
  });

export const useScanner = () =>
  useQuery({
    queryKey: ['scanner'],
    queryFn: () => api<{ snapshots: MarketSnapshot[] }>('/api/v1/market/scanner'),
    refetchInterval: 2_000,
  });

export const useStructure = (timeframe: Timeframe) =>
  useQuery({
    queryKey: ['structure', timeframe],
    queryFn: () =>
      api<{ structures: MarketStructure[] }>(`/api/v1/market/structure?timeframe=${timeframe}`),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });

export const useBars = (symbol: string | null, timeframe: Timeframe, limit: number) =>
  useQuery({
    queryKey: ['bars', symbol, timeframe, limit],
    queryFn: () =>
      api<{ bars: Bar[] }>(
        `/api/v1/market/bars?symbol=${encodeURIComponent(symbol ?? '')}&timeframe=${timeframe}&limit=${limit}`,
      ),
    enabled: symbol !== null,
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });

export const useCalendar = (hours = 24) =>
  useQuery({
    queryKey: ['calendar', hours],
    queryFn: () => api<Observed<CalendarWindow | null>>(`/api/v1/calendar/upcoming?hours=${hours}`),
    refetchInterval: 30_000,
  });

export const useCalendarRisk = () =>
  useQuery({
    queryKey: ['calendar-risk'],
    queryFn: () => api<EventRiskView>('/api/v1/calendar/risk'),
    refetchInterval: 5_000,
  });

export const usePositionMonitor = () =>
  useQuery({
    queryKey: ['position-monitor'],
    queryFn: () => api<PositionMonitor>('/api/v1/monitor/positions'),
    refetchInterval: 2_000,
  });

export const useOrders = () =>
  useQuery({
    queryKey: ['orders'],
    queryFn: () => api<{ orders: OrderRecord[] }>('/api/v1/orders?limit=100'),
    refetchInterval: 5_000,
  });

function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function useSetMode() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (b: { mode: TradingMode; reason: string }) =>
      api('/api/v1/system/mode', { method: 'POST', body: b }),
    onSettled: invalidate,
  });
}

export function useKillSwitchAction() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (b: {
      action: 'activate' | 'deactivate';
      scope: string;
      target: string | null;
      reason: string;
    }) =>
      api(`/api/v1/kill-switches/${b.action}`, {
        method: 'POST',
        body: { scope: b.scope, target: b.target, reason: b.reason },
      }),
    onSettled: invalidate,
  });
}

export function useExecute() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (approvalId: string) =>
      api<ExecutionResult>('/api/v1/executions', { method: 'POST', body: { approvalId } }),
    onSettled: invalidate,
  });
}

export interface EvaluateResponse {
  decision: TradeDecision;
  persisted: boolean;
  execution: ExecutionResult | null;
}

export function useEvaluate() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (b: { candidate: unknown; autoExecute: boolean }) =>
      api<EvaluateResponse>('/api/v1/decisions/evaluate', { method: 'POST', body: b }),
    onSettled: invalidate,
  });
}

export function useVerifyAudit() {
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; checked: number; brokenAtSeq: number | null }>('/api/v1/audit/verify'),
  });
}

/**
 * Live activity via Server-Sent Events over fetch() (EventSource cannot send the bearer token).
 * Seeds with recent history, then appends streamed events; reconnects with backoff.
 */
export function useEventStream(limit = 200): { events: SystemEvent[]; connected: boolean } {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    const controller = new AbortController();
    let retry = 1_000;

    const seed = async () => {
      try {
        const { events: recent } = await api<{ events: SystemEvent[] }>(
          `/api/v1/events?limit=${limit}`,
        );
        setEvents(recent);
      } catch {
        /* surfaced by connection state */
      }
    };

    const connect = async (): Promise<void> => {
      while (!stopped.current) {
        try {
          const res = await fetch('/api/v1/stream', {
            headers: { Authorization: `Bearer ${getToken() ?? ''}` },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
          setConnected(true);
          retry = 1_000;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const data = frame
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6))
                .join('\n');
              if (data) {
                const e = JSON.parse(data) as SystemEvent;
                setEvents((prev) => [e, ...prev].slice(0, limit));
              }
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        setConnected(false);
        await new Promise((r) => setTimeout(r, retry));
        retry = Math.min(retry * 2, 30_000);
      }
    };

    void seed();
    if (__ASTRA_DEMO__) {
      let unsubscribe: (() => void) | undefined;
      void import('../demo/router').then(({ subscribeDemoEvents }) => {
        if (stopped.current) return;
        setConnected(true);
        unsubscribe = subscribeDemoEvents((e) => setEvents((prev) => [e, ...prev].slice(0, limit)));
      });
      return () => {
        stopped.current = true;
        unsubscribe?.();
      };
    }
    void connect();
    return () => {
      stopped.current = true;
      controller.abort();
    };
  }, [limit]);

  return { events, connected };
}
