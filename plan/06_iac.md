# Infra-as-code plan (Bicep)

## 1. First repo action (before any infra)

`.gitignore` with `secrets.txt`, `.env`, `.env.*`, `*.local`, `local.settings.json`, `.azure/` — plus a husky pre-commit hook (`scripts/check-no-secrets`) failing if any of those are staged, and gitleaks in CI as the second net.

## 2. Layout & model

`infra/main.bicep` at **subscription scope** (`az deployment sub create`) so the RG itself is IaC-managed, + `main.{dev,prod}.bicepparam` and `modules/` (postgres, storage, keyvault, functions, monitoring, staticwebapp, budget). RGs: **`prakkie-dev`**, **`prakkie-prod`**, both West Europe. Naming `{resource}-prakkie-{env}` (`func-prakkie-api-dev`, `kv-prakkie-dev`, `pg-prakkie-dev`, `stprakkiedev`). Every deploy runs `what-if` first; prod is gated.

## 3. Resource list (per environment)

| # | Resource | Config (cost-relevant) |
|---|---|---|
| 1 | PostgreSQL Flexible Server | Per ADR-0001: B1ms, 32 GB, PG 16, HA off, PITR 7 d, `azure.extensions = VECTOR,PG_TRGM,UNACCENT,CITEXT`, firewall (Azure services + admin IP), **no private endpoints** (budget). App connects as least-privilege roles, passwords in KV. One DB, schemas `app`/`catalog`/`discovery`. |
| 2 | Storage account | StorageV2 LRS, TLS 1.2. Containers + lifecycle per `03_architecture.md` §4; `db-backups` with **time-based immutability 30 d**. Queues per §4. Also hosts both Functions runtimes + Durable task hubs. |
| 3 | Key Vault | Standard, **RBAC mode**, soft-delete + purge protection. Secrets by name: `APIFY-API-TOKEN`, `OPENAI-API-KEY`, `PG-APP-PASSWORD`, `PG-INGEST-PASSWORD`, `APPLE-OAUTH-CLIENT-SECRET`, `GOOGLE-OAUTH-CLIENT-SECRET`, `JWT-SIGNING-KEY`, (`PICNIC-USERNAME`/`-PASSWORD` pending owner decision). |
| 4 | RBAC assignments | Each Function app's system-assigned identity → Key Vault Secrets User + Storage Blob/Queue Data Contributor; CI OIDC principal → Contributor on RG. Stable `guid()` names, idempotent. |
| 5 | **Two** Function apps + Y1 plans | `func-prakkie-api-{env}` + `func-prakkie-ingest-{env}`, Linux Consumption, Node 20, v4. KV references in app settings (`@Microsoft.KeyVault(SecretUri=…)`); `WEBSITE_RUN_FROM_PACKAGE`. |
| 6–8 | Log Analytics + App Insights + Workbook | PerGB2018, **daily cap 1 GB**, 30-day retention; workspace-based AI, 5% fixed-rate sampling in `host.json`; the one ops workbook checked in as JSON and deployed by Bicep. |
| 9 | Static Web App | Free tier; web reader + landing + `/bot` PrakkieBot contact page; custom domain when the domain input lands. |
| 10–12 | Action group, Budget, Alerts | Email owner; RG budget €50 with **50/80/100% actual + 100% forecast**; metric/query alerts: Apify $/day + runs/day, PG `cpu_credits_remaining` low + storage >80%, import failure-rate spike, per-chain staleness >48 h, Functions execution anomaly. |

Explicitly **not** deployed: Azure AI Search, Cosmos, Service Bus, APIM, Front Door, VNet/private endpoints — off-budget or gold-plating at this scale.

## 4. One-command deploy — `scripts/deploy -Env dev|prod`

① `az deployment sub create … main.$Env.bicepparam` (idempotent RG + everything) → ② build + `func azure functionapp publish` both apps (run-from-package) → ③ `swa deploy` web → ④ run SQL migrations (node-pg-migrate/drizzle-kit) with the KV connection string fetched at runtime, never written to disk. Same script locally (needs only `az login`) and in CI (OIDC).

## 5. One-time `scripts/setup-secrets` (no-echo Key Vault load)

Reads `secrets.txt` (KEY=VALUE) **into variables only** — never printed/echoed, never expanded on a command line that lands in history; per-key `az keyvault secret set` with output redirected to `$null`; failures report the **name only**; verification prints only `az keyvault secret list --query "[].name"`. Refuses to run if `secrets.txt` is git-tracked. `AZURE_TENANT_ID`/subscription flow through `az login`/`az account set` context only. CI never sees `secrets.txt`; its sole credential is the GitHub OIDC federated principal (no long-lived secret in GitHub either).
