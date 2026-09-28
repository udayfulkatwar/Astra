# n8n workflows

n8n **orchestrates**; ASTRA Core **decides** (ADR-0005, ADR-0021). Workflows schedule, fetch and
deliver. They never talk to brokers, never compute risk and never hold broker credentials.
ASTRA re-validates everything they send, and computes every figure they report.

The workflow JSON in `workflows/` is **generated**: the logic of every Code node lives in
`src/nodes/*.ts` (typed and unit-tested), and `src/workflows.ts` defines the workflows. After a
change, run `pnpm --filter @astra/n8n build`. A test fails if the committed JSON drifts.

Tested in a real n8n **2.40.7**: import, publish, schedules, the signal webhook, the Notify
sub-workflow with email delivery, and the error workflow.

## Workflows

| Workflow                     | Family        | What it does                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ASTRA — Heartbeat            | Health        | Every minute → `POST /api/v1/automation/heartbeat`. If it stops, ASTRA marks automation UNKNOWN and approves no new trades.                                                                                                                                                                                                               |
| ASTRA — Error handler        | Error         | Error workflow of every other workflow → `POST /api/v1/automation/errors` (Live Activity; ERRORs also reach Alerts).                                                                                                                                                                                                                      |
| ASTRA — News ingestion (RSS) | Ingestion     | Every 5 min: your RSS / Atom feeds → normalised items → `POST /api/v1/news/items` (one batch per feed; ASTRA classifies them). A failed feed stops the run, so ASTRA's news goes stale (no new trades) instead of pretending the feed is fine.                                                                                            |
| ASTRA — Calendar ingestion   | Ingestion     | Every 30 min: your calendar source → `POST /api/v1/calendar/window`. Formats: `astra-window` (ASTRA's own JSON) or `ff-weekly-json` (a ForexFactory-style weekly export — **unverified**, the export could not be reached from the build environment; a mismatch stops the run). Sources that leave a gap are never merged across it.     |
| ASTRA — Signal webhook       | Cycle         | `POST /webhook/astra-signal` (e.g. a TradingView alert) → a trade candidate → `POST /api/v1/decisions/evaluate` → the decision is returned to the sender. The gate decides; the workflow only reshapes the alert.                                                                                                                         |
| ASTRA — Alerts               | Notifications | Every minute: new ASTRA events → one grouped message → Notify. Sent: every ERROR / CRITICAL, kill switches, mode and account-health changes, position alerts, protective closes, high-impact news, executions, closed trades. Not sent: routine gate rejections, calendar updates, and failures of Alerts / Notify themselves (no loops). |
| ASTRA — Reports              | Reports       | Daily Mon–Fri 17:10 New York and weekly Fri 17:20 → `GET /api/v1/reports` (ASTRA computes the report) → Notify.                                                                                                                                                                                                                           |
| ASTRA — Notify               | Delivery      | Sub-workflow: one message → Telegram, Discord and/or email. With no channel enabled it stops with an error (visible in ASTRA), so alerts are never silently dropped.                                                                                                                                                                      |

## Setup

1. `docker compose up -d`, open n8n at http://localhost:5678 and create the owner account.
2. Create these credentials in n8n (secrets live only here, never in workflow JSON):

   | Credential name (exact)       | Type            | Content                                                                                                                          |
   | ----------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
   | `ASTRA automation token`      | Header Auth     | Name `Authorization`, value `Bearer <ASTRA_AUTOMATION_TOKEN from .env>`                                                          |
   | `ASTRA signal webhook secret` | Header Auth     | Name `X-Astra-Secret` (or any header), value: a long random secret (`openssl rand -hex 32`). Only needed for the signal webhook. |
   | `ASTRA Telegram bot`          | Telegram API    | Your bot token (only if you use Telegram).                                                                                       |
   | `ASTRA Discord webhook`       | Discord Webhook | Your channel's webhook URL (only if you use Discord).                                                                            |
   | `ASTRA SMTP`                  | SMTP            | Your mail server (only if you use email).                                                                                        |

3. Import the workflows:
   ```sh
   docker compose exec n8n n8n import:workflow --separate --input=/workflows
   ```
4. Open each workflow and select the matching credential on its nodes if n8n did not link it.
5. Edit the three "(edit me)" nodes:
   - **News ingestion → Sources (edit me)**: your RSS / Atom feed URLs.
   - **Calendar ingestion → Sources (edit me)**: your calendar source and its format.
   - **Notify → Channels (edit me)**: enable Telegram (chat id), Discord and/or email (from / to).
6. **Publish every workflow you use, including Notify and Error handler.** In n8n 2.x an
   unpublished sub-workflow or error workflow cannot be called ("Workflow is not active").
7. Check the dashboard: the status bar shows `N8N ONLINE` within a minute.

Until steps 5–6 are done the ingestion workflows stop with an explanatory error. ASTRA then has
no fresh news or calendar and approves no new trades — by design.

## Sending signals from TradingView (or anything else)

POST JSON to `https://<your n8n host>/webhook/astra-signal`:

```json
{
  "accountId": "paper-demo",
  "strategyId": "paper-pipeline-test",
  "symbol": "MNQ",
  "direction": "buy",
  "entry": 20000.25,
  "stop": 19990.25,
  "target": 20020.25,
  "timeframe": "M5",
  "rationale": ["BOS on M5"],
  "autoExecute": false
}
```

- `direction`: LONG / SHORT (or buy / sell). `time` (ISO or epoch ms) and `signalId` are
  optional. Without `signalId`, a retried alert in the same minute gets the same id, and ASTRA
  refuses to approve it twice.
- `autoExecute: true` executes an approval only in modes configured for automatic execution
  (never LIVE).
- TradingView cannot send custom headers. Either put a proxy in front that adds the secret
  header, or change the webhook node to no authentication **and** a long random path (keep the
  URL secret). The gate still accepts only configured, active strategies and accounts.
- n8n listens on 127.0.0.1 in `docker-compose.yml`. To receive alerts from the internet, put it
  behind a TLS reverse proxy (and set n8n's `WEBHOOK_URL`).

## Notes

- Workflows address the API as `http://api:8080` (the compose service name).
- Code nodes cannot read the environment (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`): the n8n
  environment contains secrets.
- Pushed news and calendar data are labelled MANUAL: accepted in PAPER, refused in SHADOW and
  LIVE until a real provider adapter delivers LIVE data.
- ASTRA holds one calendar window at a time: use one calendar source (this workflow or a core
  provider), not both.
