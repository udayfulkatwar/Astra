# n8n workflows

n8n **orchestrates**; ASTRA Core **decides** (ADR-0005). Workflows never talk to brokers, never
compute risk and never hold broker credentials. Everything they send is re-validated by the core.

| Workflow                   | Family | Purpose                                                                                                                |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `astra-heartbeat.json`     | Health | POST `/api/v1/automation/heartbeat` every minute. If it stops, ASTRA marks automation `UNKNOWN` and blocks new trades. |
| `astra-error-handler.json` | Error  | Global error workflow: reports failures to `/api/v1/automation/errors` (visible in Live Activity).                     |

Later phases add: ingestion (news, calendar → `/api/v1/calendar/window`), market-data relays
(→ `/api/v1/market/quotes`), candidate submission (→ `/api/v1/decisions/evaluate`), notifications,
and daily/weekly reports.

## One-time setup

1. `docker compose up -d` and open n8n at http://localhost:5678 (create the owner account).
2. Create a credential of type **Header Auth** named exactly `ASTRA automation token`:
   - Name: `Authorization`
   - Value: `Bearer <ASTRA_AUTOMATION_TOKEN from .env>`

   The token lives only in n8n's encrypted credential store — never in workflow JSON.

3. Import the workflows:
   ```sh
   docker compose exec n8n n8n import:workflow --separate --input=/workflows
   ```
4. Open each imported workflow, select the `ASTRA automation token` credential on the HTTP node
   if n8n did not link it automatically, set **ASTRA — Error handler** as the error workflow in
   the heartbeat workflow's settings, and activate both.
5. Check the dashboard: the status bar should show `N8N ONLINE` within a minute.

Workflows address the API as `http://api:8080` (the compose service name), so they work the same
locally and in the cloud. Environment access from workflow code is disabled
(`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`) because the n8n environment contains secrets.
