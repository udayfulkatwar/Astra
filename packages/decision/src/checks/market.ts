import { dec, toNum } from '@astra/core';
import { fail, pass, unknown, type GateCheck } from './check';

export const marketSpread: GateCheck = {
  id: 'market.spread',
  layer: 'MARKET',
  mandatory: true,
  description: 'The current spread is within the instrument limit.',
  evaluate: (i, d) => {
    if (!i.instrument) return unknown('instrument spec not found');
    const q = d.fresh.quote;
    if (q.status !== 'OK') return unknown('no fresh quote');
    const ticks = dec(q.value.ask).minus(q.value.bid).div(i.instrument.tickSize);
    const details = { spreadTicks: toNum(ticks, 2), maxSpreadTicks: i.instrument.maxSpreadTicks };
    return ticks.lte(i.instrument.maxSpreadTicks)
      ? pass(`spread ${toNum(ticks, 2)} ticks`, details)
      : fail(
          `spread ${toNum(ticks, 2)} ticks exceeds limit ${i.instrument.maxSpreadTicks}`,
          details,
        );
  },
};

export const marketEntry: GateCheck = {
  id: 'market.entry',
  layer: 'MARKET',
  mandatory: true,
  description: 'The executable price is close to the signal entry and between stop and target.',
  evaluate: (i, d) => {
    const s = i.candidate.signal;
    if (!i.execution.supportedEntryTypes.includes(s.entryType)) {
      return fail(`entry type ${s.entryType} is not supported by the execution adapter`);
    }
    if (s.entryType !== 'MARKET') return fail(`entry type ${s.entryType} is not supported yet`);
    if (!i.instrument) return unknown('instrument spec not found');
    if (!d.effectiveEntry.ok) return unknown(d.effectiveEntry.reason);
    const px = dec(d.effectiveEntry.value);
    const deviation = px.minus(s.entry).abs().div(i.instrument.tickSize);
    const details = {
      executablePrice: d.effectiveEntry.value,
      signalEntry: s.entry,
      deviationTicks: toNum(deviation, 2),
    };
    const reasons: string[] = [];
    if (deviation.gt(i.policy.maxEntryDeviationTicks)) {
      reasons.push(
        `price moved ${toNum(deviation, 2)} ticks from signal entry (limit ${i.policy.maxEntryDeviationTicks})`,
      );
    }
    const long = s.direction === 'LONG';
    if (long ? px.lte(s.stop) : px.gte(s.stop))
      reasons.push('executable price is already beyond the stop');
    if (long ? px.gte(s.target) : px.lte(s.target))
      reasons.push('executable price is already beyond the target');
    return reasons.length > 0
      ? fail(reasons, details)
      : pass('executable price within entry tolerance', details);
  },
};
