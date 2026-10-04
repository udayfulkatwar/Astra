/**
 * API response fixtures in the shapes the ASTRA API returns. Test data only: made-up accounts,
 * ids and prices — never market data, credentials or real orders.
 */
import type { DecisionInputs, GateCheckResult } from '@astra/decision';
import type {
  ComponentHealth,
  DecisionDetail,
  KillSwitchState,
  StatusBar,
  TradeDecision,
} from '../api/types';

/** ASTRA's clock in these tests. */
export const NOW = '2026-10-03T14:00:00.000Z';
export const OPERATOR_TOKEN = 'test-operator-token-not-a-secret';

export function statusBar(overrides: Partial<StatusBar> = {}): StatusBar {
  return {
    now: NOW,
    system: 'ONLINE',
    initialized: true,
    mode: 'PAPER',
    trading: { enabled: true, reasons: [] },
    risk: 'SAFE',
    news: { status: 'ONLINE', detail: 'news fresh' },
    calendar: { status: 'ONLINE', highImpactNext4h: null, source: 'test' },
    ai: { status: 'ONLINE', detail: 'ai ready' },
    automation: { status: 'ONLINE', detail: 'heartbeat fresh' },
    data: { status: 'ONLINE', detail: 'fresh quotes' },
    killSwitchesActive: 0,
    simulation: false,
    configHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    configWarnings: [],
    ...overrides,
  };
}

const check = (
  checkId: string,
  layer: GateCheckResult['layer'],
  verdict: GateCheckResult['verdict'],
  reason: string,
): GateCheckResult => ({ checkId, layer, mandatory: true, verdict, reasons: [reason] });

/**
 * One decision as GET /api/v1/decisions/:id returns it. APPROVED carries an approval and an
 * order plan (2 MNQ long); REJECTED carries neither, as the database enforces.
 */
export function decisionDetail(opts: {
  status: 'APPROVED' | 'REJECTED';
  approvalState?: 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'SHADOW_RECORDED';
  expiresAt?: string;
}): DecisionDetail {
  const approved = opts.status === 'APPROVED';
  const expiresAt = opts.expiresAt ?? '2026-10-03T14:05:00.000Z';
  const reasons = approved ? [] : ['risk.capital-preservation: daily loss limit reached'];
  const decision: TradeDecision = {
    decisionId: 'dec-test-001',
    accountId: 'paper-demo',
    strategyId: 'paper-pipeline-test',
    signalId: 'sig-test-001',
    symbol: 'MNQ',
    direction: 'LONG',
    mode: 'PAPER',
    status: opts.status,
    reasons,
    checks: [
      check('system.mode', 'SYSTEM', 'PASS', 'mode PAPER permits new trades'),
      approved
        ? check('risk.capital-preservation', 'RISK', 'PASS', 'within every risk limit')
        : check('risk.capital-preservation', 'RISK', 'FAIL', 'daily loss limit reached'),
    ],
    sizing: null,
    orderPlan: approved
      ? {
          symbol: 'MNQ',
          direction: 'LONG',
          entryType: 'MARKET',
          entry: 20_000.25,
          stop: 19_990.25,
          target: 20_020.25,
          quantity: 2,
        }
      : null,
    approval: approved ? { approvalId: 'apr-test-001', expiresAt } : null,
    configHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    decidedAt: '2026-10-03T13:59:30.000Z',
    explanation: {
      what: approved ? 'APPROVED: LONG 2 MNQ' : 'REJECTED: LONG MNQ',
      why: approved ? ['every mandatory check passed'] : reasons,
      when: '2026-10-03T13:59:30.000Z',
      risk: approved ? '20.00 USD at the stop' : 'no position',
      invalidatedBy: ['price through the stop'],
      wouldStop: ['any kill switch'],
    },
  };
  // The page reads only the candidate's signal and the strategy from the inputs snapshot.
  const inputs = {
    candidate: {
      accountId: 'paper-demo',
      submittedAt: '2026-10-03T13:59:29.000Z',
      signal: {
        id: 'sig-test-001',
        strategyId: 'paper-pipeline-test',
        symbol: 'MNQ',
        direction: 'LONG',
        setupState: 'QUALIFIED',
        entryType: 'MARKET',
        entry: 20_000.25,
        stop: 19_990.25,
        target: 20_020.25,
        detectedAt: '2026-10-03T13:59:28.000Z',
        rationale: ['test signal'],
        features: {},
      },
    },
    strategy: null,
  } as unknown as DecisionInputs;
  return {
    decisionId: decision.decisionId,
    decidedAt: decision.decidedAt,
    accountId: decision.accountId,
    strategyId: decision.strategyId,
    signalId: decision.signalId,
    symbol: decision.symbol,
    direction: decision.direction,
    mode: decision.mode,
    status: decision.status,
    reasons,
    approvalId: decision.approval?.approvalId ?? null,
    approvalState: approved ? (opts.approvalState ?? 'PENDING') : null,
    approvalExpiresAt: approved ? expiresAt : null,
    configHash: decision.configHash,
    decision,
    inputs,
  };
}

export function killSwitch(overrides: Partial<KillSwitchState> = {}): KillSwitchState {
  return {
    scope: 'ACCOUNT',
    target: 'paper-demo',
    active: true,
    reason: 'drawdown review',
    changedBy: { type: 'HUMAN', id: 'operator' },
    changedAt: '2026-10-03T13:00:00.000Z',
    clearPolicy: 'MANUAL',
    autoClearAt: null,
    ...overrides,
  };
}

export function component(
  name: ComponentHealth['component'],
  status: ComponentHealth['status'],
  detail: string,
): ComponentHealth {
  return {
    component: name,
    status,
    detail,
    checkedAt: '2026-10-03T13:59:58.000Z',
    ...(status === 'ONLINE' ? { lastOnlineAt: '2026-10-03T13:59:58.000Z' } : {}),
  };
}
