# ADR-0002: PostgreSQL with plain SQL, checksum-verified migrations

**Status:** Accepted · **Date:** 2026-09-27

## Context

The system needs durable, relational, auditable storage (spec §47, §54). Options considered:
Drizzle ORM (1.0 still in release-candidate with breaking changes), Kysely, Prisma, or plain SQL.

## Decision

PostgreSQL 16 with the `postgres` driver, hand-written SQL migrations, and a small in-house
runner that (a) applies files in order inside transactions, (b) stores each file's SHA-256 and
refuses to run if an applied migration changed, (c) holds an advisory lock so two instances
cannot migrate concurrently. Repositories contain explicit SQL and validate rows with Zod.

## Consequences

- - Schema is fully transparent and reviewable; no ORM migration churn.
- - Database-level guarantees (unique constraints for duplicate-order protection, triggers that
    make the audit log append-only) are first-class.
- − Less compile-time checking of SQL → compensated by integration tests against real Postgres.
