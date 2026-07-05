# Prakkie — Azure architecture & storage (€50/month envelope)

> **Purpose:** infrastructure constraints and target architecture for Fable 5 to build against.
> **Budget:** Visual Studio subscription with **€50/month Azure credit**. This must cover *everything* for the first users.
> **Region:** West Europe (Amsterdam) — GDPR data residency + lowest latency for NL users.
> **⚠️ The storage choice is deliberately an OPEN DECISION** — Fable 5 must pick from the shortlist in §5 using the decision matrix, and record the choice as an ADR before coding.

---

## 1. Budget reality check (professional dev notes)

- The €50/month is a **dev/test credit**. Microsoft's licensing says dev/test subscriptions are not for production workloads. Practical path: build and run the beta on the credit; the moment real users/payments arrive, clone the resource group to a pay-as-you-go subscription. **Design the whole stack so that its pay-as-you-go cost is also ≤ €30–50/month** — then the licensing question never becomes a money question. Everything below is chosen to satisfy that.
- The credit resets monthly and hard-stops (services suspend when exhausted) — that's actually a nice safety net against runaway costs, but set **budget alerts at 50/80/100%** anyway.
- Biggest cost traps to avoid at this scale: Azure AI Search (vector tier pricing), provisioned Cosmos DB (vs free tier), App Service on anything above B1, Application Insights ingestion (cap it at 1 GB/day, sample to 5%), and egress from storing images uncompressed.

## 2. Target architecture

```
┌─ Clients ─────────────────────────────────────────────────┐
│  iOS + Android app (cross-platform: .NET MAUI or React    │
│  Native/Expo — team-skill decision) · thin web reader     │
└──────────────┬────────────────────────────────────────────┘
               │ HTTPS/JSON
┌──────────────▼────────────────────────────────────────────┐
│  API backend — Azure Functions (Consumption) or           │
│  Container Apps (consumption, scale-to-zero)              │
│  · Auth: Microsoft Entra External ID / ASP.NET Identity   │
│    (Apple + Google OAuth)                                 │
│  · Endpoints: recipes, lists, plans, matching, prices     │
└───┬───────────────┬───────────────────┬───────────────────┘
    │               │                   │
┌───▼─────────┐ ┌───▼───────────────┐ ┌─▼──────────────────┐
│ App store   │ │ Product catalog   │ │ Blob Storage       │
│ (OPEN — §5) │ │ store (OPEN — §5) │ │ · recipe images    │
│ recipes,    │ │ ~300k rows,       │ │ · raw scrape       │
│ users,      │ │ nightly delta     │ │   snapshots        │
│ lists, plans│ │ refresh           │ │ · GDPR exports     │
└─────────────┘ └───▲───────────────┘ └────────────────────┘
                    │ nightly timer jobs (per chain, staggered)
              ┌─────┴──────────────────────────┐
              │ Ingestion workers (Functions   │
              │ timer triggers)                │
              │ · per-chain ingestion (all 11) │
              │ · staggered nightly refresh    │
              └────────────────────────────────┘

Import pipeline (Azure Function `import-recipe`; full spec in `06_social_import_apify.md`):
  share-sheet/blog URL → detectPlatform() → Apify actor(s) for
  metadata/caption + Apify transcript actor (≤5 min) →
  build LinkContext → OpenAI parse → NL Recipe (missing_fields,
  per-ingredient confidence) → review screen (mockup 04)
  · fast paths run synchronous; the ≤5-min video-transcript tail
    runs async (Durable Functions or queue + status endpoint)
  · URL-hash cache of raw Apify result + parsed recipe → dedupe
    viral reels, cut Apify spend
```

Cross-cutting: Azure Key Vault (secrets), Application Insights (capped), Azure Static Web Apps **free tier** for the web reader + landing page, GitHub Actions for CI/CD (free for the repo).

## 3. Compute choices (settled — cheap and boring)

| Component | Service | Why | Est. cost |
|---|---|---|---|
| API | **Azure Functions, Consumption plan** | 1M executions + 400k GB-s free grant/month; our beta traffic is a rounding error inside that | ~€0 |
| Ingestion jobs | Same Functions app, timer triggers | Nightly, minutes of runtime | ~€0 |
| Import pipeline queue | **Azure Storage Queues** (not Service Bus) | Pennies, no idle cost, at-least-once is fine here | ~€0 |
| Web reader/landing | **Static Web Apps Free** | Free SSL + custom domain | €0 |
| Recipe parsing | **OpenAI API** | Parses the fused import context into the canonical NL recipe schema (`06…` §6); blog/caption prompts are small | usage-based, budget ~€5–10/mo in beta |
| Social scraping + transcription | **Apify actors** via `run-sync-get-dataset-items` (`06…`) | Per-platform metadata/caption + video transcript; single-post, `maxPaidDatasetItems=1`, per-actor `maxTotalChargeUsd` caps | usage-based, budget ~€5–15/mo in beta (video-gated) |

## 4. Budget envelope (illustrative monthly, first ~500 users)

| Item | € |
|---|---|
| Compute (Functions consumption, within free grants) | 0–2 |
| Storage decision (§5) — depending on option | 0–15 |
| Blob storage (images ~10 GB + snapshots, cool tier) | 1–2 |
| Key Vault, Queues, DNS | 1 |
| Application Insights (capped + sampled) | 0–3 |
| OpenAI API (recipe parsing) | 5–10 |
| Apify actors (social scraping/transcription, video-gated + cached) | 5–15 |
| **Total** | **≈ €15–45 → inside €50** |

Headroom is tighter once Apify is in the mix — the URL-hash cache (`06…` §1) and premium-gating video transcription are what keep it under €50. Blog/caption imports are cheap; the video-transcript actors are the swing cost.

## 5. ⚠️ OPEN DECISION — the data store(s)

Two workloads with different shapes:

- **Workload A — app data:** users, recipes (nested JSON documents with ingredients/steps), lists, plans, household sharing, per-user match corrections. Read-heavy, small, needs backup/PITR (spec §A2 data-durability guarantee is P0), needs realtime-ish list sync.
- **Workload B — product catalog:** ~300k rows refreshed nightly, queried by (a) full-text/fuzzy name lookup and (b) **vector similarity** for semantic matching ("passata" ≈ "gezeefde tomaten"). Plus cheap historical price snapshots.

**Fable 5: pick one of these options (or argue a better hybrid), score it against the criteria below, write an ADR.**

### Option 1 — Azure Cosmos DB (NoSQL API), free tier
- **Free forever tier: 1000 RU/s + 25 GB** — genuinely €0 for both workloads at our size (one free-tier account per subscription).
- Documents fit the recipe schema natively; change feed can drive list-sync; **built-in vector search** (DiskANN) now GA covers workload B's embeddings; continuous backup available (7-day PITR tier is free-tier-compatible).
- Cons: RU model needs care (a naive cross-partition fuzzy search burns RUs), no real relational joins, full-text search is weaker than Postgres — fuzzy name matching would lean on our own n-gram field or a client-side index (client-side fuzzy over ~300k rows is demonstrably workable).

### Option 2 — Azure Database for PostgreSQL Flexible Server (B1ms burstable) + pgvector
- One database does everything: relational app data, JSONB for recipe documents, `pg_trgm` for fuzzy product search (excellent), `pgvector` for embeddings, PITR backups built in.
- **The developer-experience favourite** — SQL, one system, no RU mental model, trivially portable off Azure.
- Cons: **no free tier** — B1ms + 32 GB ≈ €13–18/month always-on, the single biggest line item in the budget; still fits, but it *is* a third of the envelope. (Check current promos: Azure has intermittently offered a free-for-12-months B1ms.)

### Option 3 — Azure SQL Database serverless (with the free monthly vCore-seconds offer) 
- Free offer: 100k vCore-seconds + 32 GB/month per subscription; auto-pauses to zero.
- Great relational engine, JSON support decent; **no first-class vector/fuzzy extensions** (vector functions are emerging in Azure SQL, but pgvector/pg_trgm are more mature) — workload B's matching would need to live elsewhere (e.g. in-process index inside the Functions app).
- Cons: cold-start latency after auto-pause (seconds) — noticeable on first app open.

### Option 4 — Table Storage / blob-hosted catalog + small app DB
- Catalog as versioned JSON blobs + an in-memory/precomputed match index inside the API; app data in whichever of options 1–3.
- Nearly free and dead simple; embraces that 300k products is small data.
- Cons: matching quality features (embeddings, learning loop) need a home eventually; this is a stepping stone, not the end state.

### Decision criteria (weigh in this order)
1. **Total monthly cost at 0–500 users** (target: ≤ €15 for storage).
2. **Data durability & PITR out of the box** (spec §A2 is P0).
3. **Fit for the matching engine** — fuzzy text + vectors without adding Azure AI Search (whose vector tiers blow the budget).
4. **Operational simplicity for a solo/small team** (fewer systems > theoretically ideal systems).
5. **Portability** (if we outgrow Azure credits or renegotiate, how sticky is it?).

### Non-binding steer (from a professional app-dev perspective)
- If minimising cost and staying serverless end-to-end: **Option 1 (Cosmos free tier)**, accepting DIY fuzzy search.
- If prioritising matching-engine quality and developer velocity, and accepting ~€15/month: **Option 2 (Postgres + pgvector + pg_trgm)** — one boring database that does everything this product needs for years.

**Do NOT choose:** Azure AI Search (overkill/price), provisioned Cosmos (price), MongoDB Atlas on Azure (extra vendor), running a DB in a VM (ops burden).

## 6. Other fixed technical decisions

- **Secrets** never in code — Key Vault + managed identities. At minimum: `APIFY_API_TOKEN`, `OPENAI_API_KEY`, storage/DB connection strings, OAuth client secrets. The `import-recipe` Function reads Apify + OpenAI keys from Key Vault (`06…` §0).
- **Infra as code** from day one — Bicep (or Terraform), one `azd up`-style deployment; resource group per environment (`prakkie-dev`, `prakkie-prod`).
- **Backups:** whatever store is chosen: PITR on; plus a nightly logical export to Blob (immutable container) — the €0.02/month that saves the company.
- **Auth tokens:** short-lived JWTs; refresh via the identity provider; household sharing modelled as a `household_id` claim.
- **Realtime list sync (spec K2):** start with polling/long-poll (cheap); upgrade to Azure Web PubSub free tier (20 connections) or SignalR free tier when check-off latency matters.
- **Media:** recipe images resized server-side to ≤ 200 KB webp before blob write; originals discarded (privacy + cost).
- **Observability:** App Insights with 5% sampling + daily cap; one workbook: imports attempted/succeeded, match confidence distribution, per-chain ingestion freshness.
