# ASTRA configuration

Version-controlled definitions (ADR-0006). Validated at startup — invalid config stops the service.

| Directory             | Contents                                                | Verification before LIVE             |
| --------------------- | ------------------------------------------------------- | ------------------------------------ |
| `astra.yaml`          | system parameters (freshness, timeouts, health)         | —                                    |
| `prop-firm-profiles/` | one file per rule profile, `id` = file name             | `verification.status: USER_VERIFIED` |
| `risk-policies/`      | your internal risk limits                               | `ownership: USER`                    |
| `instruments/`        | contract specs + cost assumptions, `symbol` = file name | `verification.status: USER_VERIFIED` |
| `strategies/`         | strategy modules                                        | `ownership: USER`                    |
| `accounts/`           | accounts → profile, policy, strategies, broker adapter  | `liveTradingAuthorized: true`        |

**Everything shipped here is a TEMPLATE.** No real firm's rules, broker contract sizes or your
personal strategy were invented. Replace values with verified facts, then mark them verified.

**Secrets never go here.** Reference environment variable _names_ (e.g. `credentialsEnv:
BROKER_ACCOUNT_A_TOKEN`). The loader rejects values under keys that look like secrets.

Every loaded configuration is hashed; each decision records the hash of the config in force.
