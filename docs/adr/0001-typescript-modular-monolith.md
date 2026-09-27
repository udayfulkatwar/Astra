# ADR-0001: TypeScript modular monolith in a pnpm workspace

**Status:** Accepted · **Date:** 2026-09-27

## Context

ASTRA spans risk math, rule engines, execution, a web dashboard and automation contracts. The
spec requires modularity, strong typing, replaceable components, and explicitly warns against
premature microservices (§24).

## Decision

- One language (TypeScript, strict) across backend, frontend and shared contracts.
- One deployable core service ("modular monolith"); each department of the spec is a workspace
  package with a one-way dependency graph (see ARCHITECTURE §3).
- Internal packages export TypeScript source directly (no per-package build). The API is bundled
  with tsup for production; the dashboard is bundled by Vite; tests run on source via Vitest.

## Consequences

- - Type-safe contracts end-to-end; refactors are checked by the compiler.
- - Pure domain packages are trivially unit-testable; boundaries allow later extraction.
- - Minimal operational surface (one core process) for a single owner.
- − A crash of the core process stops everything → mitigated by fail-closed startup, container
  restart policy, and external uptime monitoring.
