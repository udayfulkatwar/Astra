import { dec, directionSign, exposurePositions, modePolicy, toNum } from '@astra/core';
import { fail, pass, unknown, type GateCheck } from './check';

export const strategyEligibility: GateCheck = {
  id: 'strategy.eligibility',
  layer: 'STRATEGY',
  mandatory: true,
  description:
    'Strategy is active, enabled for the account and allowed on this instrument and direction.',
  evaluate: (i) => {
    const s = i.candidate.signal;
    const strat = i.strategy;
    if (!i.account) return fail(`account ${i.candidate.accountId} not found`);
    if (!strat) return fail(`strategy ${s.strategyId} not found`);
    const reasons: string[] = [];
    if (strat.status !== 'ACTIVE') reasons.push(`strategy status is ${strat.status}`);
    if (!i.account.strategies.includes(strat.id))
      reasons.push(`strategy ${strat.id} not enabled for account ${i.account.id}`);
    if (!strat.instruments.includes(s.symbol))
      reasons.push(`${s.symbol} not in strategy instruments`);
    if (!i.account.instruments.includes(s.symbol))
      reasons.push(`${s.symbol} not enabled for account ${i.account.id}`);
    if (strat.direction === 'LONG_ONLY' && s.direction !== 'LONG')
      reasons.push('strategy is LONG_ONLY');
    if (strat.direction === 'SHORT_ONLY' && s.direction !== 'SHORT')
      reasons.push('strategy is SHORT_ONLY');
    if (strat.ownership === 'TEMPLATE' && !modePolicy(i.mode).allowsUnverifiedConfig) {
      reasons.push(
        `TEMPLATE strategy cannot trade in ${i.mode}; the owner's strategy rules are required`,
      );
    }
    return reasons.length > 0
      ? fail(reasons)
      : pass(`strategy ${strat.id} v${strat.version} eligible`);
  },
};

export const strategySignal: GateCheck = {
  id: 'strategy.signal',
  layer: 'STRATEGY',
  mandatory: true,
  description: 'Signal is QUALIFIED, belongs to the strategy, and has not expired.',
  evaluate: (i) => {
    const s = i.candidate.signal;
    if (!i.strategy) return unknown('strategy not found');
    const reasons: string[] = [];
    if (s.setupState !== 'QUALIFIED') reasons.push(`setup state is ${s.setupState}, not QUALIFIED`);
    if (s.strategyId !== i.strategy.id) reasons.push('signal strategy mismatch');
    const now = Date.parse(i.now);
    const detected = Date.parse(s.detectedAt);
    const ageSec = (now - detected) / 1000;
    if (detected - now > i.policy.freshness.maxFutureSkewMs)
      reasons.push('signal detection time is in the future');
    if (ageSec > i.strategy.signalTtlSeconds) {
      reasons.push(
        `signal expired (${Math.round(ageSec)}s old, TTL ${i.strategy.signalTtlSeconds}s)`,
      );
    }
    return reasons.length > 0
      ? fail(reasons)
      : pass(`signal qualified, ${Math.max(0, Math.round(ageSec))}s old`);
  },
};

export const strategyLevels: GateCheck = {
  id: 'strategy.levels',
  layer: 'STRATEGY',
  mandatory: true,
  description: 'Stop and target are on the correct sides of entry.',
  evaluate: (i) => {
    const s = i.candidate.signal;
    const sign = directionSign(s.direction);
    const reasons: string[] = [];
    if (dec(s.entry).minus(s.stop).mul(sign).lte(0))
      reasons.push('stop is not on the protective side of entry');
    if (dec(s.target).minus(s.entry).mul(sign).lte(0))
      reasons.push('target is not on the profit side of entry');
    return reasons.length > 0 ? fail(reasons) : pass('stop and target placement valid');
  },
};

/**
 * The strategy's own risk limits (owner rules): entries per symbol per day, a daily realized-loss
 * stop, a stop after consecutive full-risk losses, and caps on correlated positions and their
 * open risk. Working (not yet filled) orders count as entries and as positions. Data a limit
 * needs but does not have makes the check UNKNOWN — no trade.
 */
export const strategyLimits: GateCheck = {
  id: 'strategy.limits',
  layer: 'STRATEGY',
  mandatory: true,
  description:
    'The strategy’s own limits hold: entries per symbol, daily loss stop, full-risk-loss streak, correlated exposure.',
  evaluate: (i, d) => {
    const limits = i.strategy?.limits;
    if (!i.strategy) return unknown('strategy not found');
    if (!limits) return pass('no strategy-specific limits');
    const s = i.candidate.signal;
    const reasons: string[] = [];
    const unknowns: string[] = [];
    const details: Record<string, unknown> = {};

    if (limits.maxEntriesPerSymbolPerDay !== undefined) {
      if (!d.activity.ok) unknowns.push(d.activity.reason);
      else if (!d.activity.value.entriesBySymbol) unknowns.push('entries per symbol unknown');
      else {
        const n = d.activity.value.entriesBySymbol[s.symbol] ?? 0;
        details.entriesToday = n;
        if (n >= limits.maxEntriesPerSymbolPerDay)
          reasons.push(
            `${n}/${limits.maxEntriesPerSymbolPerDay} ${s.symbol} entries already today`,
          );
      }
    }

    if (limits.dailyRealizedLossStopPercent !== undefined) {
      const snap = d.fresh.accountSnapshot;
      if (!d.tracking.ok) unknowns.push(d.tracking.reason);
      else if (snap.status !== 'OK') unknowns.push('account snapshot not fresh');
      else {
        const start = dec(d.tracking.value.dayStartBalance);
        const realized = dec(snap.value.balance).minus(start);
        const stop = start.mul(limits.dailyRealizedLossStopPercent).div(100).neg();
        details.realizedToday = realized.toNumber();
        if (realized.lte(stop))
          reasons.push(
            `realized ${realized.toFixed(2)} today reached the −${limits.dailyRealizedLossStopPercent}% daily stop (${stop.toFixed(2)})`,
          );
      }
    }

    if (limits.fullRiskLosses) {
      const f = limits.fullRiskLosses;
      if (!d.activity.ok) unknowns.push(d.activity.reason);
      else if (!d.activity.value.closedTodayR) unknowns.push('R of today’s closed trades unknown');
      else {
        let streak = 0;
        let unknownR = false;
        for (const r of d.activity.value.closedTodayR) {
          if (r === null) {
            unknownR = true;
            break;
          }
          if (r > f.atOrBelowR) break;
          streak++;
        }
        details.fullRiskLossStreak = streak;
        if (unknownR && streak < f.maxConsecutive)
          unknowns.push('a trade closed today has no known R (full-risk-loss streak unknown)');
        else if (streak >= f.maxConsecutive)
          reasons.push(
            `${streak} consecutive full-risk losses (≤ ${f.atOrBelowR}R) today: stopped for the day`,
          );
      }
    }

    for (const g of limits.correlation ?? []) {
      if (!g.symbols.includes(s.symbol)) continue;
      const snap = d.fresh.accountSnapshot;
      if (snap.status !== 'OK' || !d.accountState.ok) {
        unknowns.push('account exposure unknown');
        continue;
      }
      if (!d.sizing.ok || !d.sizing.value.ok) {
        unknowns.push('no position size to add to the group risk');
        continue;
      }
      const inGroup = exposurePositions(snap.value).filter((p) => g.symbols.includes(p.symbol));
      const risks = new Map(d.accountState.value.openRisk.positions.map((p) => [p.positionId, p]));
      let open = dec(0);
      let complete = true;
      for (const p of inGroup) {
        const r = risks.get(p.positionId)?.riskToStop;
        if (r === null || r === undefined) complete = false;
        else open = open.plus(r);
      }
      const after = open.plus(d.sizing.value.dollarRisk);
      const cap = dec(d.accountState.value.equity).mul(g.maxOpenRiskPercent).div(100);
      details[`group:${g.id}`] = {
        positionsAfter: inGroup.length + 1,
        openRiskAfter: toNum(after, 2),
        cap: toNum(cap, 2),
      };
      if (!complete) unknowns.push(`open risk of the ${g.id} group unknown`);
      if (inGroup.length + 1 > g.maxOpenPositions)
        reasons.push(
          `${g.id}: ${inGroup.length} correlated position(s) open or working (max ${g.maxOpenPositions})`,
        );
      if (after.gt(cap))
        reasons.push(
          `${g.id}: correlated open risk would be ${toNum(after, 2)} > ${g.maxOpenRiskPercent}% of equity (${toNum(cap, 2)})`,
        );
    }

    if (reasons.length > 0) return fail([...reasons, ...unknowns], details);
    if (unknowns.length > 0) return unknown(unknowns.join('; '), details);
    return pass('strategy limits hold', details);
  },
};
