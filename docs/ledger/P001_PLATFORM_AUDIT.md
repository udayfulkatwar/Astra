# P001 — Stage 2 firm / platform compatibility and data-readiness audit

Access date: **2026-10-04**. Branch `claude/p001-platform-readiness`. Documentation only: no adapter,
strategy, data purchase, credential, paid call, account or provider was created or activated, and no
safety gate was changed. Live trading stays DISABLED; no strategy is promoted; no profile is VERIFIED.

## 1. How this was sourced (read this first)

- **Direct page fetches of every official domain were blocked** by this environment's network egress
  proxy (`EGRESS_BLOCKED`): `lucidtrading.com`, `fundingpips.com`, `help.fundingpips.com`,
  `cmegroup.com`, `www.metatrader5.com`, `help.ctrader.com`. `help.lucidtrading.com` does not resolve.
  Nothing below was read verbatim from a firm page.
- The only access was a web search tool restricted (`allowed_domains`) to official domains. It returns
  the official page URL plus a **paraphrase**. Support level used below: **O-S** = official-domain URL
  surfaced by that search, wording not independently read; the paraphrase can be wrong.
- Third-party aggregator/review pages also appeared. They are **not used as facts**. Where one disagrees
  with an official-domain result it is listed as a conflict, not resolved.
- Everything here is therefore a lead for the founder/CEO to confirm on the live official page and,
  for account terms, in the purchased account's own dashboard/agreement. The founder's named targets
  (Lucid Flex 25K, FundingPips 10K two-step Flex; US30 / NAS100 / XAUUSD intraday) are **intended
  targets, not confirmation of a purchased program, platform, current terms or permissions.**

## 2. Published public facts (O-S) — separate from account-specific unknowns

### Lucid Trading (futures prop firm; CME futures, not CFDs)

| Topic                | Published (O-S)                                                                                                                                                                                                         | Source URL                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact program name   | "LucidFlex" (evaluation + funded); the 25K size exists (product pages "LucidFlex 25K Rithmic")                                                                                                                          | https://support.lucidtrading.com/en/articles/12945790-lucidflex-evaluation-account · https://sb1.lucidtrading.com/product/lucidflex-25k-rithmic/              |
| 25K evaluation terms | profit target $1,250; max loss limit $1,000; consistency 50% (largest day / total profit, an eligibility check to upgrade); max size 2 minis or 20 micros; no daily loss limit; full contract size from the first trade | same article · https://support.lucidtrading.com/en/articles/12945805-lucidflex-consistency-percentage                                                         |
| Drawdown type        | article exists (`12945815`); its content was NOT surfaced. "End-of-day trailing" appears only on third-party pages → **unresolved at official level**                                                                   | https://support.lucidtrading.com/en/articles/12945815-lucidflex-drawdown                                                                                      |
| Automation           | "automated trading systems and trade copiers are permitted"; trader is responsible for software errors; all automated activity must follow the rules                                                                    | https://support.lucidtrading.com/en/articles/11404728-other-activities                                                                                        |
| Prohibited           | high-frequency trading, microscalping (≥50% of profit from trades ≤5 s), hedging                                                                                                                                        | https://support.lucidtrading.com/en/articles/11404736-prohibited-high-frequency-trading · …/11404742-prohibited-microscalping · …/11404734-prohibited-hedging |
| Platforms / data     | NinjaTrader, TradingView, Tradovate on CQG data; a list of Rithmic-based platforms (R\|Trader Pro, Sierra Chart, Quantower, MotiveWave, ATAS, Bookmap, …)                                                               | https://support.lucidtrading.com/en/articles/11404614-lucid-trading-supported-platforms                                                                       |
| Products             | MYM (Micro E-mini Dow), MNQ (Micro E-mini Nasdaq-100), MGC (Micro Gold) approved, with per-side commissions 0.50 / 0.50 / 0.80; YM also approved                                                                        | https://support.lucidtrading.com/en/articles/11508978-approved-products-and-commissions                                                                       |
| Hours                | positions must be closed by 4:45 PM (stated "EST"; confirm the zone) Mon–Fri; trading resumes 6:00 PM Sun–Thu                                                                                                           | https://support.lucidtrading.com/en/articles/11404729-allowed-trading-times                                                                                   |
| Geography            | a "Restricted Countries" article exists (content not surfaced)                                                                                                                                                          | https://support.lucidtrading.com/en/articles/11404636-restricted-countries                                                                                    |

### FundingPips (CFD/forex prop firm; instruments are broker CFDs)

| Topic                 | Published (O-S)                                                                                                                                                                                                                                                                                                                        | Source URL                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact program name    | "2 Step Flex" (also "2 Step Standard", "2 Step Pro", "1 Step Flex"); sizes $5K, $10K, $25K, $50K, $100K                                                                                                                                                                                                                                | https://help.fundingpips.com/hc/en-us/articles/47835196271249-2-Step-Flex · https://fundingpips.com/2-step-flex                                                                   |
| 10K 2 Step Flex terms | daily loss 4%, maximum loss 12%, Phase 1 target 10%, **Phase 2 target 8%** (official-domain summaries); 1 minimum trading day on the 80% split or 3 profitable days on the 95% split                                                                                                                                                   | same · https://fundingpips.com/trading-objectives                                                                                                                                 |
| Conflict              | a third-party page states Phase 2 = 6% and "static" drawdown → **unresolved**; owner must read the live 2 Step Flex page                                                                                                                                                                                                               | —                                                                                                                                                                                 |
| Third-party EAs       | permitted only strictly as a trade/risk manager; any other use → denial and closure; **own EA allowed with proof of ownership** (source code/VCS/live walkthrough); copy trading between different users and third-party account management prohibited; inbound copy trading into a FundingPips account prohibited                     | https://help.fundingpips.com/hc/en-us/articles/34505029138449-Trading-Conduct-and-Security-Standards · https://help.fundingpips.com/hc/en-us/articles/49580068780817-Trade-Copier |
| VPN / VPS             | "Connecting to a VPN or VPS while accessing your trading account is not permitted" (summary of the conduct page)                                                                                                                                                                                                                       | same conduct page · https://fundingpips.com/terms-and-conditions                                                                                                                  |
| Prohibited methods    | gap trading, HFT, toxic flow, server spamming, latency arbitrage, hedging, tick scalping, execution exploits, churning                                                                                                                                                                                                                 | conduct page                                                                                                                                                                      |
| News / weekend        | an article "News Trading & Weekend Holding" exists; summary: overnight/weekend holding is NOT allowed on 1 Step Flex, 2 Step Standard, **2 Step Flex** and 2 Step Pro Master Accounts (auto-closed) unless the Swing add-on; news-trading rules vary by account type (Zero prohibits ±10 min) — **2 Step Flex news rule not surfaced** | https://help.fundingpips.com/hc/en-us/articles/34504137479441-News-Trading-Weekend-Holding                                                                                        |
| Platforms             | MT5, cTrader, Match-Trader; US residents cannot use cTrader; MT5 "not currently supported" for the United States; Match-Trader available to US/Canada                                                                                                                                                                                  | https://help.fundingpips.com/hc/en-us/articles/43468639481105-Traders-Toolkit · https://fundingpips.com/blog/mt5-is-back-at-fundingpips-trade-smarter-faster-and-better           |
| Instruments           | 41 instruments in 5 classes; XAUUSD; indices listed as **DJI30** ("US Wall Street 30") and **NDX100** ("US Tech 100") — platform names, not "US30"/"NAS100"                                                                                                                                                                            | https://help.fundingpips.com/hc/en-us (Traders Toolkit / platform pages)                                                                                                          |

## 3. Futures vs CFD (never map by assumption)

- **Lucid** = CME futures; the approved-products page surfaced YM/MYM (Dow), MNQ (Nasdaq-100) and MGC
  (gold). ASTRA already has `MNQ` and `NQ` futures instrument files; **no `YM`/`MYM`/`MGC`** exist. CME contract specifications
  (tick, point value, hours, expiry/roll) could not be retrieved (`cmegroup.com` blocked): do not take
  tick values from memory or third parties.
- **FundingPips** = broker CFDs under platform symbols DJI30/NDX100/XAUUSD (final names are
  broker/platform-specific). Contract size, tick, spread, commission, swap, leverage and hours are
  **broker-specific and not sourced**. The existing `XAUUSD.yaml` is a TEMPLATE that states its own
  100 oz/lot assumption; there is no US30/DJI30 or NAS100/NDX100 file and none may be created from a
  futures spec. A CFD index price/behaviour differs from the futures contract (basis, hours, rolls).

## 4. Automation / cloud / API permissions and restrictions

| Need of ASTRA                           | Lucid                                                                                                                   | FundingPips                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Software places orders                  | permitted by the published automation article (O-S); HFT/microscalp/hedge banned                                        | only own EA with proof of ownership, third-party EAs only as trade/risk manager (O-S). Whether an external service driving an API counts as an "EA" is **unresolved** |
| Runs on a cloud host / VPS              | not addressed in the surfaced pages → **unresolved** (an automation article exists; a VPS rule was not found)           | **VPN/VPS use reported as not permitted** (O-S) → conflicts with ASTRA's server topology unless the firm confirms otherwise in writing                                |
| Third-party API / data link             | platform list names Rithmic/CQG/Tradovate apps; **whether a custom API client is allowed on the account is unresolved** | via MT5 (Windows terminal), cTrader Open API or Match-Trader — firm position on non-terminal API clients **unresolved**                                               |
| Inbound signals (n8n webhooks, copiers) | trade copiers permitted                                                                                                 | inbound copy trading prohibited (O-S); our own strategy generating orders is not copy trading but must be confirmed                                                   |
| Geography                               | restricted-country list exists (not read)                                                                               | US: no cTrader/MT5 per the platform pages                                                                                                                             |

## 5. Risk-rule verification gaps (vs ASTRA's profile schema)

ASTRA's `PropFirmRuleProfile` can express: static / trailing intraday / trailing balance / **trailing
end-of-day** drawdown, daily loss, consistency (monitor/block), position limits with micro weights,
holding (overnight/weekend/flat-by), news restrictions, objectives. So the schema is not the blocker.
What is missing is **evidence and owner-specific confirmation**, so both candidate profiles stay
`UNVERIFIED`/template (no file is created or marked VERIFIED here):

- Lucid 25K: drawdown type and trailing/lock behaviour (official article not read), whether max size is
  "2 minis or 20 micros" combined, the consistency check being an upgrade eligibility test (maps to
  `MONITOR`, not a trade block), flat-by 16:45 ET with the exact zone, funded-account rules (separate
  article), restricted instruments/news, payout/other add-ons the founder actually bought.
- FundingPips 10K 2 Step Flex: Phase 2 target (8% vs 6% conflict), static vs other drawdown basis and
  reference (initial balance), the daily-loss reference/reset clock, leverage, news rule for this
  program, Swing add-on status, overnight/weekend prohibition (maps to `holding`), minimum days,
  inactivity and any consistency/lot limits.
- Account-specific unknowns (owner only): which program/size/phase is actually owned, price paid,
  platform and data feed on that account, residency, add-ons, and any written firm replies.

## 6. Tradable and historical data availability, licensing, cost

Published leads only; nothing was purchased, registered or called.

- **Rithmic** (O-S, https://www.rithmic.com/apis · https://yyy3.rithmic.com/?p=1063): R\|API+, **R\|Protocol
  (WebSocket + protobuf, "any language", cloud-friendly)**, R\|Diamond (Linux, co-location). All users
  must sign a Market Data Subscription Agreement and self-certify professional/non-professional;
  CME fees listed as $10/exchange/month non-professional, $105 professional; a paper-trading system
  fee of $49.99/month plus data. Whether an evaluation account from a prop firm may be driven through
  R\|Protocol by the owner's software is **unresolved** (firm- and Rithmic-permission dependent).
- **Tradovate** (O-S, https://support.tradovate.com/s/article/Tradovate-API-Access): API key needs a
  live funded account with ≥ $1,000 and the API Access add-on ($25/month); the API add-on includes
  **no real-time market data**; market-data streaming requires becoming a CME sub-vendor (ILA).
  Prop-firm simulation accounts probably do not qualify → unresolved.
- **MetaTrader 5** (O-S, https://www.mql5.com/en/docs/python_metatrader5): the Python package needs a
  working MT5 terminal **on Windows**; bars limited to the terminal's chart history. Fits FundingPips
  only where MT5 is available (not US) and conflicts with the VPS rule above.
- **cTrader Open API** (O-S, https://help.ctrader.com/open-api/api-application/): free application
  registration reviewed by Spotware; historical trendbars request exists. Not available to US
  residents on FundingPips; whether the firm's accounts allow Open API access is unresolved.
- **Match-Trader:** no official API documentation was surfaced → unresolved.
- **Historical data:** futures history licensing/cost (CME) not sourced (site blocked). The existing
  research dataset is HistData FX 2010–2019 (`docs/research/data-histdata-2010-2019.md`), which is
  neither the firms' feeds nor these instruments; free sources are not the firms' tradable prices.
- **Cost summary:** no unavoidable spend was identified for the next step. Possible costs are only the
  founder's optional choices above (exchange data fees, API add-ons, platform subscriptions); none is
  proposed or approved here.

## 7. Mapping to ASTRA's existing ports

| ASTRA port / config                                                                     | Needed for                              | State                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrokerAdapter` (`kind: 'LIVE'`), `OrderRequest`, `getAccountSnapshot`, `closePosition` | any real firm account                   | only the PAPER adapter exists; the LIVE gateway rules (ADR-0008, S001–S002, R004 fences) already apply to any `LIVE` adapter                                                          |
| ADR-0027 position ↔ order linkage by `clientOrderId`                                    | releasing reservations on a real broker | **unverified per API**: each candidate (Rithmic order tags, MT5 magic/comment, cTrader label, Tradovate tags) must be shown to carry the client id back on fills/closes — not sourced |
| `MarketDataAdapter` (+ `instrument.providerSymbols`)                                    | tradable bid/ask with measured delay    | no real provider; chart-only Yahoo feed never counts as a quote. Symbol mapping per provider is explicit and per instrument                                                           |
| Instrument specs (`config/instruments/*`)                                               | sizing, tick value, hours               | `MNQ`, `NQ` (futures), `XAUUSD` (CFD template), FX templates exist; `YM`/`MYM`/`MGC` and CFD index files do **not** exist and need sourced, broker-specific values                    |
| `PropFirmRuleProfile` (`config/prop-firm-profiles`)                                     | firm rules                              | schema sufficient; only two TEMPLATE profiles; verification needs the evidence in §5                                                                                                  |
| `AccountDefinition.broker.{adapterId, accountRef}`, S002 binding pin                    | binding an account to an adapter        | ready; accountRef format comes from the chosen platform                                                                                                                               |
| Calendar / news provider ports                                                          | blackouts, news rules                   | exist; firm news rules must be encoded once known                                                                                                                                     |

## 8. Engineering recommendation (evidence-based; no commitment, no account selected)

1. **Lucid/futures is the structural fit**: ASTRA's configs, EOD-trailing drawdown, consistency
   monitor and flat-by rule match, and automation is explicitly permitted (O-S). Its open question is
   the API route (Rithmic R\|Protocol / CQG / Tradovate) and cloud hosting, not the rules.
2. **FundingPips 2 Step Flex is currently a poor fit for a cloud-hosted ASTRA**: the surfaced pages
   say VPN/VPS is not permitted, third-party automation is restricted to personal EAs with proof, the
   program closes positions over weekends (unless Swing), and MT5/cTrader are unavailable to US
   residents. It is workable only if the firm confirms in writing an external own-software API
   connection from the owner's host.
3. Do not implement a real adapter until the founder confirms the exact account/platform and the
   firm's written permission for an API client; then build a **fake-server contract/conformance
   test first** (no credentials), then a read-only market-data adapter, then orders.

## 9. Minimum founder-only inputs for the next implementation task

1. **The exact current account** (or "none purchased yet"): firm, program name, size, phase, platform
   and data feed shown in your dashboard, and your country of residence.
2. **A written firm answer** (email/support ticket text or screenshot) that owner-operated software
   may connect to that account through an API (name the API/platform) from a cloud/VPS host, and
   whether any VPS/EA/news/weekend limits apply to that program.
3. **The firm's current rule evidence for that exact program** (the live rule page URL(s) or dashboard
   screenshots): drawdown type/limits, daily loss, targets, consistency, flat-by/holding, news, size.
   If a futures account: the approved contract list you want (e.g. MYM/MNQ/MGC).
4. **Spend:** none is required for the next bounded task. Any data/API fee in §6 is only needed later
   and only if you choose that route; none is proposed or approved.

No routine engineering choice and no credential is requested in chat.

## 10. Proposed next bounded task (after the inputs above)

**P002** — design-only provider contract and a fake-server conformance test for the confirmed route
(orders, positions, `clientOrderId` linkage, quotes), plus sourced instrument and profile files left
`UNVERIFIED` until the owner confirms the account. No real credentials, accounts or spend.
