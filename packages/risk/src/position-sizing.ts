/**
 * Position sizing (spec §23). Deterministic and exact:
 *
 *   allowed risk = min(equity × risk%, cash cap, firm per-trade cap,
 *                      share of worst-case daily buffer, share of worst-case drawdown buffer,
 *                      open-risk capacity) × health multiplier
 *   quantity     = floor(allowed risk / risk per unit, step), clamped by quantity caps
 *
 * The smallest applicable limit always wins; quantities are never rounded up; a size below the
 * minimum tradable quantity is a rejection, never a round-up.
 */
import {
  ZERO,
  ceilToStep,
  dec,
  decMin,
  directionSign,
  floorToStep,
  toNum,
  type Dec,
  type Direction,
  type InstrumentSpec,
} from '@astra/core';
import type { AccountState, QuantityHeadroom } from '@astra/prop-firm';
import type { RiskPolicy } from './policy';

export interface SizingConstraint {
  readonly name: string;
  readonly kind: 'RISK_AMOUNT' | 'QUANTITY';
  readonly value: number;
}

export interface PositionSizingInput {
  readonly instrument: InstrumentSpec;
  readonly accountCurrency: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stop: number;
  readonly state: AccountState;
  readonly policy: RiskPolicy;
  /** Strategy cap on risk % per trade, if any. */
  readonly strategyMaxRiskPercent: number | null;
  /** From account health: 1 SAFE, policy multiplier in CAUTION, 0 otherwise. */
  readonly healthMultiplier: number;
  /** Firm per-trade risk cap resolved to an amount, if any. */
  readonly firmMaxRiskPerTrade: number | null;
  /** Firm quantity headroom from the prop-firm engine. */
  readonly firmHeadroom: QuantityHeadroom;
}

export interface PositionSizingOk {
  readonly ok: true;
  readonly quantity: number;
  /** Quantity the risk budget alone would allow. */
  readonly recommendedQuantity: number;
  /** Quantity the hard quantity caps allow (null = uncapped). */
  readonly maxAllowedQuantity: number | null;
  readonly stopDistanceTicks: number;
  readonly riskPerUnit: number;
  /** Worst-case loss of the sized trade incl. cost allowances. */
  readonly dollarRisk: number;
  readonly riskPctOfEquity: number;
  readonly allowedRisk: number;
  readonly bindingConstraint: string;
  readonly constraints: readonly SizingConstraint[];
}

export interface PositionSizingRejected {
  readonly ok: false;
  readonly reason: string;
  readonly constraints: readonly SizingConstraint[];
}

export type PositionSizing = PositionSizingOk | PositionSizingRejected;

function reject(reason: string, constraints: SizingConstraint[] = []): PositionSizingRejected {
  return { ok: false, reason, constraints };
}

/** Worst-case loss per unit of quantity: stop distance (whole ticks, rounded up) + costs. */
export function riskPerUnit(
  instrument: InstrumentSpec,
  entry: number,
  stop: number,
): { perUnit: Dec; ticks: Dec } {
  const tick = dec(instrument.tickSize);
  const ticks = ceilToStep(dec(entry).minus(stop).abs(), tick).div(tick);
  const perUnit = ticks
    .plus(instrument.costs.slippageAllowanceTicks)
    .mul(instrument.tickValue)
    .plus(instrument.costs.commissionPerUnitRoundTurn);
  return { perUnit, ticks };
}

export function calculatePositionSize(input: PositionSizingInput): PositionSizing {
  const { instrument, state, policy } = input;

  if (instrument.quoteCurrency !== input.accountCurrency) {
    return reject(
      `instrument quote currency ${instrument.quoteCurrency} differs from account currency ${input.accountCurrency}; conversion not supported`,
    );
  }
  if (dec(input.entry).minus(input.stop).mul(directionSign(input.direction)).lte(0)) {
    return reject('stop must be below entry for LONG and above entry for SHORT');
  }
  if (!state.openRisk.complete) return reject('open risk unknown; cannot size a new position');
  if (!input.firmHeadroom.complete) return reject('firm position limits cannot be verified');
  if (input.healthMultiplier <= 0) return reject('account health does not allow new risk');
  if (state.equity <= 0) return reject('equity is not positive');

  const { perUnit, ticks } = riskPerUnit(instrument, input.entry, input.stop);
  const equityBase = decMin(dec(state.equity), dec(state.balance));
  const riskPct = decMin(
    dec(policy.perTrade.riskPercentOfEquity),
    ...(input.strategyMaxRiskPercent !== null ? [dec(input.strategyMaxRiskPercent)] : []),
  );
  const survival = dec(policy.buffers.survivalBufferAmount);

  const amounts: { name: string; value: Dec }[] = [
    { name: 'risk-percent-of-equity', value: equityBase.mul(riskPct).div(100) },
  ];
  if (policy.perTrade.maxRiskAmount !== null) {
    amounts.push({ name: 'policy-max-risk-amount', value: dec(policy.perTrade.maxRiskAmount) });
  }
  if (input.firmMaxRiskPerTrade !== null) {
    amounts.push({ name: 'firm-max-risk-per-trade', value: dec(input.firmMaxRiskPerTrade) });
  }
  if (state.dailyLoss) {
    const room = dec(state.dailyLoss.worstCaseRemaining ?? 0).minus(survival);
    amounts.push({
      name: 'daily-loss-buffer',
      value: room.mul(policy.buffers.maxDailyBufferUsePct).div(100),
    });
  }
  const ddRoom = dec(state.drawdown.worstCaseRemaining ?? 0).minus(survival);
  amounts.push({
    name: 'drawdown-buffer',
    value: ddRoom.mul(policy.buffers.maxDrawdownBufferUsePct).div(100),
  });
  amounts.push({
    name: 'open-risk-capacity',
    value: dec(state.equity)
      .mul(policy.exposure.maxOpenRiskPercentOfEquity)
      .div(100)
      .minus(state.openRisk.amount),
  });

  const constraints: SizingConstraint[] = amounts.map((a) => ({
    name: a.name,
    kind: 'RISK_AMOUNT',
    value: toNum(a.value, 2),
  }));

  const bindingAmount = amounts.reduce((m, a) => (a.value.lt(m.value) ? a : m));
  const allowedRisk = bindingAmount.value.mul(input.healthMultiplier);
  if (allowedRisk.lte(0)) {
    return reject(`no risk budget available (binding: ${bindingAmount.name})`, constraints);
  }

  const step = dec(instrument.quantityStep);
  const recommended = floorToStep(allowedRisk.div(perUnit), step);

  const caps: { name: string; qty: Dec }[] = [];
  if (instrument.maxQuantity !== undefined)
    caps.push({ name: 'instrument-max-quantity', qty: dec(instrument.maxQuantity) });
  if (input.firmHeadroom.maxQuantity !== null) {
    caps.push({
      name: `firm-${input.firmHeadroom.bindingRule ?? 'quantity-limit'}`,
      qty: dec(input.firmHeadroom.maxQuantity),
    });
  }
  for (const c of caps) constraints.push({ name: c.name, kind: 'QUANTITY', value: toNum(c.qty) });

  const bindingCap = caps.length > 0 ? caps.reduce((m, c) => (c.qty.lt(m.qty) ? c : m)) : null;
  const maxAllowed = bindingCap ? floorToStep(clampNonNegative(bindingCap.qty), step) : null;

  let quantity = recommended;
  let binding = bindingAmount.name;
  if (maxAllowed !== null && maxAllowed.lt(recommended)) {
    quantity = maxAllowed;
    binding = bindingCap!.name;
  }

  if (quantity.lt(instrument.minQuantity)) {
    return reject(
      `position size ${toNum(quantity)} below minimum tradable quantity ${instrument.minQuantity} (binding: ${binding})`,
      constraints,
    );
  }

  const dollarRisk = quantity.mul(perUnit);
  return {
    ok: true,
    quantity: toNum(quantity),
    recommendedQuantity: toNum(recommended),
    maxAllowedQuantity: maxAllowed ? toNum(maxAllowed) : null,
    stopDistanceTicks: toNum(ticks),
    riskPerUnit: toNum(perUnit),
    dollarRisk: toNum(dollarRisk),
    riskPctOfEquity: toNum(dollarRisk.div(state.equity).mul(100), 4),
    allowedRisk: toNum(allowedRisk, 2),
    bindingConstraint: binding,
    constraints,
  };
}

/** Negative caps mean "no room": clamp to zero before flooring. */
function clampNonNegative(v: Dec): Dec {
  return v.lt(0) ? ZERO : v;
}
