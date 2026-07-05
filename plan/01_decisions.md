# Decisions up front (D1–D4)

### D1 · Storage — **Azure Database for PostgreSQL Flexible Server (B1ms + pgvector + pg_trgm), one server for everything** *(ADR-0001, full record in [`02_adr-0001-storage.md`](02_adr-0001-storage.md))*

One boring database hosts app data, the 300k-row product catalog + embeddings + price history, and the crawled discovery corpus, separated by schema. Cosmos free tier genuinely wins the cost criterion (€0 vs ≈ €16/mo), but criterion 1 is a threshold ("target ≤ €15 for storage"), not "cheapest wins" — Postgres lands at that threshold, the total envelope still closes at ≈ €27–50, and Postgres then wins matching-fit, ops-simplicity and portability outright: `pg_trgm`+`unaccent` fuzzy + `pgvector` HNSW + relational joins in a single query is exactly what the matching engine (the moat) needs, where Cosmos would force DIY n-gram fuzzy search and RU/partition engineering into the product's hardest component. PITR + a nightly immutable `pg_dump` satisfy the P0 durability guarantee twice over.

### D2 · Client framework — **React Native + Expo (TypeScript)**

Chosen over .NET MAUI for four concrete reasons. (1) The owner's existing, tested import pipeline is TypeScript (Supabase Edge Functions per `docs/06` §0) — porting it to a TypeScript Azure Functions backend and sharing the canonical `Recipe`/`Product` zod schemas across backend, mobile and web reader in one language eliminates an entire class of serialization drift; MAUI would force a C# rewrite of the hard-won import code. (2) The share-sheet is the primary capture path (spec B1) and Expo has a proven path for iOS Share Extensions / Android share intents (`expo-share-intent` config plugin) plus clipboard detection, keep-awake, drag-and-drop and OTA updates via EAS — everything the mockups need. (3) The thin web reader (M5) reuses the same TypeScript models and query logic. (4) Ecosystem depth and hot-reload iteration speed matter more for a solo dev + AI-agent team than C# affinity with Azure — the Azure SDK for JS is first-class anyway.

### D3 · Backend shape — **Azure Functions (Consumption, Node 20/TS, v4 model), two apps; Durable Functions for the video-import tail**

Functions Consumption over Container Apps because the free grant (1M executions + 400k GB-s/month) makes the API, nightly ingestion and the weekly crawler effectively €0 at our scale — `docs/03` §3 already settles compute this way. The 120–180 s video-transcript path does **not** justify Container Apps' always-warm pricing: import splits into a **synchronous fast path** (blog/caption/metadata, < 3 s) and an **asynchronous video path** via **Durable Functions** (`202 Accepted` + `importId`; app polls `GET /import/{id}`). Two Consumption apps, not one: `func-prakkie-api` (user-facing, latency-sensitive) and `func-prakkie-ingest` (machine-facing timers/queues) — so a misbehaving crawler or a 429 storm can never exhaust the API app's connection pool or scale-out; the second app costs ~€0.

### D4 · Repo layout — **single monorepo (pnpm workspaces)**

One repo keeps the shared zod schemas, the matching engine and the JSON-LD extractor importable by backend and clients without publishing packages; one CI pipeline; no cross-repo coordination tax. Concrete tree:

```
prakkie/
├─ .gitignore                    # FIRST commit: secrets.txt, .env*, local.settings.json, .azure/
├─ apps/
│  ├─ mobile/                    # Expo (React Native, TS, Expo Router)
│  │  ├─ app/                    # (tabs)/recepten|plannen|lijst|prijzen, import/, recipe/[id], cook/[id], onboarding/
│  │  ├─ components/             # RecipeCardGrid, PricePill, BonusBadge, AisleSection, TabBar+FAB…
│  │  ├─ features/               # library, import, planner, list, prices, ontdek, pantry, household, settings
│  │  └─ src/theme/tokens.ts     # design tokens from docs/04 §1, verbatim
│  └─ web/                       # thin web reader (Static Web Apps free) — read/organise library
├─ services/
│  ├─ functions-api/             # func-prakkie-api: HTTP API, auth, sync, import-recipe + Durable orchestrator
│  └─ functions-ingest/          # func-prakkie-ingest: 11 chain timers, crawler, price-compute, exports, pg_dump
├─ packages/
│  ├─ shared/                    # zod: Recipe (B8), Product (02 §3), LinkContext, DTOs; NL formatting; aisle taxonomy;
│  │                             # JSON-LD schema.org/Recipe extractor (shared by blog import B2 AND the crawler)
│  ├─ matching/                  # E1 normaliser, E3 matcher (pg_trgm + pgvector + rules), pack-size reconciliation
│  └─ testing/                   # golden-set fixtures, catalog snapshot, cassettes
├─ infra/                        # Bicep: main.bicep + modules/, main.{dev,prod}.bicepparam
├─ scripts/                      # setup-secrets, deploy, seed-lexicon, record-fixture, match-eval, import-eval
├─ docs/                         # spec pack (present) + adr/ (ADR-0001 storage, 0002 bicep, 0003 two apps, 0004 auth)
└─ .github/workflows/            # pr, infra, deploy-dev, deploy-prod, accuracy-weekly, canary-nightly, eas
```
