# Architecture Decision Records

Each ADR records one decision with meaningful trade-offs: context, decision, consequences.
ADRs are immutable once accepted; a changed decision gets a new ADR that supersedes the old one.

| #                                                | Title                                                         | Status   |
| ------------------------------------------------ | ------------------------------------------------------------- | -------- |
| [0001](0001-typescript-modular-monolith.md)      | TypeScript modular monolith in a pnpm workspace               | Accepted |
| [0002](0002-postgres-plain-sql-migrations.md)    | PostgreSQL with plain SQL, checksum-verified migrations       | Accepted |
| [0003](0003-fail-closed-decision-gate.md)        | Fail-closed decision gate over frozen snapshots               | Accepted |
| [0004](0004-decimal-arithmetic-for-risk.md)      | Decimal arithmetic for risk-critical math                     | Accepted |
| [0005](0005-n8n-orchestrates-core-decides.md)    | n8n orchestrates, ASTRA Core decides                          | Accepted |
| [0006](0006-configuration-as-versioned-files.md) | Rules, strategies and accounts as versioned config files      | Accepted |
| [0007](0007-one-topology-local-and-cloud.md)     | One docker-compose topology for local and cloud               | Accepted |
| [0008](0008-live-trading-authorization.md)       | Multi-factor live-trading authorization                       | Accepted |
| [0009](0009-market-data-architecture.md)         | Market data: one ingestion service, quote-built bars          | Accepted |
| [0010](0010-market-structure-definitions.md)     | Market structure: deterministic definitions, no lookahead     | Accepted |
| [0011](0011-economic-calendar-provider-port.md)  | Economic calendar: pulled provider port, shared blackout rule | Accepted |
| [0012](0012-position-monitor.md)                 | Position monitor: observe and warn, trailing path risk        | Accepted |
| [0013](0013-gate-prices-trailing-path.md)        | The gate prices the trailing intraday-equity path             | Accepted |
| [0014](0014-automatic-protective-closing.md)     | Automatic protective closing                                  | Accepted |
| [0015](0015-trade-journal.md)                    | Trade journal: append-only, plan vs actual                    | Accepted |
| [0016](0016-backtesting.md)                      | Backtesting: real gate, pessimistic fills, honest labels      | Accepted |
| [0017](0017-losing-streak-per-trading-day.md)    | The losing-streak limit counts within one trading day         | Accepted |
| [0018](0018-learning-metrics.md)                 | Learning metrics: descriptive, sample-size honest             | Accepted |
| [0019](0019-news-intelligence.md)                | News intelligence: rules classifier, news risk in the gate    | Accepted |
| [0020](0020-ai-analysis-layer.md)                | AI analysis layer: orchestrator, budgets, veto-only input     | Accepted |
| [0021](0021-n8n-workflows.md)                    | n8n workflows: generated from tested code; ASTRA computes     | Accepted |
| [0022](0022-account-currency-valuation.md)       | Account-currency valuation of instruments (FX pairs)          | Accepted |
