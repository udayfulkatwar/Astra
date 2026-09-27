# ADR-0007: One docker-compose topology for local and cloud

**Status:** Accepted · **Date:** 2026-09-27

## Context

The spec requires first-class local (Windows/Linux) and cloud support without a rewrite (§17, §80).

## Decision

A single `docker-compose.yml` (postgres, api, dashboard, n8n) is the unit of deployment for both
targets. Differences are environment variables, mounted config, and (in cloud) a TLS reverse
proxy in front. Nothing in the code depends on where it runs; all timestamps are UTC.

## Consequences

- - Local == cloud; bugs reproduce locally.
- - Simple, cheap single-VM cloud deployment to start.
- − Horizontal scaling needs more (managed DB, orchestration) — deferred until justified.
