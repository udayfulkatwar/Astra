import type { DecisionConfigView } from '@astra/decision';
import type { AstraConfig } from './loader';

/** Read-only view of the loaded configuration for the decision assembler. */
export function decisionConfigView(config: AstraConfig): DecisionConfigView {
  return {
    configHash: config.hash,
    policy: config.system.decision,
    account: (id) => config.accounts.get(id),
    profile: (id) => config.profiles.get(id),
    riskPolicy: (id) => config.riskPolicies.get(id),
    strategy: (id) => config.strategies.get(id),
    instrument: (symbol) => config.instruments.get(symbol),
  };
}
