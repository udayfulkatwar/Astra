/** RISK, PROP_FIRM, POSITION and EXECUTION layers. */
import { describeNotOk, modePolicy } from '@astra/core';
import { combine, fail, pass, unknown, type GateCheck } from './check';

export const riskCapitalPreservation: GateCheck = {
  id: 'risk.capital-preservation',
  layer: 'RISK',
  mandatory: true,
  description:
    'Account health, position size, R:R, exposure and activity limits (internal policy).',
  evaluate: (_i, d) => {
    if (!d.risk.ok) return unknown(d.risk.reason);
    const v = d.risk.value;
    return combine(
      v.checks.map((c) => ({ verdict: c.verdict, message: c.message })),
      'internal risk policy satisfied',
      {
        checks: v.checks,
        sizing: d.sizing.ok ? d.sizing.value : null,
        health: d.health.ok ? d.health.value : null,
      },
    );
  },
};

export const propFirmRules: GateCheck = {
  id: 'prop-firm.rules',
  layer: 'PROP_FIRM',
  mandatory: true,
  description: 'Every prop-firm rule holds in the worst case (all stops hit).',
  evaluate: (_i, d) => {
    if (!d.propFirm.ok) return unknown(d.propFirm.reason);
    const v = d.propFirm.value;
    return combine(
      v.checks.map((c) => ({ verdict: c.verdict, message: c.message })),
      'all prop-firm rules satisfied',
      { status: v.status, checks: v.checks },
    );
  },
};

export const propFirmConfigVerification: GateCheck = {
  id: 'prop-firm.config-verification',
  layer: 'PROP_FIRM',
  mandatory: true,
  description:
    'Rule profile, instrument spec, risk policy and strategy are owner-verified where the mode requires it.',
  evaluate: (i) => {
    if (!i.profile || !i.instrument || !i.riskPolicy || !i.strategy)
      return unknown('configuration incomplete');
    const unverified: string[] = [];
    if (i.profile.verification.status !== 'USER_VERIFIED')
      unverified.push(`prop-firm profile ${i.profile.id}`);
    if (i.instrument.verification.status !== 'USER_VERIFIED')
      unverified.push(`instrument ${i.instrument.symbol}`);
    if (i.riskPolicy.ownership !== 'USER') unverified.push(`risk policy ${i.riskPolicy.id}`);
    if (i.strategy.ownership !== 'USER') unverified.push(`strategy ${i.strategy.id}`);
    if (unverified.length === 0) return pass('all configuration owner-verified');
    return modePolicy(i.mode).allowsUnverifiedConfig
      ? pass(`unverified configuration permitted in ${i.mode}`, { unverified })
      : fail(unverified.map((u) => `${u} is not owner-verified (required in ${i.mode})`));
  },
};

export const positionDuplicates: GateCheck = {
  id: 'position.duplicates',
  layer: 'POSITION',
  mandatory: true,
  description:
    'The signal has not already been approved and no order is working for this instrument.',
  evaluate: (i) => {
    const dup = i.duplicates;
    if (dup.status !== 'OK') return unknown(describeNotOk('duplicate check', dup));
    const reasons: string[] = [];
    if (dup.value.priorApprovedDecisionId) {
      reasons.push(
        `signal ${i.candidate.signal.id} already approved in decision ${dup.value.priorApprovedDecisionId}`,
      );
    }
    if (dup.value.workingOrderForSymbol)
      reasons.push(`an order for ${i.candidate.signal.symbol} is already working`);
    return reasons.length > 0 ? fail(reasons) : pass('no duplicate signal or working order');
  },
};

export const executionReadiness: GateCheck = {
  id: 'execution.readiness',
  layer: 'EXECUTION',
  mandatory: true,
  description: 'An execution adapter of the right kind is healthy and reconciled.',
  evaluate: (i) => {
    const policy = modePolicy(i.mode);
    if (!policy.transmitsOrders) return pass(`${i.mode}: orders are not transmitted`);
    const e = i.execution;
    const reasons: string[] = [];
    if (!e.adapterId) reasons.push('no execution adapter registered for the account');
    if (e.adapterKind !== policy.brokerKind) {
      reasons.push(
        `adapter kind ${e.adapterKind ?? 'none'} does not match mode ${i.mode} (needs ${policy.brokerKind})`,
      );
    }
    if (e.health !== 'ONLINE') reasons.push(`execution adapter is ${e.health}`);
    if (!e.reconciled)
      reasons.push('orders/positions not reconciled with the broker since startup');
    return reasons.length > 0
      ? fail(reasons)
      : pass(`adapter ${e.adapterId} (${e.adapterKind}) ready`);
  },
};

export const executionLiveAuthorization: GateCheck = {
  id: 'execution.live-authorization',
  layer: 'EXECUTION',
  mandatory: true,
  description: 'LIVE mode requires environment and account authorization (ADR-0008).',
  evaluate: (i) => {
    if (i.mode !== 'LIVE') return pass(`not LIVE (${i.mode})`);
    const reasons: string[] = [];
    if (!i.liveTradingEnvironmentAuthorized)
      reasons.push('live trading not authorized in the server environment');
    if (!i.account?.liveTradingAuthorized)
      reasons.push('live trading not authorized for this account');
    return reasons.length > 0 ? fail(reasons) : pass('live trading authorized');
  },
};
