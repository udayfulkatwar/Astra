/** Maps every status vocabulary in ASTRA to a visual tone. Unknown values are never "good". */
export type Tone = 'ok' | 'warn' | 'restricted' | 'bad' | 'unknown' | 'info' | 'shadow' | 'live';

const TONES: Record<string, Tone> = {
  ONLINE: 'ok',
  SAFE: 'ok',
  APPROVED: 'ok',
  PASS: 'ok',
  ENABLED: 'ok',
  FILLED: 'ok',
  CONFIRMED: 'ok',
  NORMAL: 'ok',
  USER_VERIFIED: 'ok',
  USER: 'ok',
  CONSUMED: 'info',
  DEGRADED: 'warn',
  CAUTION: 'warn',
  WARN: 'warn',
  PENDING: 'warn',
  PARTIALLY_FILLED: 'warn',
  RESTRICTED: 'restricted',
  ELEVATED: 'restricted',
  ERROR: 'bad',
  CRITICAL: 'bad',
  HALTED: 'bad',
  BREACH_RISK: 'bad',
  FAIL: 'bad',
  REJECTED: 'bad',
  DISABLED: 'bad',
  HIGH: 'bad',
  UNKNOWN: 'unknown',
  UNAVAILABLE: 'unknown',
  STALE: 'unknown',
  TIMEOUT: 'unknown',
  INVALID: 'unknown',
  EXPIRED: 'unknown',
  UNVERIFIED: 'restricted',
  TEMPLATE: 'restricted',
  INFO: 'info',
  PAPER: 'info',
  BACKTEST: 'info',
  SHADOW: 'shadow',
  SHADOW_RECORDED: 'shadow',
  LIVE: 'live',
};

export function toneOf(status: string | null | undefined): Tone {
  return (status && TONES[status]) || 'unknown';
}
