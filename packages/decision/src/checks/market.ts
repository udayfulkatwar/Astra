import { activeSessions, dec, marketStatus, toNum } from '@astra/core';
import { entryWindowEnd, type Derivations } from '../derive';
import type { DecisionInputs } from '../types';
import { fail, pass, unknown, type CheckOutcome, type GateCheck } from './check';

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
    if (s.entryType === 'LIMIT') return limitEntry(i, d);
    if (!i.instrument) return unknown('instrument spec not found');
    if (!d.effectiveEntry.ok) return unknown(d.effectiveEntry.reason);
    const px = dec(d.effectiveEntry.value);
    const maxDeviation = i.instrument.maxEntryDeviationTicks ?? i.policy.maxEntryDeviationTicks;
    const deviation = px.minus(s.entry).abs().div(i.instrument.tickSize);
    const details = {
      executablePrice: d.effectiveEntry.value,
      signalEntry: s.entry,
      deviationTicks: toNum(deviation, 2),
    };
    const reasons: string[] = [];
    if (deviation.gt(maxDeviation)) {
      reasons.push(
        `price moved ${toNum(deviation, 2)} ticks from signal entry (limit ${maxDeviation})`,
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

/** Default for `maxWorkingOrderMinutes`. */
export const DEFAULT_MAX_WORKING_ORDER_MINUTES = 240;

/**
 * A LIMIT entry rests at the broker until it fills or expires. It needs an expiry within the
 * policy maximum, a limit on the tick grid between stop and target, and a market that has not
 * already run through the stop or the target (a missed setup is no trade — never chased).
 */
function limitEntry(i: DecisionInputs, d: Derivations): CheckOutcome {
  const s = i.candidate.signal;
  if (!i.instrument) return unknown('instrument spec not found');
  if (!d.effectiveEntry.ok) return unknown(d.effectiveEntry.reason);
  const q = d.fresh.quote;
  if (q.status !== 'OK') return unknown('no fresh quote');
  const reasons: string[] = [];
  const now = Date.parse(i.now);
  const maxMinutes = i.policy.maxWorkingOrderMinutes ?? DEFAULT_MAX_WORKING_ORDER_MINUTES;
  const expires = s.expiresAt ? Date.parse(s.expiresAt) : NaN;
  if (!s.expiresAt) reasons.push('a LIMIT entry needs an expiry (expiresAt)');
  else if (!(expires > now))
    reasons.push(`the LIMIT order would already be expired (${s.expiresAt})`);
  else if (expires - now > maxMinutes * 60_000)
    reasons.push(`the LIMIT order would rest longer than ${maxMinutes} min`);
  const tick = dec(i.instrument.tickSize);
  if (!dec(s.entry).div(tick).isInteger())
    reasons.push(`limit ${s.entry} is not a multiple of the tick size ${i.instrument.tickSize}`);
  const long = s.direction === 'LONG';
  const px = dec(long ? q.value.ask : q.value.bid);
  if (long ? px.lte(s.stop) : px.gte(s.stop)) reasons.push('the market is already beyond the stop');
  if (long ? px.gte(s.target) : px.lte(s.target))
    reasons.push('the market already reached the target (setup missed)');
  const marketable = long ? px.lte(s.entry) : px.gte(s.entry);
  const details = {
    limit: s.entry,
    executablePrice: toNum(px),
    expiresAt: s.expiresAt ?? null,
    marketable,
    distanceTicks: toNum(px.minus(s.entry).abs().div(tick), 2),
  };
  if (reasons.length > 0) return fail(reasons, details);
  return pass(
    marketable
      ? `limit ${s.entry} is marketable: fills now at ${toNum(px)} or better`
      : `limit ${s.entry} rests ${details.distanceTicks} ticks from the market until ${s.expiresAt}`,
    details,
  );
}

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
    // A resting LIMIT order must be gone before the no-new-trades window of the close.
    const until = entryWindowEnd(i.candidate.signal);
    if (until && status.nextClose !== null) {
      const latest = Date.parse(status.nextClose) - i.policy.minMinutesBeforeMarketClose * 60_000;
      if (until.getTime() > latest)
        reasons.push(
          `the LIMIT order would still rest within ${i.policy.minMinutesBeforeMarketClose} min of the ${symbol} market close (${status.nextClose})`,
        );
    }
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
