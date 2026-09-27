import { describeNotOk, modePolicy, type Observed } from '@astra/core';
import { fail, pass, unknown, type GateCheck } from './check';

export const dataQuote: GateCheck = {
  id: 'data.quote',
  layer: 'DATA',
  mandatory: true,
  description: 'A fresh, valid quote exists for the instrument.',
  evaluate: (i, d) => {
    const q = d.fresh.quote;
    if (q.status !== 'OK') return unknown(describeNotOk('quote', q));
    if (q.value.symbol !== i.candidate.signal.symbol) {
      return fail(`quote symbol ${q.value.symbol} does not match ${i.candidate.signal.symbol}`);
    }
    return pass(`quote fresh (as of ${q.asOf}, source ${q.source})`, {
      bid: q.value.bid,
      ask: q.value.ask,
    });
  },
};

export const dataAccount: GateCheck = {
  id: 'data.account',
  layer: 'DATA',
  mandatory: true,
  description: 'Fresh account snapshot, tracking state and activity records are available.',
  evaluate: (i, d) => {
    const reasons: string[] = [];
    const s = d.fresh.accountSnapshot;
    if (s.status !== 'OK') reasons.push(describeNotOk('account snapshot', s));
    else if (s.value.accountId !== i.candidate.accountId)
      reasons.push('account snapshot belongs to a different account');
    if (!d.tracking.ok) reasons.push(d.tracking.reason);
    if (!d.activity.ok) reasons.push(d.activity.reason);
    return reasons.length > 0
      ? unknown(reasons.join('; '))
      : pass('account data fresh and complete');
  },
};

/** SIMULATED/HISTORICAL data must never drive a SHADOW or LIVE decision. */
export const dataSourceKinds: GateCheck = {
  id: 'data.source-kinds',
  layer: 'DATA',
  mandatory: true,
  description: 'Every data source used is acceptable for the current mode.',
  evaluate: (i, d) => {
    const accepted = modePolicy(i.mode).acceptedDataSources;
    const used: [string, Observed<unknown>][] = [
      ['quote', d.fresh.quote],
      ['account snapshot', d.fresh.accountSnapshot],
      ['calendar', d.fresh.calendar],
      ['news', d.fresh.newsRisk],
      ['ai analysis', d.fresh.aiAnalysis],
    ];
    const bad = used
      .filter(([, o]) => o.status === 'OK' && !accepted.includes(o.sourceKind))
      .map(
        ([label, o]) =>
          `${label} source kind ${o.status === 'OK' ? o.sourceKind : ''} not accepted in ${i.mode}`,
      );
    return bad.length > 0 ? fail(bad) : pass(`data sources acceptable for ${i.mode}`);
  },
};
