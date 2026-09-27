import { activeSessions, dec, marketStatus, toNum } from '@astra/core';
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

export const marketSession: GateCheck = {
  id: 'market.session',
  layer: 'MARKET',
  mandatory: true,
  description: 'The market is open, not about to close, and inside the strategy’s sessions.',
  evaluate: (i) => {
    const symbol = i.candidate.signal.symbol;
    if (!i.instrument) return unknown('instrument spec not found');
    const hours = i.instrument.tradingHours;
    if (!hours) return unknown(`trading hours not configured for ${symbol}; market status UNKNOWN`);
    const now = new Date(i.now);
    const status = marketStatus(now, hours);
    const active = activeSessions(now, i.sessions);
    const details = {
      marketOpen: status.open,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose,
      minutesToClose: status.minutesToClose === null ? null : Math.floor(status.minutesToClose),
      activeSessions: active,
    };
    if (!status.open)
      return fail(`${symbol} market is closed (next open ${status.nextOpen})`, details);

    const reasons: string[] = [];
    if (
      status.minutesToClose !== null &&
      status.minutesToClose <= i.policy.minMinutesBeforeMarketClose
    ) {
      reasons.push(
        `${symbol} market closes in ${Math.floor(status.minutesToClose)} min (no new trades within ${i.policy.minMinutesBeforeMarketClose} min)`,
      );
    }
    const allowed = i.strategy?.sessions ?? [];
    if (allowed.length > 0) {
      const undefinedIds = allowed.filter((id) => !i.sessions.some((s) => s.id === id));
      if (undefinedIds.length > 0)
        return unknown(
          `strategy references undefined session(s): ${undefinedIds.join(', ')}`,
          details,
        );
      if (!allowed.some((id) => active.includes(id))) {
        reasons.push(
          `outside strategy sessions (${allowed.join(', ')}); active now: ${active.join(', ') || 'none'}`,
        );
      }
    }
    return reasons.length > 0
      ? fail(reasons, details)
      : pass(
          `market open, ${Math.floor(status.minutesToClose ?? 0)} min to close; sessions: ${active.join(', ') || 'none'}`,
          details,
        );
  },
};
