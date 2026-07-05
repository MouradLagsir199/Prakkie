# Workstreams (dependency-ordered; every module A–N lands)

NL-first is not a later pass: each workstream ships its Dutch strings, comma-decimal formatting and docs/04 tokens with its screens. Tick deliverables off in [`progress.md`](progress.md).

## WS0 — Foundations: infra, auth, Key Vault *(modules: infra, A1)*
Monorepo scaffold (tree in `01_decisions.md` D4) · `infra/` Bicep per `06_iac.md` incl. budget alerts · `.gitignore` + `scripts/setup-secrets` first · Key Vault secrets by name only · **custom JWT auth** (Apple/Google/email/guest; guest→account upgrade preserves user id) · CI skeleton + EAS stub · ADRs 0001–0004 recorded.
**Depends:** nothing. **Parallel:** mockup-token extraction into `theme/tokens.ts` from day 1.
**Accept:** clean-subscription deploy produces dev env, `healthz` 200; all four sign-in modes yield accepted JWTs; CI grep/gitleaks gate proves no secret values anywhere; idle cost ≤ €20/mo.

## WS1 — Data model, sync, durability & GDPR export *(A2, A4, M2 — P0)*
`packages/shared` zod schemas (Recipe B8, Product, List/Plan/Pantry/Household/User/MatchCorrection) shared verbatim client↔server · SQL migrations for `04_data-model.md` · `/v1` CRUD functions (recipes, lists, plans, user-settings) + `sync-pull` · expo-sqlite cache + mutation queue · nightly `pg_dump` timer + **PITR restore drill** · `export-gdpr` + `delete-account`.
**Depends:** WS0. **Parallel:** WS2 connector spikes, WS4 static screens on fixtures.
**Accept:** recipe survives sign-out, reinstall, simulated iOS→Android switch; airplane-mode edit syncs; PITR drill to −1 h succeeds; export delivers a complete re-importable archive in one tap.

## WS2 — 11-chain ingestion + matching engine *(E — core moat)*
**Single `ChainConnector` interface** (`fetchCatalog(): AsyncIterable<Product>` + capability flags: promos, EANs, deep-links, coverage) — pipeline, snapshotting, delta-hashing, staleness written **once**. **Build order:** ① AH (anchors aisle taxonomy + Bonus mechanics) ② Jumbo (validates interface end-to-end) ③ **Detailresult = ONE connector, TWO chains (Dirk + DekaMarkt)** ④ Plus/Vomar/Hoogvliet/Spar/Ekoplaza (near-mechanical; agent lane) ⑤ Aldi (partial coverage → exercises "n items niet in assortiment") ⑥ **Picnic last** (account-bound, highest ToS risk, behind its kill switch from day one). Per-chain kill switch + dynamic staleness surface. Aisle taxonomy (~20 groups + per-chain profiles) as seeded data — **shared by list sort (G3) and product categorisation (E2)**. `packages/matching`: E1 normaliser (el/tl/snufje, fractions, ranges, "naar smaak", NL+EN) → lexicon hint → pg_trgm fuzzy → pgvector semantic → rules; pack-size reconciliation ("pakt precies") · confidence + shortlist fallback · per-user override hook (E5). Seed lexicon ~500 curated NL pairs + `scripts/match-eval`.
**Depends:** WS0 (WS1 schema for the store; fixtures unblock earlier). **Parallel:** WS3, WS4 entirely; connectors ④–⑥ parallel with WS5.
**Accept:** all 11 refresh nightly; killing one chain mid-run leaves ten fresh; **≥90% top-1** on the labelled set with shortlist fallback below threshold; "passata"→"gezeefde tomaten"; deltas < 5% of rows on a typical night.

## WS3 — Import pipeline *(B1–B7 — port docs/06 verbatim)*
`import-recipe` (detectPlatform, LinkContext, `hasUsableRecipeSignal`, 422/503) — **a port of the owner's TS prototype, not a rewrite** · `runApifyActor()` wrapper (`run-sync-get-dataset-items`, `format=json&clean=true`, `maxPaidDatasetItems=1` always, per-actor `maxTotalChargeUsd`, 120 s default) · **actor IDs + inputs verbatim:** `apify~instagram-reel-scraper`, `apify~instagram-scraper`, `apify~instagram-post-scraper`, `S9A11NvceWaGorwwh`, `CVQmx5Se22zxPaWc1`, `KoJrdxJCTtpon81KY`, `tseqJicQpIxyFdHNB`, `VZTENHFJOyJEGIKCv`, with their exact input JSON and fallback ladders per platform · **`parseRecipe(context) → Recipe`** thin OpenAI seam (bosui rule, no invented quantities, `missingFields`, Dutch tags) · **shared JSON-LD extractor in `packages/shared`** (built here; reused unchanged by WS7) · Durable async tail (202 + importId + polling) · URL-hash Blob cache · photo/OCR (B5, multi-photo) + text paste (B6) as extra `LinkContext` producers into the same seam · quota table hook (gated in WS10) · `scripts/import-eval` golden set.
**Depends:** WS0, WS1 (Recipe schema). **Parallel:** WS2 completely; WS4 (review screen builds on fixtures).
**Accept:** spec §18 on the golden set — **≥95% blog/caption, ≥85% video** field accuracy; **<3 s blog/caption, <15 s common video**; re-import of a cached URL = €0 Apify + instant; a reel that only *talks about* a recipe yields `missing_fields`, never hallucinated quantities; Apify token never reachable from the client.

## WS4 — App shell, 5 tab screens, library, cook mode + platform plumbing *(A3, C, D, M4)*
Screen → mockup mapping: shell/tab bar + FAB = docs/04 §2 · `(tabs)/recepten` = `01_Recepten_bibliotheek.html` · filter/sort = `02_Recepten_filter.html` · import sheet = `03_Import_sheet.html` · review = `04_Import_controleer.html` · plannen/lijst/prijzen shells = mockups 05/06/07 (filled by WS6/WS5) · detail + cook mode + onboarding = tokens-only. **`RecipeCardGrid` built prop-driven now** (optional attribution line) — reused one-for-one by Ontdek (WS7). Library: collections, tags/auto-tags, FTS search, the exact mockup-02 sort list + ingredient filter with alle/één-van, notes, source preservation. Cook mode: `expo-keep-awake`, large text, auto-detected tappable timers, serving scaler, VoiceOver/TalkBack pass. **Plumbing:** `expo-share-intent` share extension/intent (B1 primary path) · clipboard detection (mockup 03 card) · deep/universal links (`prakkie://recept/{id}`, `https://prakkie.nl/r/{id}` — claim associated domains now) · offline cache/queue wiring · EAS profiles + TestFlight/Play Internal from day one. Re-export mockups "Bordje"→"Prakkie" during shell build.
**Depends:** WS0, WS1; WS3 endpoints (fixtures decouple). **Parallel:** WS2, WS3.
**Accept:** owner pixel-review per mockup (tokens, Young Serif/Instrument Sans, `€ 1,85 p.p.` comma formatting exact); share from IG/TikTok/Safari → review screen in one tap on both OSes; screen never sleeps in cook mode; guest completes first import before any account prompt.

## WS5 — Smart shopping list + price comparison + Bonus *(F, G)*
Functions: `list-generate` (G1), `list-price` (G7), `basket-compare` (F2), `deals-for-list` (F3), multi-list CRUD (G5). Lijst tab (mockup 06): list tabs + "+ Nieuw" · "AH-indeling" chip from the **shared WS2 taxonomy**, editable/reorderable categories (G3) · duplicate merging with provenance (G2) · Bonus strikethrough, huismerk-tip, pack-fit lines · check-off sync (G8) · sticky footer + "€ 4,20 goedkoper bij Jumbo" teaser. Prijzen tab (mockup 07): ranked chains, "voordeligst"/"jouw winkel", honest partial coverage, **dynamic staleness header**, insight card that **names driving items** (F4), deal rows with mechanics, "Koken met aanbiedingen" rail. F1 price badges wired back into library cards. Match-fix UX: tap product → shortlist → correction stored (feeds E5).
**Depends:** WS2 (AH+Jumbo suffice to start), WS4, WS1. **Parallel:** WS2 connectors ④–⑥, WS6 scaffolding.
**Accept:** **list pricing < 2 s** p95 for 25 items across selected chains; every mockup-06 line variant reproduced with real data; no fake totals for partial chains; catalog outage degrades to staleness labels while recipe features keep working (§18 resilience).

## WS6 — Meal planner + live plan↔list sync *(H, G4)*
Planner per mockup 05: week switcher (multi-week, H2) · MA–ZO rows with **drag-and-drop** (gesture-handler + reanimated; long-press fallback for a11y) · per-dish servings + p.p. + inline Bonus context · "Zonder datum" strip (H3) · templates save/apply (H4) · bottom CTA → WS5 `list-generate` (H5). **Live link (G4), the hardest logic:** plan-derived lines are owned by the plan and re-derived on plan mutation; manual lines are never touched — delta merge, never regenerate-and-clobber. Add-to-plan from detail (D4).
**Depends:** WS5, WS4. **Parallel:** WS7 backend, remaining connectors.
**Accept:** servings change or recipe swap updates the linked list with no manual re-add; manual additions survive plan edits; drag-and-drop incl. undated strip works on both platforms; template re-apply fills a week in one tap.

## WS7 — Discovery crawler + Ontdek *(N)*
**Config-driven crawler: one YAML/JSON per site, zero per-site code** — the nine docs/05 sources are nine config files · **reuses WS3's JSON-LD extractor unchanged** · validator rejects incomplete · corpus per `04_data-model.md` §3 with attribution + dedup · raw HTML → cool Blob 30 d · dead-link prune · **price-per-portion precompute reusing `packages/matching`** (the badge no source site can copy) · ranking v1: deal overlap > diet flags > season > price p.p. ascending · **Ontdek UI:** "Mijn recepten / Ontdek" segment in the Recepten tab (nav unchanged), **reuses `RecipeCardGrid`** + muted "via Leukerecepten" line, optional "Koken met aanbiedingen" rail, detail with "Bekijk op {site}" link-out; **save reuses the mockup-04 review screen** (same B2/B7 pipeline) · feed shows title+image+badges+attribution only; detail display depth behind a config flag defaulting to minimal (pending legal advice) · per-domain blocklist effective same day · "ook in Ontdek zoeken" (N4) · **owner sign-off on the Ontdek screen before build** (docs/04 §4).
**Depends:** WS3 (extractor, review flow), WS2 (pricing), WS4 (grid). **Parallel:** WS6, WS8.
**Accept:** nine sources crawl weekly inside politeness rules (≤1 req/s, PrakkieBot UA, robots honoured); adding a source = one config file; feed never shows prose/steps; blocklist same-day.

## WS8 — Pantry + nutrition *(I, J — parity, kept simple)*
Pantry screen (tokens-only): manual add, add-from-checked-purchases, optional barcode via `expo-camera` + WS2 EANs (I1) · cook-from-pantry over the **user's own library** ranked by fewest missing items (I2) · pantry-aware list toggle (G6) · waste nudges from pack-leftover data (I3) · nutrition per serving from matched products with NEVO-table fallback (J1) + diet-flag filters (J2). Honesty rule: absent data shows "geen voedingsdata", never fake numbers.
**Depends:** WS2, WS5, WS4. **Parallel:** WS7, WS9.
**Accept:** pantry subtraction is reversible per line; cook-from-pantry lists missing items one-tap addable; nutrition degrades honestly.

## WS9 — Household, web companion, cart handoff, learning loop *(K, L, M5, E5)*
Households: `household_id` on library/lists/plans, deep-link invites, JWT claim, member management (K1) · realtime check-off: tightened polling → **Web PubSub free tier** dirty-ping when latency annoys (K2) · recipe share links `https://prakkie.nl/r/{id}` → one-tap import (K3) · **web companion** on Static Web Apps: read/organise library + list viewer against the same `/v1`, shared zod types (M5) · cart handoff as a `cartHandoff` capability on `ChainConnector` — AH deep-links first, Jumbo second, others "kopieer lijst" fallback; never payment/fulfilment (L1/L2); affiliate parameter slot behind config (open owner decision) · **learning loop (E5):** per-user overrides at match time + nightly aggregation promotes consensus corrections into the lexicon; match-eval re-run in CI proves non-regression.
**Depends:** WS1, WS5, WS2, WS4. **Parallel:** WS8, WS10.
**Accept:** two members check off one list live (<2 s with PubSub); web reader shows library read-only with docs/04 look; AH handoff lands products in an AH basket flow, others degrade honestly; aggregated corrections improve the eval score, CI-gated.

## WS10 — Monetisation, notifications, hardening, launch *(M3, spec §20)*
**IAP via RevenueCat** (one cross-platform SDK, server-side receipts, webhooks into `subscriptions`; avoids two native billing stacks solo) · gates per spec §20: premium = video imports (WS3 quota), OCR, cross-chain comparison, nutrition, household, pantry intelligence; **free tier never touches stored data**; lifetime one-time purchase alongside subscription; honest trial; no ads for payers ever · push notifications (Expo push, opt-in, exactly two v1: "Je Bonus-lijst is klaar" + weekly plan reminder; per-type toggles) · hardening: workbook + spend alerts live, 500-user load sanity vs €50, store assets, NL privacy policy, both legal reviews queued.
**Depends:** WS3/WS5/WS8/WS9 (the gated features). **Parallel:** tails of WS8/WS9.
**Accept:** cancelling premium never hides/deletes stored recipes (docs/00 rule 5); purchase/restore/cancel work in both store sandboxes incl. lifetime SKU; projected steady-state cost ≤ €50 on the workbook.

## Critical path & parallel lanes

```
WS0 → WS1 → WS2(AH+Jumbo slice) → WS5 → WS6 → WS10        ← the product spine
                                          WS9 (learning loop) merges before WS10
WS3 ∥ WS2   ·   WS4 ∥ WS2/WS3 (fixtures decouple)   ·   WS7 needs WS3+WS2+WS4
```

**Three lanes (four briefly at peak)** — more is counterproductive; the solo dev is the review bottleneck and WS2/WS5 correctness needs human judgment:

| Phase | Lane 1 (owner-led: risk/judgment) | Lane 2 (agent-friendly: patterned code) | Lane 3 (agent-friendly: UI from contracts) |
|---|---|---|---|
| 1 | WS0 infra + auth | WS1 schemas/migrations | tokens + static screens on fixtures |
| 2 | WS2 AH/Jumbo + matching core | WS3 port (verbatim spec = ideal agent task) | WS4 screens + plumbing |
| 3 | WS5 pricing/comparison logic | WS2 connectors ④–⑥ (assembly line) | WS6 planner UI |
| 4 | WS9 learning loop + cart handoff | WS7 crawler (config-driven) | WS8 pantry/nutrition UI |
| 5 | WS10 IAP + launch legal/ops | WS9 web companion | polish + accessibility pass |
