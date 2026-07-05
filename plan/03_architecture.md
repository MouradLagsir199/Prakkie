# Architecture overview

## 1. Component → Azure service map

| Component | Azure service | Notes |
|---|---|---|
| Mobile app | — (EAS Build / stores) | Expo RN TS, Expo Router, expo-share-intent |
| Web reader + landing | **Static Web Apps Free** | Free SSL + custom domain; read-only library calling the same API |
| API + import | **`func-prakkie-api`** (Consumption, Node 20, v4) | HTTP + Durable orchestrator for video tail |
| Ingestion / crawler / jobs | **`func-prakkie-ingest`** (Consumption) | Timer + queue triggers |
| Database | **PostgreSQL Flexible Server B1ms + 32 GB** | One DB, schemas `app` / `catalog` / `discovery`; PITR 7d |
| Blobs & queues | **Storage account `stprakkie{env}`** | Containers + queues in §4 |
| Secrets | **Key Vault** (RBAC mode) | Managed-identity access only |
| Parsing | **OpenAI API** behind `parseRecipe(context) → Recipe` | Provider swappable (docs/06 §6) |
| Scraping/transcription | **Apify actors**, verbatim IDs (docs/06 §4) | `run-sync-get-dataset-items`, `maxPaidDatasetItems=1`, per-actor `maxTotalChargeUsd` |
| Observability | **App Insights** (workspace-based) | 5% sampling, 1 GB/day cap, 30-day retention |
| Realtime upgrade path | **Web PubSub free tier** | v1 = polling (§6) |
| CI/CD, IaC | GitHub Actions + EAS; Bicep | RGs `prakkie-dev` / `prakkie-prod` |

## 2. Two Function apps (ADR-0003)

`func-prakkie-api` = everything user-facing (HTTP, auth, sync, `import-recipe` sync fast paths + Durable orchestration, list/price reads). `func-prakkie-ingest` = everything machine-facing (11 nightly chain timers, weekly crawl, queue workers, price-compute, GDPR export worker, nightly `pg_dump`, Apify spend meter). Split so retry-heavy ingestion can never starve API latency or its PG pool; independent deploys (connectors change weekly, the API doesn't); each gets its own Durable task hub name; both share one storage account. A third app buys nothing — import *is* API traffic and shares its auth middleware.

## 3. Auth — own lightweight JWT identity, not Entra External ID (ADR-0004)

Native Sign in with Apple / Google One Tap → app sends provider `id_token` → API verifies against Apple/Google JWKS → upserts `app.users` → issues our **access JWT (15 min)** + rotating refresh token (hash per device row); email+password (argon2id) as third option. **Guest mode** = anonymous user row + device-bound refresh token, upgraded in place after first import (spec A1/A3) — trivial here, genuinely awkward with Entra. Why not Entra External ID: Apple sign-in there needs custom-IdP federation with browser redirects (worse native UX), disproportionate tenant ceremony for a solo dev, user store outside our DB complicates GDPR export/delete and household modelling, and it's the stickiest possible dependency. JWT signing key in Key Vault; refresh rotation with reuse detection; `household_id` + `tier` as claims, re-issued on membership/subscription change.

## 4. Storage account layout

Blob containers (all private): `raw-snapshots` (per-chain raw API JSON `chain/yyyy-mm-dd/…` + crawler HTML; cool; delete chain JSON 90 d, HTML 30 d) · `images` (webp ≤ 200 KB, originals discarded; discovery thumbs ≤ 50 KB) · `import-cache` (URL-hash → raw Apify result + parsed recipe; delete 30 d) · `gdpr-exports` (SAS delivery; delete 7 d) · `db-backups` (immutable 30 d + monthly 12 mo).
Queues: `ingest-tasks`, `crawl-tasks`, `price-compute`, `export-jobs` (+ automatic `*-poison`). Storage Queues, not Service Bus — at-least-once is fine (docs/03 §3).

## 5. Data flows

1. **Import, sync fast path:** POST `sourceUrl` → `detectPlatform()` → **URL-hash cache check** (hit ⇒ instant, €0) → miss ⇒ page metadata + Apify metadata actors per docs/06 §4 verbatim → `LinkContext` → `hasUsableRecipeSignal()` (422/503 per docs/06 §5) → OpenAI `parseRecipe` → draft Recipe (< 3 s blog/caption) → review screen (mockup 04) → save.
2. **Import, async video tail:** premium + under quota ⇒ `app.import_jobs` row + Durable orchestration, **`202 + importId`**; activities: transcript actor (≤ 5-min media cap, 180 s timeout) → fuse → parse → result to `import_jobs` + cache. App polls `GET /import/{id}` (`scraping → transcribing → parsing → ready|failed`).
3. **Nightly ingestion:** 11 staggered timers 01:00–05:00 CET (Dirk+DekaMarkt share the one Detailresult connector). Walk category tree → enqueue `ingest-tasks` chunks (~300 reqs each keeps executions under the 10-min Consumption limit at 1 req/s politeness) → workers: fetch → **snapshot raw JSON to Blob before parsing** → parse to `Product` → per-product `content_hash`; deltas only upsert `catalog.products` + append `price_history`. Completion updates `chains.last_ingest_at` + enqueues `price-compute`. Per-chain kill switch = `chains.enabled`; app renders per-chain "prijzen van {datum}" staleness.
4. **Weekly discovery crawl (Sunday):** per enabled `crawl_sources` row: sitemap fetch, `lastmod` diff → `crawl-tasks` → worker: robots + blocklist check → fetch → **shared JSON-LD extractor** → validate (no ingredients/image ⇒ skip) → canonical B8 shape → dedup (`content_hash` + cross-site `dedup_key`) → upsert `discovery.crawled_recipes` → price-compute. Dead-link job hides 404/410 rows (saved copies untouched, A2/N5).
5. **Price compute:** queue-triggered, batched — changed SKUs refresh `discovery.recipe_prices` (p.p. per chain, coverage, deal overlap) via stored matched-SKU refs; rebuild `match_overrides_agg`. **User-facing prices computed on read** (PK joins against 300k rows = ms, inside the 2 s NFR); recipe cards cache `price_cache` JSONB, 24 h TTL.
6. **List sync:** pull-based delta cursors + push mutations with client UUIDs; LWW per field group (see `04_data-model.md` §5).

## 6. Realtime sync path

**v1:** foregrounded list screens poll `GET /sync?entities=list_items&since={cursor}` every 10 s (one indexed query, usually empty); check-offs push immediately — "gesynct met Sanne" ≤ 10 s stale. **Upgrade:** Web PubSub free tier (20 conns, 20k msgs/day) as a dirty-ping channel only — server broadcasts `{list_id}`, clients pull the same delta endpoint; no protocol change.

## 7. Monthly cost table (first ~500 users)

| Item | €/month |
|---|---|
| PostgreSQL B1ms + 32 GB (PITR incl.) | **15–17** |
| Functions ×2 (inside free grant) | 0–2 |
| Blob (images ~10 GB, snapshots cool, dumps) | 1–2 |
| Queues + Key Vault + DNS | 1 |
| App Insights (5% sampled, capped) | 0–3 |
| OpenAI (parsing + delta embeddings) | 5–10 |
| Apify (cost-guarded, cached, video premium-gated) | 5–15 |
| Static Web Apps + Web PubSub free tiers | 0 |
| **Total** | **≈ €27–50** |

Worst case touches the ceiling; typical months ≈ €30–40. The URL-hash cache hit-rate and premium gating are the levers that keep Apify at the low end.
