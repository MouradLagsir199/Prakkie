# Prakkie — Build Progress

> The living tracker. Tick items as they land; keep this file honest — an item is only checked when its acceptance criterion (see [`05_workstreams.md`](05_workstreams.md)) is demonstrably met.
> **Status legend:** unchecked = not started/in progress · checked = done & verified.
> **Verification:** `scripts/e2e-smoke.mjs` runs the full live suite against dev (27 checks: spine + WS7/8/9) — green as of 2026-07-06.
> **Owner-scoped out (2026-07-06):** payments/IAP and Apple/Google sign-in.

## Decisions & ADRs

- [x] D1 storage decided — PostgreSQL Flexible Server B1ms (ADR-0001, [`02_adr-0001-storage.md`](02_adr-0001-storage.md))
- [x] D2 client decided — React Native + Expo (TypeScript)
- [x] D3 backend decided — 2× Azure Functions Consumption + queue-based video tail (deviation: storage queue i.p.v. Durable, zelfde 202+poll contract)
- [x] D4 repo layout decided — pnpm monorepo
- [x] Plan approved by owner
- [x] ADR files committed to `docs/adr/`

## WS0 — Foundations (infra, auth, Key Vault)

- [x] `.gitignore` + pre-commit no-secrets hook (verified blocking)
- [x] Monorepo scaffold; apps/web now exists; infra/ + workflows skeleton
- [x] Design tokens from docs/04 §1 → `apps/mobile/src/theme/tokens.ts`
- [x] Bicep: full dev env deployed (PG in northeurope — subscription offer restriction; rest westeurope)
- [x] `scripts/setup-secrets` — all secrets incl. Apify/OpenAI now in `kv-prakkie-dev`
- [x] `scripts/deploy -Env dev` → healthz 200 both apps + SWA web deploy wired
- [x] Custom JWT auth: email + guest end-to-end (Apple/Google 501 — **descoped by owner**)
- [x] Guest → account upgrade preserves user id (verified live)
- [ ] CI skeleton (pr.yml) — written; needs a GitHub remote to run
- [ ] EAS project + build profiles (needs owner input #3: store accounts)
- [x] Budget alerts 50/80/100% live

## WS1 — Data model, sync, durability, GDPR (P0)

- [x] zod schemas in `packages/shared`
- [x] SQL migrations 0001–0011 applied to dev (idempotent runner in deploy)
- [x] `/v1` CRUD: recipes, lists, plans, user-settings
- [x] `sync-pull` delta + push with LWW-per-field-group (unit + live smoke)
- [x] Mobile offline cache (expo-sqlite) + mutation queue — shared `OfflineEngine` (9 tests) + live smoke 8/8
- [ ] Nightly `pg_dump` timer → immutable `db-backups` container — **deferred by owner** (0007 role staged)
- [ ] **PITR restore drill** — **deferred by owner** (`scripts/pitr-drill.mjs` ready)
- [ ] GDPR export / account delete — **deferred by owner**
- [x] Recipe survives sign-out / reinstall / platform-switch — protocol level proven live (fresh install pulls full account); in-app pass needs EAS build

## WS2 — 11-chain ingestion + matching engine (core moat)

- [x] `ChainConnector` interface + shared pipeline (bronze JSONL → parse → hash → delta upsert → price history → availability sweep) — owner's Python scrapers adopted as fetch layer (curl_cffi anti-bot needs Python; documented deviation)
- [x] Aisle taxonomy (20 groups) + AH ordering profile seeded
- [x] Connector: AH (anchor — Bonus mechanics, unit price, pack size)
- [x] Connector: Jumbo (cents pricing verified against real bronze)
- [x] Connector: Detailresult → Dirk (DekaMarkt has NO shared gateway — needs own scraper, see below)
- [x] Connector: Plus (OutSystems payloads)
- [ ] Connector: Vomar — no scraper yet (reverse-engineering pending)
- [ ] Connector: Hoogvliet — no scraper yet
- [x] Connector: Spar (JSON-LD + HTML sections; price coverage honestly partial)
- [ ] Connector: Ekoplaza — no scraper yet
- [x] Connector: Aldi (partial coverage → honest-gaps path)
- [ ] Connector: Picnic (kill-switched from day one; pending owner decision #7)
- [x] Per-chain kill switch (ingest refuses disabled chains) + staleness in API (`last_ingest_at` → "prijzen van {datum}")
- [x] Seed lexicon — 230 curated NL entries w/ aliases (0009); grows via E5 loop
- [x] E1 normaliser (el/tl/snufje, fractions, ranges, "naar smaak", NL+EN) — 23 tests
- [x] Matcher: corrections → lexicon → canonical-bridge → pg_trgm + rules; confidence + shortlist (pgvector seam open — needs embeddings)
- [x] Pack-size reconciliation ("pakt precies", fractional cost)
- [ ] Embedding pipeline (vector(512)) — seam built, awaits OpenAI embedding budget decision
- [x] **Match eval 93.0% top-1** on 92-item labelled set (target ≥90%) — `scripts/match-eval.mjs`
- [ ] Nightly refresh automation — pipeline + trigger live (`ops/catalog-ingest`); scheduled scraper runs need a place to run Python nightly (owner: local/CI/container)
- [x] Dev catalog seeded: **86,439 products, 6 chains** + 78,924 AI-canonical names from owner's dump

## WS3 — Import pipeline (docs/06 verbatim port)

- [x] `runApifyActor()` wrapper (run-sync-get-dataset-items, maxPaidDatasetItems=1, per-actor maxTotalChargeUsd, 120 s)
- [x] `detectPlatform()` + LinkContext + `hasUsableRecipeSignal()` + 422/503 semantics (live-verified: listing page → 422)
- [x] Instagram path (3 metadata actors + 2 transcript actors, exact ladder)
- [x] TikTok path (oEmbed + universal transcript)
- [x] Facebook path (post scraper + universal transcript)
- [x] Pinterest path (pin scraper + captions + direct-media, cost guards 1.00/0.25)
- [x] YouTube metadata-only + blog JSON-LD path
- [x] Shared JSON-LD extractor in `packages/shared` (control-char hardened; reused by WS7)
- [x] `parseRecipe(context) → Recipe` OpenAI seam (bosui rule, no invented quantities, missingFields, NL tags; zod-validated w/ retry)
- [x] Async video tail: 202 + importId + `GET /v1/import/{id}` via storage queue (deviation vs Durable noted)
- [x] URL-hash blob cache — live: re-import = 137 ms, €0
- [ ] Photo/OCR import + text paste → same seam (import sheet shows "binnenkort")
- [ ] Import golden set + `scripts/import-eval` accuracy gates — live spot-checks green (5.5 s blog, 13 ing/7 steps); formal golden set pending
- [x] Live e2e: real blog import verified end-to-end incl. cache + honest failures

## WS4 — App shell, 5 tabs, library, cook mode + plumbing

- [x] App shell: 4-tab pill bar + FAB, fonts, tokens
- [x] Recepten library on the LIVE offline cache (search/tags/sort) + Ontdek segment
- [x] Import sheet live: clipboard-detection card, link input, 202 polling, foutafhandeling
- [x] Onboarding A3: chain multi-select ("jouw winkel"), household size, first-import aha
- [ ] Pixel-parity pass vs mockups 01–07 (owner review) — functional versions live, RecipeCardGrid prop-driven & reused by Ontdek
- [x] Import review = mockup 04 flow (confidence chips, provenance, missing-fields honesty, Bewaar)
- [x] Recipe detail + serving scaler + add-to-list/plan (D1/D2/D4)
- [x] Cook mode: keep-awake, large text, auto-detected tappable timers (D3)
- [ ] Share extension / share intent (expo-share-intent) — needs EAS dev build (input #3)
- [x] Clipboard link detection on open of import sheet
- [ ] Deep/universal links claimed — `prakkie://` scheme set; universal links need domain (input #8)
- [ ] Accessibility pass (VoiceOver/TalkBack)
- [ ] Mockups re-exported "Bordje" → "Prakkie" (owner, input #10)
- [ ] First EAS builds on TestFlight / Play Internal (input #3)
- [ ] Owner pixel-review per screen

## WS5 — Smart list + price comparison + Bonus

- [x] `list-generate` (G1, scale+merge+provenance+aisle; pantry-aware G6) · `list-price` (G7, pack-fit) · `basket-compare` (F2) · `deals-for-list` (F3)
- [x] Multiple named lists + "+ Nieuw" (G5)
- [x] Aisle-grouped Lijst tab (categories via taxonomy; reorder/move pending polish)
- [x] Duplicate merge with provenance ("samengevoegd: …")
- [ ] Bonus strikethrough/huismerk-tip/pack-fit UI lines — backend fields live; seeded snapshot has no promo data (fresh scrape run fills them)
- [x] Check-off + sync (G8) · sticky footer + cheaper-elsewhere teaser
- [x] Prijzen tab (ranked chains, voordeligst/jouw winkel, honest gaps, staleness, F4 insight w/ driving items)
- [ ] "Koken met aanbiedingen" rail (needs promo data)
- [x] Price-per-portion badges (F1) via nightly precompute → `recipes.price_cache`
- [x] Match-fix corrections stored + instantly win (live-verified E5 tier 1)
- [x] **List pricing 1.8–2.0 s live for 11–13 items × 6 chains** (target <2 s p95 warm)

## WS6 — Meal planner + live plan↔list sync

- [x] Planner: week switcher, MA–ZO rows, per-dish servings + p.p., "Zonder datum" strip (H3)
- [x] Move dish via tap-day-picker (a11y-first; gesture drag-and-drop = polish item)
- [x] Multi-week view (offset switcher, H2)
- [ ] Templates save/apply (H4)
- [x] "Boodschappenlijst maken · n gerechten" → list-generate met replace_generated (H5)
- [x] Live link G4 basis: plan-owned lines re-derive (`replace_generated` wist alleen niet-handmatige regels); manual lines never clobbered — delta-merge verfijning pending

## WS7 — Discovery crawler + Ontdek

- [x] Config-driven crawler (one crawl_sources row per site, zero per-site code; PrakkieBot UA, robots, ≤1 req/s, blocklist)
- [x] 9 source configs seeded — live-verified: Leukerecepten 9/10, Uit Paulines Keuken 9/10; ah.nl disabled (edge blocks bots); overige sitemaps to tune on first weekly run
- [x] JSON-LD extractor reused from WS3 · validator rejects incomplete (1/10 rejected live)
- [x] Cross-site dedup (title+ingredients key) + dead-link detection + same-day blocklist check
- [x] Price-per-portion precompute reusing matcher (nightly + ops trigger)
- [x] Ranking v1: deal overlap > price p.p. > freshness
- [x] Ontdek segment UI (reuses RecipeCard + "via {site}" attributie; minimal display depth pending legal #12) — **owner sign-off #13 nog open**
- [x] Save-from-Ontdek → review screen → Mijn recepten (origin crawled_save)
- [x] "ook in Ontdek zoeken" (N4)
- [x] Weekly timer (zo 03:00) + `ops/discovery-crawl` admin trigger

## WS8 — Pantry + nutrition

- [x] Voorraadkast screen: manual add/delete, synct als entity (barcode = later, needs EAS)
- [x] Cook-from-pantry over eigen bibliotheek, ranked by fewest missing (live-verified)
- [x] Pantry-aware list toggle (G6) server-side; per-line reversibility client-side pending
- [ ] Waste nudges from pack leftovers (I3)
- [x] Nutrition honesty: alleen geïmporteerde/gecrawlde voedingsdata, nooit verzonnen ("geen voedingsdata") — NEVO fallback needs owner data-source decision

## WS9 — Household, web companion, cart handoff, learning loop

- [x] Households: create/invite (HMAC deep link)/join/members; shared rows via sync visibility (live-verified: member ziet gedeeld recept)
- [ ] Live check-off via Web PubSub — sync-on-foreground works nu; <2 s push = later optimalisatie
- [x] Recipe share links → one-tap import (K3, live-verified, origin 'shared')
- [x] Web companion (apps/web op SWA): login, recepten + lijsten read-only, detail dialog
- [x] Cart handoff: AH deep-links (product_urls) + "kopieer lijst" fallback voor alle chains (live-verified); affiliate slot = config later
- [x] Learning loop E5: corrections win instantly (live-verified) + nightly consensus → lexicon_products (timer + ops trigger); CI-gate = match-eval script

## WS10 — Monetisation, notifications, launch

- [x] ~~RevenueCat / IAP~~ — **descoped by owner** (geen payments)
- [x] Premium gates: niet van toepassing zonder payments; quota-infra (usage_counters) aanwezig
- [x] Push notifications opt-in: token registratie + weekly plan reminder (Expo push; levering vereist EAS build)
- [ ] "Je Bonus-lijst is klaar" push — needs nightly scrape + promo data
- [ ] Ops workbook + Apify/OpenAI spend alerts (kosten-caps per actor staan hard aan)
- [ ] 500-user load sanity vs €50 envelope
- [ ] Store listings, NL privacy policy, GDPR docs (owner/legal)
- [ ] Legal reviews (a) product data (b) feed display depth (inputs #12)

## UX-audit pass (2026-07-06) — elke tab standalone ([`11_ux_audit.md`](11_ux_audit.md))

- [x] Audit: 18 bevindingen over 7 schermen + cross-cutting (4 🔴, 6 🟠) — alle 🔴/🟠 gefixt
- [x] Lijst standalone: quick-add (offline-first + `/v1/match`-verrijking), item verwijderen/hoeveelheid, eerlijke copy
- [x] Review: handmatig recept kan nu écht (ingrediënt/stap toevoegen+verwijderen+bewerken); bewerken wist stale normalisatie
- [x] Import gap-fill (I2): parser suggereert ontbrekende hoeveelheden/basisingrediënten/stappen — áltijd gemarkeerd (confidence 0.5 + note "AI-suggestie"); review toont amber + stappen-pill
- [x] Plannen: in-place recept-kiezer per dag, notitie-maaltijden zonder recept (migratie 0012), lijst-hergebruik i.p.v. duplicaten
- [x] Instellingen-scherm (avatar op Recepten): naam, live ketens, personen, huishouden maken/uitnodigen/joinen (`GET /v1/households` toegevoegd)
- [x] Onboarding: alleen 6 live ketens kiesbaar, rest "binnenkort" (`LIVE_CHAIN_IDS` in shared)
- [x] Receptdetail terugknop; kookmodus stempelt `last_cooked_at` (sort "laatst gekookt" werkt)

## Statefulness-debug (2026-07-07) — "niets blijft staan" op web: 3 samenspelende oorzaken

- [x] **Replica-identiteitsguard**: 401-zelfheling muntte een nieuwe gast maar liet de lokale replica van de dode identiteit staan → elke push op ghost-parents (plans/lists van de oude gast) werd door de server geweigerd en de engine rolde de optimistische rij terug ("recept verdwijnt uit weekplanner", "keuze niet zichtbaar"). Nu: `prakkie.replica_owner`-marker; wijkt de sessie-gebruiker af → store + cursors + queue + household-cache wissen en volledig terug-pullen (reinstall-garantie). `onIdentityChange` event vanuit api.ts.
- [x] **Sessie-races (single-flight)**: refresh-token roteert bij gebruik; parallelle 401's lieten de verliezer "sessie dood" concluderen en een gezonde sessie wipen (= stille identiteitsreset, elke ~15 min risico). ensureSession én 401-recovery zijn nu single-flight; e-mailaccounts worden nooit stil gewist.
- [x] **Engine-races** (offline-engine, 12/12 vitest + live smoke): (a) edit tijdens in-flight push werd door removePending opgegeten en visueel teruggedraaid → supersede-detectie: nieuwere mutatie blijft in de queue, server-copy overschrijft de nieuwere optimistische rij niet, base schuift mee; (b) delete tijdens in-flight insert liet de server-rij wees achter (revive) → delete queue't nu ook bij in-flight insert; (c) concurrente sync()-calls dubbel-pushten de queue → geserialiseerd.
- [x] **Alert.alert = stille no-op op react-native-web**: "Lijst verwijderen?"-bevestiging deed op web letterlijk niets. Nieuwe `lib/dialogs.ts` (confirmDialog/notice, web → window.confirm/alert) vervangt álle Alerts (7 schermen). Plannen-sheet kreeg "Van het menu halen" (long-press is op web onvindbaar).

## Boodschappen v2 (2026-07-07) — zoek-eerst + "waar ga je halen?"

- [x] Maand-kalender → week-strip: 7 dagen met puntjes, pijlen ← → per week, weeklabel = tik-naar-vandaag
- [x] Per-supermarkt-chips/lijsten weg → één zoekbalk: /v1/match over álle Profiel-supers in één call, shortlists gemerged (relevantie-rang eerst, dáárbinnen goedkoopste eerst — puur prijs zette koekjes boven roomboter), keten-badge per rij; tap = op de lijst mét pin; "product later kiezen" kan altijd (offline-first)
- [x] Item-keuze is nu cross-chain: gekozen keten = `preferred` in matches-jsonb (geen serverwijziging); lijstregel toont product + keten-dot + prijs
- [x] "Waar ga je halen?"-kaart: alles-bij-X totaal per super (mist-n eerlijk erbij, voordeligste gemarkeerd) + **slim verdelen** over 2+ winkels met besparing t.o.v. beste enkele winkel; footnote "± schatting, jouw keuzes tellen exact"
- [x] kv `prakkie.mychains` cache (onboarding/profiel schrijven, boodschappen leest; /v1/me blijft waarheid)
- [x] Verificatie: tsc clean, expo web export clean, live multi-chain match-check (melk/roomboter, 3 ketens, 36 opties met prijs+foto)

### v2.1 — owner-feedback (zelfde dag)

- [x] Meer opties: SHORTLIST_SIZE 12→24 (server, deployed) + UI-cap 8→30 (zoek) / 30 (sheet) — "brood" nu 144 gemergde opties
- [x] Sortering: púúr prijs laag→hoog (rang alleen tiebreak) — owner koos expliciet voor prijs boven relevantie-volgorde
- [x] Gekozen product → producttitel wordt de itemnaam (zoek-add én pin); verrijking overschrijft de titel niet meer; subline "· door jou gekozen" zonder duplicatie
- [x] "Alles bij X" grijs + zonder totaal wanneer de lijst daar niet compleet kan (regel betrouwbaar = gepind óf confidence ≥ 0.45); voordeligste-marker alleen op complete ketens; besparing t.o.v. beste complete keten
- [x] Inhoud/gewicht per rij: "300 g · €3,30/kg" — pack-size zit niet in de catalogus maar wordt exact afgeleid uit prijs ÷ eenheidsprijs (live geverifieerd op sandwichspread)
- [x] Prijzen: dode "Koken met aanbiedingen"-rail → conditioneel + echt (recepten × deals), lege staat met CTA
- [x] Ontdek: laden ≠ geen-resultaat ≠ offline; 0-hits toont import-CTA
- [x] Matcher: morfologische aliassen in zoektermen + `lexicon_products` rank-1 hints geseed (`scripts/seed-lexicon-hints.mjs`) — "ui"→uien i.p.v. "Gehakt met ui"
- [x] Mockups 03/04/05/06 bijgewerkt op de audit-beslissingen (quick-add, AI-suggestie-conventie, + toevoegen, eerlijke meta)
- [x] `scripts/e2e-components.mjs`: per-feature live suite — import ×3 echte sites + non-recipe fail, 20 NL-staples matching, lijst-lifecycle, notitie-maaltijd, regenerate-idempotentie, households

## Owner-directives ronde 2 (2026-07-06 avond) — user bepaalt, huishouden op e-mail

- [x] **Productkeuze bij de user**: elke lijstregel heeft een dropdown met álle matchende producten (thumbnails + prijs, `ProductOptions`); shortlist komt altijd terug en is breed (12 — "roombotercroissant" verschijnt bij "roomboter"); zonder keuze géén productnaam/prijs op de regel ("Kies"-pill); hoofdtotaal telt alleen eigen keuzes, keten-chips blijven de ±-schatting
- [x] **Recept → lijst**: na dag-keuze volgt een productkeuze-stap per ingrediënt (accordion met opties bij jouw winkel); keuzes worden gepind + gevoed aan E5-corrections
- [x] **Prijzen-tab vervangen door Profiel** (Bordje-Profiel.png 1:1): profielkaart met leden-chips + invite, supers/taal/eenheden/porties/meldingen-rijen, premium-teaser (betalen bewust uit), GDPR-voet; account-rij (e-mail registreren/inloggen, gast-upgrade behoudt data)
- [x] **Huishouden op e-mail-invite**: migration 0013 (`household_invites`), invite {email} endpoint, `GET /v1/households/invites` + accept; gedeelde lijsten krijgen `household_id` bij aanmaken
- [x] **Lijst → Boodschappen**: maand-kalender met puntjes op dagen met boodschappen, dag openen/sluiten, lijsten per dátum (week_start draagt de dag); log "laatst: wie — wat" + added-by-initialen per regel (`list_items.added_by`, server-gestempeld)
- [x] **Bugfix weekplanner**: entry_date kwam na sync als ISO-datetime terug → recept verdween uit de dag (slice-normalisatie)
- [x] e2e-components uitgebreid: e-mail-invite flow (A nodigt uit → B registreert → ziet → accepteert → deelt lijst → added_by-log), shortlist-breedte-contract

## Inputs from owner (see [`10_inputs-needed.md`](10_inputs-needed.md))

- [x] 1 · Azure subscription + RG naming
- [x] 2 · Deploy identity (az login; OIDC SP aanbevolen zodra CI deployt)
- [ ] 3 · Apple Developer + Google Play accounts → blokkeert EAS/TestFlight/share-extension/push-levering
- [x] 4 · ~~OAuth client IDs~~ — descoped met Apple/Google auth
- [x] 5 · Apify token geleverd & in Key Vault (live gebruikt)
- [x] 6 · OpenAI key geleverd & in Key Vault (live gebruikt; model gpt-5.4-mini)
- [ ] 7 · Picnic account decision
- [ ] 8 · Domain (prakkie.nl) → universal links + share-URL's
- [ ] 9 · Prijzen-tab chain set confirmed (nu: 6 chains met data)
- [ ] 10 · Mockups re-exported to "Prakkie"
- [x] 11 · ~~RevenueCat vs direct billing~~ — descoped
- [ ] 12 · Legal advice budget approved
- [ ] 13 · Ontdek screen sign-off (segment staat live in dev-app)
