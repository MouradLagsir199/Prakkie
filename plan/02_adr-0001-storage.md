# ADR-0001 — Primary data store (Status: Accepted)

**Verdict:** the Postgres pick **survives the cost-first stress test**; not overturned.

## Scoring (criteria in `docs/03` §5 decision order)

| Option | 1. Cost (≤ €15) | 2. Durability/PITR | 3. Matching fit | 4. Ops simplicity | 5. Portability |
|---|---|---|---|---|---|
| 1 · Cosmos DB free tier | **5** — €0 (1000 RU/s + 25 GB) | 4 — 7-day PITR; logical export DIY | 3 — DiskANN vectors OK, fuzzy Dutch text DIY; nightly 300k refresh vs RU throttle | 3 — RU model, no joins, partition design | 2 — query-layer lock-in |
| **2 · PostgreSQL B1ms + pgvector + pg_trgm** | **3** — ≈ €16/mo, at target | **5** — PITR built in; pg_dump trivial | **5** — pg_trgm+unaccent fuzzy, pgvector HNSW, one SQL query with price/pack joins | **5** — one boring DB, JSONB for docs | **5** — runs anywhere |
| 3 · Azure SQL serverless | 4 — likely €0–5 | 5 | **2** — no mature vector/fuzzy; matching moves out of DB | 3 — split architecture + auto-pause cold starts | 3 |
| 4 · Blob catalog + small app DB | 4 — converges on app-DB choice | 2 | 2 — 300k embeddings won't fit Consumption memory | 2 — bespoke index, two systems | 3 |

## Why cost-first doesn't flip it to Cosmos

1. **Criterion 1 is a threshold and Postgres meets it (marginally):** B1ms ≈ €12.50 + 32 GiB ≈ €3.50 + backup €0 (free ≤ 100% provisioned at 7-day retention) ≈ **€16/mo**; the full envelope closes at **€27–50 ≤ €50** (see `03_architecture.md` §cost).
2. **Non-load-bearing cost levers:** capture Azure's intermittent 12-month-free B1ms promo if active at provisioning; dev server stopped by default (≈ €3.50/mo storage only, scripted re-stop around the 7-day auto-restart).
3. **Criterion 2 ties; criterion 3 is the moat and Cosmos loses it:** spec §E targets ≥90% top-1 matching. On Postgres, E3 is `unaccent(name) % unaccent(query)` + an HNSW scan, joinable in one statement with price/promo/pack data for pack-fit and the E5 learning loop. On Cosmos, half of workload B becomes DIY n-gram or a client-side index — the exact second-system complexity criteria 3 *and* 4 penalise.
4. **Cosmos's €0 has hidden costs:** RU throttling engineering on the nightly refresh, partition-key rework risk when households land, one-free-account-per-subscription coupling, and lock-in that contradicts `docs/03` §1's own clone-to-pay-as-you-go plan (Postgres exit = `pg_dump | pg_restore`).

**Rejections:** Option 1 — wins cost but fails 3/4/5 relative to Postgres and would be right only under a "minimise absolute €" reading criterion 1 doesn't have. Option 3 — forces matching out of the DB into a second in-process system + auto-pause cold start on first app open. Option 4 — a 300k-product embedding index doesn't fit a Consumption Function's memory; degenerates into "option 1/2/3 plus a bespoke index"; its one good idea (raw snapshots in Blob) is kept in the ingestion pipeline. Azure AI Search / provisioned Cosmos / Atlas / DB-in-VM stay excluded per `docs/03`.

## Concrete configuration

| Setting | Value |
|---|---|
| Service / SKU | Flexible Server, West Europe, **Standard_B1ms** (1 vCore/2 GiB), PostgreSQL 16 |
| Storage | 32 GiB, auto-grow on |
| HA | **Off** (doubles cost; PITR + logical dumps cover A2 at this scale) |
| PITR | 7-day retention (backup storage free ≤ provisioned size; 35-day is a config change later) |
| Logical backup | Nightly `pg_dump -Fc` (timer Function) → Blob `db-backups`, **immutability policy 30 days** + versioning, cool tier; first-of-month dumps kept 12 months |
| Extensions | `vector`, `pg_trgm`, `unaccent`, `citext` |
| Connections | Two small pools (api ≈ 20, ingest ≈ 20 of ~85 max); enable built-in **PgBouncer** the moment exhaustion appears |
| Roles | `app_rw` (api), `ingest_rw` (ingest; owns `catalog`/`discovery`); passwords in Key Vault; migrations own DDL |
| Dev | Second B1ms in `prakkie-dev`, **stopped by default** (≈ €3.50/mo) |

**Monthly estimate (prod): ≈ €16/month** (≈ €3.50 during any free-compute promo; dev ≈ €3.50 stopped).

## Consequences (accepted)

Biggest fixed budget line (~⅓ of envelope); B1ms is small — nightly ingestion staggered, embedding upserts batched, burst-credit alert wired (`08_observability-cost.md`), escape hatch = B2s bump (flag to owner first); we forgo Cosmos's €0 (~€192/yr is the price of the better engine; if mothballed: final dump to Blob, delete server). **Revisit trigger:** >500 users, sustained credit depletion, or storage >20 GiB.
