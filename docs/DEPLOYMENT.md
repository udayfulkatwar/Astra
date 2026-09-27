# Deployment and operations

One topology for local and cloud (ADR-0007): `postgres`, `api` (ASTRA Core), `dashboard`
(static + reverse proxy to the API), `n8n`. Only environment variables and mounted `config/` differ.

## 1. Local development (hot reload)

Prerequisites: Node.js 22, pnpm 10 (`corepack enable`), PostgreSQL 16 (local or `docker compose up -d postgres`).

```sh
pnpm install
cp .env.example .env                  # fill DATABASE_URL + the three tokens (openssl rand -hex 32)
pnpm dev                              # API on :8080 (tsx watch) + dashboard on :5173 (Vite, proxies /api)
```

Open http://localhost:5173 and sign in with `ASTRA_OPERATOR_TOKEN`.

For a self-contained paper sandbox without n8n or data providers:

```sh
ASTRA_SIMULATION=true pnpm dev        # SIMULATED quotes + calendar (refused in SHADOW/LIVE)
curl -X POST -H "Authorization: Bearer $ASTRA_AUTOMATION_TOKEN" \
     -H 'content-type: application/json' -d '{}' localhost:8080/api/v1/automation/heartbeat
```

Trading stays disabled until every required component (`DATABASE`, `MARKET_DATA`, `CALENDAR`,
`EXECUTION`, `AUTOMATION`) is ONLINE — the heartbeat above stands in for n8n. `MARKET_DATA` is
ONLINE only while every instrument traded by an ACTIVE account has a fresh, valid quote.

## 2. Full stack with Docker (Linux, macOS, Windows/WSL2)

```sh
cp .env.example .env                  # POSTGRES_PASSWORD, N8N_DB_PASSWORD, tokens, N8N_ENCRYPTION_KEY
docker compose up -d --build
```

| Service   | URL (bound to 127.0.0.1)                                       |
| --------- | -------------------------------------------------------------- |
| Dashboard | http://localhost:3000                                          |
| API       | http://localhost:8080 (`/healthz`, `/readyz`)                  |
| n8n       | http://localhost:5678 — then follow `automation/n8n/README.md` |
| Postgres  | localhost:5432                                                 |

The API applies migrations on start (`ASTRA_RUN_MIGRATIONS=true` by default) and **starts in the
mode persisted in the database** (PAPER on a fresh database; never LIVE without authorization).

## 3. Cloud (single VM to start)

1. VM with Docker (2 vCPU / 4 GB is ample), ideally in the region of your broker's servers.
2. Clone the repo, create `.env` from a secret manager (never commit it), `chmod 600 .env`.
3. Put a TLS reverse proxy in front. Example Caddyfile:
   ```
   astra.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   n8n.example.com {
     @blocked not remote_ip 203.0.113.10   # restrict the n8n editor to your IP
     respond @blocked 403
     reverse_proxy 127.0.0.1:5678
   }
   ```
   Set `N8N_SECURE_COOKIE=true` and `ASTRA_CORS_ORIGINS=https://astra.example.com`.
4. Firewall: expose only 80/443. Postgres, the API and n8n stay on localhost/the compose network.
5. Backups: nightly `docker compose exec postgres pg_dump -U astra astra | gzip > astra-$(date +%F).sql.gz`
   (plus the `n8n` database) shipped off-host; test restores. Managed Postgres is a drop-in
   replacement — point `DATABASE_URL` at it.
6. Monitoring: an external uptime check on `https://astra.example.com/healthz` and `/readyz`,
   alerting through a channel that does not depend on ASTRA itself.

## 4. Operations runbook

| Situation                                           | Action                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop all new trading now                            | Dashboard → Risk Controls → **EMERGENCY STOP** (GLOBAL kill switch), or `POST /api/v1/kill-switches/activate {"scope":"GLOBAL","reason":"…"}` |
| Pause one account / strategy / instrument           | Risk Controls → activate an ACCOUNT / STRATEGY / INSTRUMENT kill switch                                                                       |
| End of day                                          | Set mode `HALTED` (takes effect in memory even if the DB write fails)                                                                         |
| `EXECUTION` kill switch appeared                    | An order's state could not be confirmed. Check the broker, reconcile, then clear the switch with a reason.                                    |
| `ACCOUNT` switch "daily loss limit reached"         | Clears automatically at the next trading day; do not clear manually unless the firm confirms.                                                 |
| Trading disabled, reasons show `AUTOMATION UNKNOWN` | n8n heartbeat stopped — check the n8n container and the heartbeat workflow.                                                                   |
| `/readyz` 503                                       | Database unreachable or startup incomplete; the core stays fail-closed and retries every 5 s.                                                 |
| Verify audit integrity                              | Audit Log → **Verify chain** (`GET /api/v1/audit/verify`, operator)                                                                           |
| Change a rule/limit                                 | Edit `config/…yaml` in a pull request, review, deploy, restart the API. The new config hash appears on every subsequent decision.             |

## 5. Security checklist

- [ ] `.env` never committed; secrets generated with `openssl rand -hex 32`; tokens distinct.
- [ ] Only the reverse proxy is reachable from the internet; TLS everywhere.
- [ ] n8n owner account created with a strong password; editor IP-restricted.
- [ ] `ASTRA_LIVE_TRADING_AUTHORIZED=false` until the owner explicitly authorizes live trading.
- [ ] Hardening (future): run the API with a database role that has only `INSERT/SELECT` on
      `audit_log` (the table owner can disable triggers — tampering is still detected by
      `verify`, but prevention is better); OIDC + HttpOnly session cookies for the dashboard.

## 6. Going live (not enabled — requires the owner)

Live execution requires all six factors of ADR-0008. Additionally, before the first live order:
a LIVE broker adapter for the owner's platform must exist and pass its integration tests, the
system must have run in PAPER and SHADOW for an agreed period with reviewed results, and the
owner's verified rule profiles, instrument specs, risk policy and strategy must be in place.
