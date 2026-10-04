# P001 — Stage 2 firm / platform compatibility and data-readiness audit

**Status: PASS (audit scope only).** Initial head `206c9461` was superseded after CEO review; accepted head
`04091354e0354d417c8a472750d718627a06e487` (Markdown only; format and consistency checks only). This is an
evidence/inventory audit — NOT a verified firm profile, a selected account or API route, proven
compliance, real-adapter readiness or Stage 2 completion.

Branch `claude/p001-platform-readiness` (from accepted Stage 1 head `b9c3b890`). Documentation only: no
adapter, strategy, data purchase, credential, paid call, account or provider was created or activated,
and no safety gate or schema was changed. Live trading stays DISABLED; no strategy is promoted; **no
profile is VERIFIED; no account, route, fee or contract is selected.**

## 1. Evidence tiers (read first)

Access dates: Claude searches **2026-10-04 UTC**; CEO primary reads **2026-10-04 UTC / 2026-10-05
Asia/Kolkata** (same reading window).

| Tier                     | Meaning                                                                                                                                                    | Use                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **P** — CEO primary read | Page text read by the CEO through the CEO search service; short paraphrases recorded here with the official URL. I (Claude) did **not** fetch these pages. | Current published facts, still subject to the owner's actual account terms |
| **L** — Claude lead      | An official-domain URL plus a search-tool paraphrase surfaced by my restricted search, wording not read                                                    | **Unverified lead only**, never a current fact                             |
| **T** — third party      | Aggregator/review pages                                                                                                                                    | Never a fact; listed only where they conflict                              |

Environment note: my direct fetches of the official domains returned `EGRESS_BLOCKED`
(`lucidtrading.com`, `fundingpips.com`, `help.fundingpips.com`, `cmegroup.com`, `www.metatrader5.com`,
`help.ctrader.com`; `help.lucidtrading.com` did not resolve). That is an observation about the Claude
environment, not proof the sources are unavailable. The founder's named programs (Lucid Flex 25K,
FundingPips 10K two-step Flex; US30 / NAS100 / XAUUSD intraday) are **intended targets, not confirmation
of a purchased program, platform, current terms or permissions.** Public text below never overrides the
purchased account's own dashboard/agreement.

## 2. Published facts

### FundingPips — 2 Step Flex (CFD/forex firm; instruments are broker CFDs)

**P** https://help.fundingpips.com/hc/en-us/articles/47835196271249-2-Step-Flex :

- Phase 1 / Phase 2 profit targets **10% / 8%**. This current primary text resolves the earlier public
  conflict (a third-party page said 6%) in favour of 8%; **legacy or earlier-purchased accounts may
  carry other terms — owner-specific, unconfirmed.**
- Daily loss 4% measured from the **higher of opening balance/equity**; daily reset **00:00 platform time
  (UTC+3)**. Maximum loss **static 12% of the initial balance**; touching the floor by balance OR equity
  breaches.
- **Evaluation phases permit overnight/weekend holding; the MASTER account auto-closes positions unless
  the Swing add-on applies.** (An earlier draft of this audit wrongly said 2 Step Flex closes weekends
  generally.)
- Minimum-trading-day rules depend on purchase/reset dates and the chosen reward split. Reward options
  differ (e.g. a monthly 100% option with 35% consistency, 7 profitable days and a 1% trade-idea
  "striking" rule): **do not generalize one split to all accounts.**
- News rules differ by phase; Master: ±5-minute event window, speeches from 10 minutes before to 10
  minutes after the END of the speech; an exception when the position was opened ≥5 hours before the
  event. The page also states intentional news trading is prohibited even though evaluation holding and
  management are allowed.

**P** https://help.fundingpips.com/hc/en-us/articles/34505029138449-Trading-Conduct-and-Security-Standards :

- Accessing the trading account through a **VPN/VPS is forbidden**.
- Full automation with the owner's own EA requires proof assessed by the firm's team; third-party
  automation is restricted; inbound external copy trading and third-party account management are
  forbidden.
- This public wording does **not** settle whether ASTRA — externally built, owner-operated software
  using an API — is accepted. That is a firm/account-specific confirmation gap (no message was sent).

**L (unverified leads only):** sizes $5K–$100K and platform names (MT5, cTrader, Match-Trader), "US
residents cannot use cTrader; MT5 not supported for the US", 41 instruments with indices shown as
DJI30/NDX100 and XAUUSD, and a "News Trading & Weekend Holding" article — see
https://help.fundingpips.com/hc/en-us/articles/43468639481105-Traders-Toolkit and
https://help.fundingpips.com/hc/en-us/articles/34504137479441-News-Trading-Weekend-Holding. Platform
and instrument names are broker-specific and need a primary read.

### Lucid Trading — LucidFlex (futures firm; CME futures, not CFDs)

**P**

- Drawdown https://support.lucidtrading.com/en/articles/12945815-lucidflex-drawdown : **end-of-day
  trailing** in evaluation and funded; 25K max loss limit $1,000, initial trail balance $26,100, locked
  floor $25,100; a payout request adjusts the MLL to the locked floor. Exact live-account applicability
  is unconfirmed.
- Evaluation https://support.lucidtrading.com/en/articles/12945790-lucidflex-evaluation-account : 25K
  target $1,250, MLL $1,000, 50% consistency, 2 minis / 20 micros, an **optional daily-loss-limit (DLL)
  checkout**.
- Funded https://support.lucidtrading.com/en/articles/12945795-lucidflex-funded-account : 25K MLL
  $1,000, optional DLL, scaling applies, no consistency rule, 90/10 split. **Do not assume the optional
  DLL is absent on the founder's account.**
- Automation https://support.lucidtrading.com/en/articles/11404728-other-trading-activities :
  automation and trade copiers permitted subject to all rules, trader responsible; news is allowed on
  Flex. **The API/cloud-hosting route is still unresolved.**
- Platforms https://support.lucidtrading.com/en/articles/11404614-lucid-trading-supported-platforms :
  CQG data (NinjaTrader, Tradovate, TradingView) is distinguished from the listed Rithmic platforms.
- Hours https://support.lucidtrading.com/en/articles/11404729-allowed-trading-times : Flex positions are
  auto-closed at **16:45 "EST"**; holidays alter the schedule. The EST-vs-DST wording is ambiguous and
  stays so until confirmed.
- Geography https://support.lucidtrading.com/en/articles/11404636-restricted-countries : India does not
  appear in the published exclusion list; **that alone does not certify the owner's eligibility.**
- Products https://support.lucidtrading.com/en/articles/11508978-approved-products-and-commissions :
  YM, MYM, MNQ and MGC are approved with published commissions. No CFD mapping is implied.

### CME contract facts

**P** https://www.cmegroup.com/articles/faqs/micro-e-mini-equity-index-futures-frequently-asked-questions.html :
MYM — one index point is worth $0.50; MNQ — 0.25 of an index point is worth $0.50. This removes the
earlier blanket "no CME specs retrieved" for these two leads only; **MGC, roll/expiry, hours and the
mapping to a provider's contract codes still need an exact-spec review.** No instrument file is created
or VERIFIED here and no contract is selected.

### Tradovate

**P** https://tradovate.zendesk.com/hc/en-us/articles/4403105829523-How-Do-I-Get-Access-to-the-Tradovate-API :
retail API access needs a LIVE account balance **greater than** $1,000, a CME license agreement and a
paid API add-on (the current price is not text-confirmed). **P** partner documentation exists for
prop-firm/evaluation management
(https://partner.tradovate.com/overview/prop-firm-management/create-and-manage-users-and-accounts) and
an authorized market-data API
(https://partner.tradovate.com/overview/core-concepts/web-sockets/market-data/market-data). Neither
proves the founder's entitlement or Lucid availability, and retail rules must not be read as showing
that prop SIM accounts can never use an API. Unread fees/licensing amounts remain **L**.

### Other platform leads (L, unread)

- Rithmic (https://www.rithmic.com/apis): R|API+, R|Protocol (WebSocket + protobuf, any language),
  R|Diamond; market-data agreement and CME fees listed (e.g. $10/$105 per exchange per month
  non-professional/professional) and a $49.99/month paper-trading fee — amounts unverified.
- MetaTrader 5 Python package needs a Windows terminal (https://www.mql5.com/en/docs/python_metatrader5).
- cTrader Open API requires an application reviewed by Spotware (https://help.ctrader.com/open-api/api-application/).
- Match-Trader: no official API documentation surfaced.

## 3. Futures vs CFD (never map by assumption)

Lucid trades **CME futures** (YM/MYM, MNQ, MGC approved); FundingPips offers **broker CFDs** under
platform symbols (leads: DJI30, NDX100, XAUUSD). Contract size, tick, spread, commission, swap, leverage
and hours of a CFD are broker-specific and unsourced; a CFD index differs from the futures contract
(basis, hours, rolls). ASTRA has `MNQ`/`NQ` futures files and a `XAUUSD` **template** (which states its
own 100 oz/lot assumption); there is no YM/MYM/MGC and no CFD-index instrument file, and none may be
derived from the other class.

## 4. Automation / cloud / API permissions

| Need of ASTRA                       | Lucid                                                                                   | FundingPips                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Software places orders              | automation permitted subject to all rules (P); HFT/microscalping/hedging prohibited (L) | own-EA automation needs proof assessed by the firm; third-party automation restricted (P). Whether ASTRA's externally built own software/API is accepted is **unresolved** |
| Cloud host / VPS                    | not addressed in the pages read → **unresolved**                                        | VPN/VPS access forbidden (P) → conflicts with a cloud-hosted ASTRA unless the firm confirms otherwise                                                                      |
| Third-party API / data link         | API route (Rithmic/CQG/Tradovate) **unresolved** for the founder's account              | via MT5 / cTrader / Match-Trader (L); firm position on non-terminal API clients **unresolved**                                                                             |
| Own signals (n8n webhooks, copiers) | trade copiers permitted (P)                                                             | inbound external copy trading forbidden (P); **how the firm classifies ASTRA's own signal flow is for the firm to confirm** — not asserted here                            |

## 5. Risk-rule verification gaps (vs ASTRA's profile schema and engine)

The schema can express static / trailing intraday / trailing balance / trailing end-of-day drawdown, a
daily loss with a `DAY_START_HIGHER_OF_BALANCE_EQUITY` reference, consistency (monitor/block), position
limits with micro weights, a scaling plan, holding (overnight/weekend/flat-by) and a fixed-window news
rule. **Full compliance mapping is NOT shown; it is a gap needing proof, or a conservative supported
subset, per rule.** Specific gaps found in the source (`packages/prop-firm/src/profile.ts`):

- **Lucid:** no payout-triggered floor-change event (MLL moves to the locked floor on a payout
  request); optional DLL treatment depends on the account; consistency is an upgrade-eligibility check
  (maps to `MONITOR`, not a trade block); 16:45 "EST" flat-by and holiday schedules need an unambiguous
  zone/calendar; max size "2 minis / 20 micros" combined semantics need confirming.
- **FundingPips:** daily reset at 00:00 UTC+3 platform time (zone/DST behaviour to prove); no
  semantics for the monthly 100% option's 1% trade-idea "striking" or reward-split-dependent minimum
  days; the news window needs speech/END-time handling and the ≥5-hour-before-event exception, which a
  fixed before/after news window does not establish; Master-vs-evaluation holding differences.
- **Source-mapping note (FundingPips maximum loss):** the published rule tests BOTH balance and equity
  against the floor, but `profile.maxDrawdown.measure` selects ONE (`EQUITY` or `BALANCE`). A profile
  using a single measure cannot be VERIFIED; the full conjunction needs proof/coverage (or a documented
  conservative refusal, which is never to be called complete compliance). The same holds for the
  speech/END-time exceptions and the payout-triggered or reward-option-specific rules above.
- Nothing here implements or relaxes a schema or gate.

Owner-specific unknowns: which program/size/phase/reward option/DLL/add-ons are actually owned, the
platform and data feed on the account, residency/eligibility, and any firm replies.

## 6. Tradable and historical data availability, licensing, cost

Only the **P** items in §2 are current facts; everything else is an **L** lead. Nothing was purchased,
registered or called. Historical futures/CFD data licensing and cost are unsourced (CME historical
licensing, broker CFD history). The research dataset in the repository is HistData FX 2010–2019
(`docs/research/data-histdata-2010-2019.md`), which is neither the firms' feeds nor these instruments.
**No unavoidable spend was identified for the next bounded task.** Possible later costs (exchange data
agreements, API add-ons, platform subscriptions) are the founder's optional choices; none is proposed or
approved.

## 7. Mapping to ASTRA's existing ports

| ASTRA port / config                                                          | Needed for                              | State                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrokerAdapter` (`kind: 'LIVE'`), `OrderRequest`, snapshots, `closePosition` | a real firm account                     | Only the PAPER adapter exists. **R004 ownership/crash fencing is PAPER-only.** The generic gateway controls (S001 reservations, F003 final guard, S002 queued-action pinning) are not proven for a real adapter's crash recovery, multi-process ownership, restart idempotency or order-state linkage — **explicit gaps for any real adapter**, with no live-readiness claim |
| ADR-0027 position ↔ order linkage by `clientOrderId`                         | releasing reservations on a real broker | Unverified per API (no route has been shown to return the client id on fills/closes)                                                                                                                                                                                                                                                                                         |
| `MarketDataAdapter` + `instrument.providerSymbols`                           | tradable bid/ask with measured delay    | No real provider; the chart-only Yahoo feed never counts as a quote                                                                                                                                                                                                                                                                                                          |
| Instrument specs                                                             | sizing/tick value/hours                 | `MNQ`, `NQ`, `XAUUSD` (template), FX templates only; MYM/YM/MGC and CFD indices absent and need exact-spec review                                                                                                                                                                                                                                                            |
| `PropFirmRuleProfile`                                                        | firm rules                              | Two TEMPLATE profiles; mapping gaps in §5                                                                                                                                                                                                                                                                                                                                    |
| `AccountDefinition.broker` + S002 binding pin                                | binding an account to an adapter        | ready in principle; the accountRef format comes from the chosen platform                                                                                                                                                                                                                                                                                                     |
| Calendar / news ports                                                        | blackouts                               | exist; the firm's news semantics are not fully expressible (§5)                                                                                                                                                                                                                                                                                                              |

## 8. Engineering view (evidence-based; nothing selected)

1. Lucid/futures is structurally closer (ASTRA's futures configs, end-of-day trailing drawdown,
   consistency monitor, flat-by; automation permitted), but its API route, cloud-host rule and the
   founder's exact account are unresolved.
2. FundingPips 2 Step Flex carries explicit obstacles for a cloud ASTRA (VPN/VPS forbidden;
   own-EA proof; external-API acceptance unresolved), though evaluation holding is permitted.
3. No real adapter until the founder's account and a later written firm/API confirmation exist; the first
   implementation task would be a fake-server contract/conformance test with no credentials.

## 9. Minimum founder-only unknowns

Only what we cannot read ourselves:

1. **The exact current account — or "none purchased yet":** firm, program, size, phase, reward
   option, whether the optional DLL and any add-ons (e.g. Swing) were taken, and the platform and
   data feed shown on the account.

Later gate, not requested now: a written firm/API permission for the **selected** route, and any
account-specific rule evidence the public pages do not settle. The founder is not asked to purchase or
access any API or data feed now, nor to retrieve rule pages we can read ourselves. **No spend is
requested; no credentials are requested in chat.**

## 10. Next bounded task

**P002** (after item 1): read the remaining primary pages ourselves (Lucid funded/news details,
FundingPips Master news and reward pages for the exact option, MGC/roll/hours specs, the chosen
platform's API terms), then a design-only provider contract and fake-server conformance test for the
chosen route, with sourced instrument/profile files left `UNVERIFIED` until the owner confirms the
account.
