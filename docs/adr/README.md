# Architecture Decision Records

Each ADR records one decision with meaningful trade-offs: context, decision, consequences.
ADRs are immutable once accepted; a changed decision gets a new ADR that supersedes the old one.

| #                                                | Title                                                     | Status   |
| ------------------------------------------------ | --------------------------------------------------------- | -------- |
| [0001](0001-typescript-modular-monolith.md)      | TypeScript modular monolith in a pnpm workspace           | Accepted |
| [0002](0002-postgres-plain-sql-migrations.md)    | PostgreSQL with plain SQL, checksum-verified migrations   | Accepted |
| [0003](0003-fail-closed-decision-gate.md)        | Fail-closed decision gate over frozen snapshots           | Accepted |
| [0004](0004-decimal-arithmetic-for-risk.md)      | Decimal arithmetic for risk-critical math                 | Accepted |
| [0005](0005-n8n-orchestrates-core-decides.md)    | n8n orchestrates, ASTRA Core decides                      | Accepted |
| [0006](0006-configuration-as-versioned-files.md) | Rules, strategies and accounts as versioned config files  | Accepted |
| [0007](0007-one-topology-local-and-cloud.md)     | One docker-compose topology for local and cloud           | Accepted |
| [0008](0008-live-trading-authorization.md)       | Multi-factor live-trading authorization                   | Accepted |
| [0009](0009-market-data-architecture.md)         | Market data: one ingestion service, quote-built bars      | Accepted |
| [0010](0010-market-structure-definitions.md)     | Market structure: deterministic definitions, no lookahead | Accepted |
