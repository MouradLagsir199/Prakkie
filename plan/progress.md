# Prakkie — Build Progress

> The living tracker. Tick items as they land; keep this file honest — an item is only checked when its acceptance criterion (see [`05_workstreams.md`](05_workstreams.md)) is demonstrably met.
> **Status legend:** unchecked = not started/in progress · checked = done & verified.

## Decisions & ADRs

- [x] D1 storage decided — PostgreSQL Flexible Server B1ms (ADR-0001, [`02_adr-0001-storage.md`](02_adr-0001-storage.md))
- [x] D2 client decided — React Native + Expo (TypeScript)
- [x] D3 backend decided — 2× Azure Functions Consumption + Durable Functions video tail
- [x] D4 repo layout decided — pnpm monorepo
- [x] Plan approved by owner
- [x] ADR files committed to `docs/adr/` (0001 storage, 0002 bicep, 0003 two apps, 0004 auth) — commit `b16f81c`

## WS0 — Foundations (infra, auth, Key Vault)

- [x] `.gitignore` (secrets.txt, .env*, local.settings.json, .azure/) as the **first commit** (root commit `48b98b6`; `secrets.txt` verified ignored) — pre-commit no-secrets hook still to add with the scaffold
- [x] Monorepo scaffold (pnpm workspaces; apps/mobile, services/functions-api+ingest with healthz, packages/shared+matching; typecheck + tests green) — commit `b16f81c`. Still to scaffold: apps/web, infra/, .github/workflows
- [x] Design tokens from docs/04 §1 → `apps/mobile/src/theme/tokens.ts` (verbatim values)
- [ ] Bicep: main.bicep + modules (postgres, storage, keyvault, functions ×2, monitoring, staticwebapp, budget)
- [ ] `scripts/setup-secrets` (no-echo Key Vault load) written & run for dev
- [ ] `scripts/deploy -Env dev` produces the full dev environment; `healthz` 200
- [ ] Custom JWT auth: Apple, Google, email, guest — all four yield accepted JWTs
- [ ] Guest → account upgrade preserves user id
- [ ] CI skeleton (pr.yml: lint, typecheck, test, gitleaks) green
- [ ] EAS project + build profiles stub
- [ ] Budget alerts 50/80/100% live

## WS1 — Data model, sync, durability, GDPR (P0)

- [ ] zod schemas in `packages/shared` (Recipe B8, Product, List, Plan, Pantry, Household, User, MatchCorrection)
- [ ] SQL migrations: schemas `app`/`catalog`/`discovery` per [`04_data-model.md`](04_data-model.md), extensions enabled
- [ ] `/v1` CRUD: recipes, lists, plans, user-settings
- [ ] `sync-pull` delta endpoint + push with LWW-per-field-group
- [ ] Mobile offline cache (expo-sqlite) + mutation queue
- [ ] Nightly `pg_dump` timer → immutable `db-backups` container
- [ ] **PITR restore drill to −1 h passed**
- [ ] GDPR export: one-tap, complete, re-importable archive
- [ ] Account delete with 30-day grace + purge job
- [ ] Recipe survives sign-out / reinstall / platform-switch test

## WS2 — 11-chain ingestion + matching engine (core moat)

- [ ] `ChainConnector` interface + shared pipeline (snapshot → parse → hash → delta upsert)
- [ ] Aisle taxonomy (~20 groups) + per-chain ordering profiles seeded
- [ ] Connector: AH (anchor — taxonomy + Bonus mechanics)
- [ ] Connector: Jumbo (validates interface end-to-end)
- [ ] Connector: Detailresult (ONE connector → Dirk + DekaMarkt)
- [ ] Connector: Plus
- [ ] Connector: Vomar
- [ ] Connector: Hoogvliet
- [ ] Connector: Spar
- [ ] Connector: Ekoplaza
- [ ] Connector: Aldi (partial coverage → "n items niet in assortiment" path)
- [ ] Connector: Picnic (last; kill-switched from day one; pending owner decision #7)
- [ ] Per-chain kill switch + dynamic "prijzen van {datum}" staleness in API
- [ ] Seed lexicon (~500 NL ingredient↔SKU pairs)
- [ ] `packages/matching`: E1 normaliser (el/tl/snufje, fractions, ranges, "naar smaak")
- [ ] Matcher: lexicon → pg_trgm → pgvector → rules, confidence + shortlist
- [ ] Pack-size reconciliation ("pakt precies", restje)
- [ ] Embedding pipeline (delta-only, vector(512))
- [ ] **Match eval ≥90% top-1 on labelled set** (`scripts/match-eval`)
- [ ] Nightly refresh proven: kill one chain mid-run, other ten stay fresh

## WS3 — Import pipeline (docs/06 verbatim port)

- [ ] `runApifyActor()` wrapper (maxPaidDatasetItems=1, per-actor maxTotalChargeUsd, 120 s)
- [ ] `detectPlatform()` + `LinkContext` builder + `hasUsableRecipeSignal()` + 422/503 semantics
- [ ] Instagram path (3 metadata actors + 2 transcript actors, exact fallback ladder)
- [ ] TikTok path (oEmbed + universal transcript actor)
- [ ] Facebook path (post scraper + universal transcript)
- [ ] Pinterest path (pin scraper + captions + direct-media transcript, cost guards 1.00/0.25)
- [ ] YouTube (metadata-only, per docs/06 §4.5) + blog JSON-LD path
- [ ] Shared JSON-LD extractor in `packages/shared` (reused by WS7)
- [ ] `parseRecipe(context) → Recipe` OpenAI seam (bosui rule, no invented quantities, missingFields, Dutch tags)
- [ ] Durable Functions async video tail (202 + importId + `GET /import/{id}`)
- [ ] URL-hash Blob cache (re-import = €0, instant)
- [ ] Photo/OCR import (multi-photo) + text paste → same seam
- [ ] Import golden set + `scripts/import-eval`
- [ ] **≥95% blog/caption, ≥85% video field accuracy on golden set**
- [ ] **<3 s blog/caption; <15 s common video**

## WS4 — App shell, 5 tabs, library, cook mode + plumbing

- [x] App shell: 4-tab floating pill bar + green FAB (docs/04 §2) — Expo SDK 57, expo-router tabs, Young Serif + Instrument Sans loaded; verified via `expo export` (all routes bundle)
- [x] Recepten library first version on fixture data (mockup 01: header/search/chips/sort/2-col grid, Bonus-tip + price pills) — pixel review + real data pending
- [x] Import sheet skeleton (title, 4 options, share-sheet footer) — clipboard-detection card + live flow pending (WS3/WS4)
- [ ] Onboarding (A3: 11-chain multi-select, language/units, household size, first-import aha)
- [ ] Recepten library grid = mockup 01 (incl. `RecipeCardGrid` as reusable prop-driven component)
- [ ] Filter/sort = mockup 02 (exact sort list, alle/één-van ingredient filter)
- [ ] Import sheet = mockup 03 (clipboard card, 4 options, share-sheet footer)
- [ ] Import review = mockup 04 (confidence chips, provenance hints, "Bewaar in Mijn recepten")
- [ ] Recipe detail + serving scaler + add-to-list/plan (D1/D2/D4)
- [ ] Cook mode: keep-awake, large text, auto-detected tappable timers (D3)
- [ ] Share extension (iOS) / share intent (Android) via expo-share-intent — one tap to review screen
- [ ] Clipboard link detection on foreground
- [ ] Deep/universal links claimed (`prakkie://`, `https://prakkie.nl/r/{id}`)
- [ ] Accessibility pass (VoiceOver/TalkBack, high contrast)
- [ ] Mockups re-exported "Bordje" → "Prakkie"
- [ ] First EAS builds on TestFlight / Play Internal (share extension included early)
- [ ] Owner pixel-review of each screen vs mockup

## WS5 — Smart list + price comparison + Bonus

- [ ] `list-generate` (from recipes/plan, scaled) · `list-price` · `basket-compare` · `deals-for-list`
- [ ] Multiple named lists + "+ Nieuw" (G5)
- [ ] Aisle-grouped Lijst tab per mockup 06 (editable/reorderable categories, item moves)
- [ ] Duplicate merge with provenance ("samengevoegd: shakshuka (1) + nasi (2)")
- [ ] Bonus strikethrough, huismerk-tip, pack-fit lines
- [ ] Check-off + sync (G8) · sticky footer + cheaper-elsewhere teaser
- [ ] Prijzen tab per mockup 07 (ranked chains, voordeligst/jouw winkel, honest gaps, dynamic staleness)
- [ ] Insight card naming driving items (F4) · deal rows with mechanics · "Koken met aanbiedingen" rail
- [ ] Price-per-portion badges on library cards (F1)
- [ ] Match-fix shortlist UX → corrections stored (E5 feed)
- [ ] **List pricing < 2 s p95 (25 items)**

## WS6 — Meal planner + live plan↔list sync

- [ ] Planner per mockup 05 (week switcher, MA–ZO rows, servings + p.p. + Bonus context)
- [ ] Drag-and-drop incl. "Zonder datum" strip (+ long-press a11y fallback)
- [ ] Multi-week view (H2) · templates save/apply (H4)
- [ ] "Boodschappenlijst maken · n gerechten" → list-generate (H5)
- [ ] **Live link (G4): plan-owned lines re-derive; manual lines never clobbered**

## WS7 — Discovery crawler + Ontdek

- [ ] Config-driven crawler framework (one config per site, zero per-site code)
- [ ] 9 source configs: Allerhande, Jumbo, Plus, Smulweb, Leukerecepten, Lekker en Simpel, Uit Paulines Keuken, 24Kitchen, Voedingscentrum
- [ ] JSON-LD extractor reused from WS3 · validator rejects incomplete
- [ ] Cross-site dedup + dead-link prune + per-domain blocklist (same-day)
- [ ] Price-per-portion precompute reusing `packages/matching`
- [ ] Ranking v1: deal overlap > diet flags > season > price p.p.
- [ ] Ontdek segment UI (reuses RecipeCardGrid + attribution line) — **after owner sign-off (input #13)**
- [ ] Save-from-Ontdek → mockup-04 review screen → Mijn recepten
- [ ] "ook in Ontdek zoeken" search scope (N4)
- [ ] Detail display depth behind config flag (pending legal, input #12)

## WS8 — Pantry + nutrition

- [ ] Pantry inventory screen (manual, from-purchases, optional barcode)
- [ ] Cook-from-pantry over own library, ranked by fewest missing
- [ ] Pantry-aware list toggle (G6), reversible per line
- [ ] Waste nudges from pack leftovers (I3)
- [ ] Nutrition per serving (matched products + NEVO fallback) + diet filters; honest "geen voedingsdata"

## WS9 — Household, web companion, cart handoff, learning loop

- [ ] Households: shared library/lists/plans, deep-link invites, JWT claim, member management
- [ ] Live check-off via Web PubSub free tier (<2 s propagation)
- [ ] Recipe share links → one-tap import (K3)
- [ ] Web companion (read/organise) on Static Web Apps
- [ ] Cart handoff: AH deep-links, Jumbo second, "kopieer lijst" fallback; affiliate slot behind config
- [ ] Learning loop: overrides at match time + nightly consensus promotion; CI-gated non-regression

## WS10 — Monetisation, notifications, launch

- [ ] RevenueCat integration (pending input #11): subscription + lifetime SKU, server-side entitlements
- [ ] Premium gates wired (video quota, OCR, comparison, nutrition, household, pantry) — free tier never touches stored data
- [ ] Purchase / restore / cancel verified in both store sandboxes
- [ ] Push notifications (opt-in): "Je Bonus-lijst is klaar" + weekly plan reminder
- [ ] Ops workbook + Apify/OpenAI spend alerts live
- [ ] 500-user load sanity vs €50 envelope
- [ ] Store listings, NL privacy policy, GDPR docs
- [ ] Legal reviews done: (a) product data, (b) feed display depth

## Inputs from owner (see [`10_inputs-needed.md`](10_inputs-needed.md))

- [ ] 1 · Azure subscription ID + RG naming sign-off
- [ ] 2 · Deploy identity (az login / OIDC service principal)
- [ ] 3 · Apple Developer + Google Play accounts
- [ ] 4 · Apple/Google OAuth client IDs + secrets
- [ ] 5 · Apify account/actors confirmed
- [ ] 6 · OpenAI org + hard limit + model tier
- [ ] 7 · Picnic account decision
- [ ] 8 · Domain (prakkie.nl)
- [ ] 9 · Prijzen-tab chain set confirmed
- [ ] 10 · Mockups re-exported to "Prakkie"
- [ ] 11 · RevenueCat vs direct billing
- [ ] 12 · Legal advice budget approved
- [ ] 13 · Ontdek screen sign-off
