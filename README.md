# ASTRA — Autonomous Strategic Trading & Risk Agent

An AI-orchestrated, **prop-firm-first trading operating system**. ASTRA's governing rule:

> **Account survival has priority over trade opportunity.** The default state is **NO TRADE**.
> A trade happens only after every mandatory layer explicitly passes; anything UNKNOWN, STALE,
> ERROR, TIMEOUT, INVALID or UNAVAILABLE blocks it.

```text
DATA → CONTEXT → SIGNAL → AI ANALYSIS → RISK → PROP-FIRM → EXECUTION GATE → EXECUTE → MONITOR → REVIEW
```

AI and automation can analyse, propose and orchestrate. **Deterministic code** owns risk,
position sizing, prop-firm rules, kill switches and execution permission. There is no path from
an AI response to an order.

## Status

Foundation and deterministic safety core are built and tested (269 tests, incl. property-based
risk invariants and integration tests against PostgreSQL). Paper trading works end to end.
See **[docs/PROJECT_STATE.md](docs/PROJECT_STATE.md)** for what exists, what's next and what
input is needed from the owner. **Live trading is not enabled** and requires explicit owner
authorization (ADR-0008).

## Quick start (paper sandbox)

```sh
corepack enable && pnpm install
cp .env.example .env            # set DATABASE_URL and the three tokens (openssl rand -hex 32)
ASTRA_SIMULATION=true pnpm dev  # API :8080 + dashboard :5173 (simulated feeds, paper only)
```

Or the full stack (Postgres, API, dashboard, n8n): `docker compose up -d --build` —
see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repository

| Path                 | Purpose                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `packages/core`      | Domain primitives: `Observed<T>`, modes, health, time, decimal math, schemas    |
| `packages/prop-firm` | Rule profiles, account state engine, `canTrade` rule engine                     |
| `packages/risk`      | Capital preservation engine: sizing, policy limits, account health              |
| `packages/safety`    | Kill switches, health registry, halt conditions                                 |
| `packages/decision`  | Fail-closed gate pipeline and decision records                                  |
| `packages/execution` | Broker adapter interface, paper broker, execution gateway                       |
| `packages/db`        | SQL migrations, hash-chained audit log, repositories                            |
| `packages/config`    | Versioned YAML configuration loader                                             |
| `apps/api`           | ASTRA Core service (Fastify) — composition root                                 |
| `apps/dashboard`     | Operator command center (React)                                                 |
| `config/`            | Rule profiles, risk policies, instruments, strategies, accounts (**templates**) |
| `automation/n8n`     | n8n workflows                                                                   |
| `docs/`              | Architecture, ADRs, deployment, project state                                   |

## Development

```sh
pnpm check        # format check, lint, typecheck, all tests
pnpm test         # tests (DB tests use TEST_DATABASE_URL or a local Postgres; skipped if absent)
pnpm build        # API bundle + dashboard
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [ADRs](docs/adr/README.md) · [Deployment & runbook](docs/DEPLOYMENT.md)
- [Configuration](config/README.md) · [n8n workflows](automation/n8n/README.md) · [Project state](docs/PROJECT_STATE.md)
