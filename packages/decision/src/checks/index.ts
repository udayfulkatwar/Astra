import type { GateCheck } from './check';
import { aiAnalysis, calendarEventBlackout, newsRisk } from './context';
import { dataAccount, dataQuote, dataSourceKinds } from './data';
import {
  executionLiveAuthorization,
  executionReadiness,
  positionDuplicates,
  propFirmConfigVerification,
  propFirmRules,
  riskCapitalPreservation,
} from './gates';
import { marketEntry, marketSession, marketSpread } from './market';
import { strategyEligibility, strategyLevels, strategySignal } from './strategy';
import { systemComponentHealth, systemKillSwitches, systemMode } from './system';

export * from './check';
export { mergedBlackout } from './context';

/** The standard ordered check set covering every gate layer. */
export const STANDARD_CHECKS: readonly GateCheck[] = [
  systemMode,
  systemKillSwitches,
  systemComponentHealth,
  dataQuote,
  dataAccount,
  dataSourceKinds,
  marketSession,
  marketSpread,
  marketEntry,
  strategyEligibility,
  strategySignal,
  strategyLevels,
  newsRisk,
  calendarEventBlackout,
  aiAnalysis,
  riskCapitalPreservation,
  propFirmRules,
  propFirmConfigVerification,
  positionDuplicates,
  executionReadiness,
  executionLiveAuthorization,
];
