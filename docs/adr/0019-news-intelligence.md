# ADR-0019: News intelligence — provider port, deterministic classification, news risk in the gate

**Status:** Accepted · **Date:** 2026-09-28

## Context

Spec §15–§19 ask ASTRA to monitor financial news, classify it (category, impact, affected
instruments, sentiment) and use it as CONTEXT: news may restrict a trade, never create one
(unless a strategy is explicitly news-driven). The gate has had a `news.risk` check since
Phase 1, with `decision.news.required: false` until an engine existed. Two dangers shape the
design: inventing news or its meaning, and treating "no news received" as "no news".

## Decision

- **Pure `@astra/news`** (isomorphic), shaped like the calendar engine (ADR-0011):
  - `NewsItem` DATA schema (headline, publisher, time, provider tags for countries, currencies
    and symbols, optional provider impact and sentiment) — nothing absent is guessed.
  - `classifyNews`: deterministic rules (`rules-v1`, ASTRA DEFAULTS) for 13 categories and
    HIGH / MEDIUM / LOW impact; impact = max(provider rating, rules), raised one level by
    "breaking / emergency / surprise …"; the rules that fired are kept on every item.
  - Instrument relevance: provider symbol tags, the instrument's `eventCurrencies` (from tagged
    currencies, countries and country names), and `news.instrumentKeywords`; an instrument without
    configured currencies is affected by any currency (fail-safe), and a HIGH-impact item with no
    determinable relevance affects every instrument.
  - Sentiment is **only the provider's** (VERY_BULLISH … VERY_BEARISH with confidence); ASTRA does
    not infer it from words. The per-instrument summary (recency- and impact-weighted, momentum,
    confidence reduced below 5 items) is UNKNOWN without provider sentiment. AI classification
    (Phase 6) may add to the rules but never lower an impact.
  - `NewsService`: per-item validation (bad items rejected and reported, the rest kept),
    de-duplication by id and by syndicated headline, retention, one data kind per source, and the
    per-instrument **news risk**: HIGH for `highImpactMinutes` (30) after a HIGH-impact item,
    ELEVATED for `mediumImpactMinutes` (15) after a MEDIUM one, else NORMAL — with reasons, item
    ids and `clearsAt`.
  - Freshness is the **feed's**: a feed that has not delivered (an empty batch counts) within
    `newsMaxAgeMs` (15 min) is STALE → the gate sees news risk as unknown → no new trades. The
    assessment carries the least trustworthy data kind among active sources.
  - `NewsPoller` (timeout, never overlaps) and a deterministic `SimulatedNewsAdapter` whose items
    are all prefixed "SIMULATED —".
- **Gate:** `decision.news.required: true`; `news.blockLevels: [HIGH]`. SIMULATED news is refused
  in SHADOW/LIVE by the existing data-kind check; pushed news (n8n) is MANUAL (PAPER only).
- **Core service:** items stored in `news_items` (migration 0006, inserted once) and restored after a
  restart (the feed is fresh only after a new delivery); HIGH-impact items for traded instruments
  raise a WARN event; NEWS health from feed freshness; `POST /api/v1/news/items` (automation),
  `GET /api/v1/news`, `GET /api/v1/news/context` (news risk, sentiment, calendar blackout and the
  combined context per instrument). SIMULATED feed in simulation mode; real providers are added
  once the owner chooses one.
- **Backtests:** an explicit `news` choice — `SIMULATED_FEED` (items published up to each decision
  only) or `NOT_MODELLED` (no news risk, loud warning). No silent default.
- **Dashboard:** News Intelligence page (feed, context by instrument, filtered headlines with the
  reasons for every classification); demo "Breaking news" button.

## Consequences

- - Trades are held back around high-impact news for the instruments it concerns, and nothing is
    approved without a live news feed — fail-closed, as for the calendar.
- - Every classification is explainable (rules listed per item) and reproducible.
- − Keyword rules are coarse: they will misclassify some headlines (both ways); impact only ever
  rounds up, so the error is towards blocking. Owner review of the rules and keywords is needed.
- − Paper trading without simulation now needs a news source (a provider, or n8n pushing at least
  every 15 minutes). Sentiment stays unknown until a provider supplies it (or Phase 6 AI).
- − News-driven strategies, and the spec §57 actions beyond "no new trades" (reduce size, close,
  halt), are not implemented yet.
