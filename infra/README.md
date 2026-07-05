# Prakkie infra (Bicep)

Subscription-scope deployment (`main.bicep`) so the resource group itself is IaC-managed. See [plan/06_iac.md](../plan/06_iac.md) for the full spec and ADR-0002 for why Bicep.

## Deploy

```powershell
./scripts/deploy.ps1 -Env dev        # what-if → deploy → seed secrets → publish apps → healthz
./scripts/deploy.ps1 -Env dev -SkipInfra   # function apps only
./scripts/deploy.ps1 -Env prod       # gated: asks for confirmation
```

Needs only `az login` (locally) or GitHub OIDC (CI). The script generates and stores `PG-ADMIN-PASSWORD`, `JWT-SIGNING-KEY`, `PG-APP-PASSWORD`, `PG-INGEST-PASSWORD` in Key Vault on first run; external secrets (Apify, OpenAI, OAuth) are loaded separately via `./scripts/setup-secrets.ps1 -Env dev` from a git-ignored `secrets.txt`.

## Known deviation (dev)

The dev Postgres server is **`pg-prakkie-dev-ne` in North Europe**, not `pg-prakkie-dev` in West Europe: this subscription's Visual Studio offer is `LocationIsOfferRestricted` for PG Flexible Server in westeurope, and the aborted westeurope create left a stale ARM name reservation on `pg-prakkie-dev`. Everything else lives in westeurope. Controlled by `pgLocation` + `pgServerName` in `main.dev.bicepparam`.

## Layout

- `main.bicep` — subscription scope: RG + all modules
- `main.{dev,prod}.bicepparam` — per-env parameters (no secrets; password + admin IP injected by the deploy script)
- `modules/monitoring.bicep` — Log Analytics (1 GB/day cap) + App Insights + owner action group
- `modules/storage.bicep` — blob containers (incl. immutable `db-backups`), lifecycle rules, queues
- `modules/keyvault.bicep` — RBAC mode, purge protection
- `modules/postgres.bicep` — B1ms/32 GB/PG16 per ADR-0001, extensions, firewall, CPU-credit + storage alerts
- `modules/functions.bicep` — one Linux Consumption app, invoked twice (api/ingest, ADR-0003)
- `modules/rbac.bicep` — function identities → KV Secrets User + Blob/Queue Data Contributor
- `modules/staticwebapp.bicep` — Free tier web reader/landing
- `modules/budget.bicep` — €50 RG budget, 50/80/100% actual + 100% forecast
