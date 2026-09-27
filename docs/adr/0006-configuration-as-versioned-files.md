# ADR-0006: Rules, strategies and accounts as versioned configuration files

**Status:** Accepted · **Date:** 2026-09-27

## Context

Prop-firm rules, risk policies, instruments and strategies must be configurable, never hard-coded
(§13, §23), and changes to live risk parameters must pass a controlled review process (§32).

## Decision

- Definitions live as YAML under `config/`, validated by Zod at startup. Invalid config → the
  service refuses to start.
- Secrets are never in these files; they reference environment variable _names_.
- The canonical JSON of the loaded config is hashed (SHA-256), stored in `config_versions`, and
  stamped on every decision.
- Profiles and instrument specs carry `verification.status`; `UNVERIFIED` items are allowed in
  BACKTEST/PAPER/SHADOW only.
- Runtime state (balances, kill switches, decisions, orders) lives in the database, not in config.

## Consequences

- - Git history is the audit trail and review process for rule changes (pull requests).
- - Any decision can be traced to the exact rules that were active.
- − Changing config requires a restart/reload; a UI editor with review workflow is future work.
