# ADR-0020: AI analysis layer — orchestrator, budgets, a veto-only gate input

**Status:** Accepted · **Date:** 2026-09-28

## Context

ARCHITECTURE §8 reserved a Phase 6 AI orchestrator: models give CONTEXT (a second opinion on a
signal, a review of a closed trade); deterministic code keeps risk, sizing, limits, kill switches
and execution permission. The gate has had an `ai.analysis` check since Phase 1 (a strategy with
`requiresAiAnalysis: true` needs a valid, fresh, non-conflicting analysis) with nothing behind it.
The dangers: a model that approves trades, invents data, silently "repairs" bad output, runs up
cost, or blocks the decision path; and a demo that passes rules off as AI.

## Decision

- **`@astra/ai`** (isomorphic core; the Anthropic adapter only in the `./anthropic` subpath):
  - `AiProvider` port (`id`, `kind`: LIVE for a real model, SIMULATED for the stand-in).
  - Routing is config: task → provider / model / effort / max output / timeout.
  - `AiOrchestrator.run(task, brief)`, safety rails in order:
    - kill switch (`AI` scope; counted as active until kill switches are loaded);
    - `enabled`; provider present; a price for the model (else the budget can't be enforced);
    - daily call limit, and the **worst-case** cost of the call (prompt size + max output at list
      price) against the daily cost limit (UTC day, in-flight calls reserved);
    - hard timeout with abort — a timed-out call is charged at its worst case;
    - JSON parse + Zod validation.
  - Outcomes, and what the gate sees:
    - Malformed or truncated output → INVALID, never repaired.
    - A refusal → UNAVAILABLE.
    - A blocked call → UNAVAILABLE.
    - Timeout → TIMEOUT; provider error → ERROR.
  - Every attempt, sent or blocked, is a call-log row: tokens, cost, latency, status, whether a
    fallback model answered.
  - Health: DEGRADED from 80% of either limit, after a failed call, or with the kill switch on.
- **Tasks:**
  - TRADE_ANALYSIS: the brief holds only what ASTRA observed — the signal, price distances,
    structure summary, recent complete bars, news risk / provider sentiment / headlines, and the
    calendar events for the instrument. Each section carries its status; missing data is labelled,
    never filled. It holds no balance, drawdown or size. Output: verdict, confidence, setup
    quality, event risk, reasons, invalidation → core `AiAnalysis`.
  - POST_TRADE_REVIEW: from the journal entry, the gate's checks and the pre-trade analysis.
    - GOOD / POOR is judged on process; the outcome (WIN / LOSS / BREAKEVEN) comes from the
      journal, never from the model.
    - Suggested changes are stored as PROPOSED for a human and never applied.
  - The stable task instructions are prompt-cached.
- **Anthropic adapter:**
  - `claude-opus-5` by default; structured output via `output_config.format` (from the task's
    Zod schema); `effort` from the route.
  - Server-side refusal fallback on by default: `fallbacks: "default"` under beta
    `server-side-fallback-2026-07-01`. A declined request is re-run on Anthropic's recommended
    fallback model; the call log records when that happened.
  - `stop_reason` is checked before content: `refusal` → REFUSED; `max_tokens` → TRUNCATED.
  - The API key comes only from the environment variable NAMED in config, read at the entry
    point; it is never stored, logged or sent to the dashboard. Without it, no provider exists
    → UNAVAILABLE.
- **Gate flow (two phases).** For a strategy that requires AI:
  - The deterministic checks run first. When any of them already rejects, the model is not asked
    and the decision records "not requested".
  - Otherwise the analysis runs — at most once per exact signal (id, direction, levels);
    concurrent requests share it; a fresh one is reused.
  - The decision is then assembled again, so quotes, account and news are judged at the moment of
    decision, and the gate reads the stored analysis.
  - This keeps model latency out of the 3 s data-provider timeout and spends nothing on
    candidates that fail anyway.
  - The unchanged `ai.analysis` check vetoes on CONFLICTS, confidence < `minConfidence` (0.6),
    or event risk HIGH.
  - SIMULATED analyses are refused in SHADOW/LIVE by the data-kind check.
- **Stand-in:** `SimulatedAiProvider` — fixed rules over the same brief:
  - trend and last break vs direction, reward-to-risk;
  - events within the hour or HIGH news → event risk HIGH.
  - Every answer says "SIMULATED stand-in (fixed rules, not an AI model)".
  - Available only in simulation mode, when `ai.standInWhenSimulating` is set (the repo default).
- **Storage** (migration 0007, append-only):
  - `ai_model_calls`;
  - `ai_analyses`, with the exact brief the model saw;
  - `ai_reviews`.
  - Today's spend is restored after a restart.
- **API:**
  - `GET /api/v1/ai/status`, `GET /api/v1/ai/calls`.
  - `POST /api/v1/ai/analyses` (automation); `GET /api/v1/ai/analyses[/:id]`.
  - `POST /api/v1/ai/reviews` (operator); `GET /api/v1/ai/reviews`.
  - Automatic reviews of new journal entries only when `postTradeReview.auto` is set (default off).
- **Template strategy** `paper-ai-test` (`requiresAiAnalysis: true`) on paper-demo exercises the
  veto in PAPER.
- **Dashboard:** the AI Model Monitor page shows status, the budget bar, routes, analyses with their
  gate effect, reviews (with a review button) and the call log. The demo runs the real orchestrator
  on the stand-in.

## Consequences

- \+ AI can only make ASTRA more cautious. A strategy that requires it takes no trade while the key,
  budget, provider or model answer is missing or bad.
- \+ Cost is bounded per day by deterministic code, and every cent is attributable to a call.
- \+ Models are swapped in config. Another provider is one adapter.
- − The budget reservation is an estimate (characters / 3 for input tokens), set to be pessimistic.
  List prices in `ai.prices` must be verified by the owner; a fallback model needs its own price
  (claude-opus-4-8 is listed).
- − Owner inputs are needed before real use: an Anthropic API key (env var), the daily budget, and
  whether each real strategy requires AI analysis.
