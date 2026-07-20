# Prakkie — Build Progress

> The living tracker. Tick items as they land; keep this file honest — an item is only checked when its acceptance criterion (see [`05_workstreams.md`](05_workstreams.md)) is demonstrably met.
> **Status legend:** unchecked = not started/in progress · checked = done & verified.
> **Verification:** `scripts/e2e-smoke.mjs` runs the full live suite against dev (36 checks: spine + WS7/8/9 + 10-chain store) — green as of 2026-07-16.
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
- [x] Connector: Detailresult → Dirk + dedicated DekaMarkt storefront/category walker (9,982 rows live)
- [x] Connector: Plus (OutSystems payloads)
- [x] Connector: Vomar — full webshop/API scraper, 6,201 rows live
- [x] Connector: Hoogvliet — full Tweakwise + Intershop scraper, 10,603 rows live (public source exposes no EAN; manual alternatives only)
- [x] Connector: Spar (JSON-LD + HTML sections; price coverage honestly partial)
- [x] Connector: Ekoplaza — full ASPOS category walker, 5,585 rows live
- [x] Connector: Aldi (partial coverage → honest-gaps path)
- [ ] Connector: Picnic — scraper + silver connector implemented and tested; live import remains kill-switched pending `PICNIC_AUTH_KEY`
- [x] Per-chain kill switch (ingest refuses disabled chains) + staleness in API (`last_ingest_at` → "prijzen van {datum}")
- [x] Seed lexicon — 230 curated NL entries w/ aliases (0009); grows via E5 loop
- [x] E1 normaliser (el/tl/snufje, fractions, ranges, "naar smaak", NL+EN) — 23 tests
- [x] Matcher: corrections → lexicon → canonical-bridge → pg_trgm + rules; confidence + shortlist (pgvector seam open — needs embeddings)
- [x] Pack-size reconciliation ("pakt precies", fractional cost)
- [ ] Embedding pipeline (vector(512)) — seam built, awaits OpenAI embedding budget decision
- [x] **Match eval 93.0% top-1** on 92-item labelled set (target ≥90%) — `scripts/match-eval.mjs`
- [ ] Nightly refresh automation — pipeline + trigger live (`ops/catalog-ingest`) and isolated five-chain runner (`scripts/refresh-supermarket-catalogs.mjs`) ready; scheduled Python host still needs local/CI/container placement
- [x] Dev catalog seeded: **118,811 products, 10 live chains**; DekaMarkt/Vomar/Hoogvliet/Ekoplaza categorized and searchable, Picnic pending auth

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
- [x] Recepten library on the LIVE offline cache (search/tags/sort) + Ontdek is nu het standaardsegment (2026-07-07); "Mijn recepten" = filter/like
- [x] Import sheet live: clipboard-detection card, link input, 202 polling, foutafhandeling
- [x] ~~Onboarding A3~~ vervangen (2026-07-07) door `/login` + next-next-next tour-overlay (supermarkt-stap verplicht, zie ronde-3-log)
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

- [x] ~~Voorraadkast screen~~ — **verwijderd op owner-verzoek (2026-07-07)**: knop + `pantry.tsx` weg; backend-endpoint (`/v1/pantry/cook-suggestions`) staat nog maar is client-side onbereikbaar
- [x] ~~Cook-from-pantry~~ — zie boven, feature is uit de UI
- [x] Pantry-aware list toggle (G6) server-side — ongebruikt zonder pantry-UI; niet verwijderd (`list-ops.ts`)
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

## WS11 — Virtuele supermarkt: Boodschappen-redesign ([`12_virtual_supermarket.md`](12_virtual_supermarket.md))

### Fase 0 — Datafundament: panelen & aggregaten (2026-07-11)

- [x] Probe `product_intent`: 15.202 head_terms, waarvan 547 met 6-keten-dekking / 1.727 met ≥4 — paneel-concept gevalideerd op echte data
- [x] `scripts/generate-store-categories.mjs`: kandidaten (1.953, ≥3 ketens & ≥6 producten) + gecureerd voorstel (195 panelen, 10 afdelingen). Per-schap-groep-caps (les uit run 1: vleeswaren/vega/koffie/wijn/schoonmaak verhongerden naast grote broers), synoniem-merges (Energy drink/Energydrink, IJs-familie, plantaardige-melk-bundel incl. aisle-4-sojadrink, kattenvoer-mislabel), NL-hoofdletters (IJsbergsla), slug-dedupe over afdelingen (crackers 6/7/12)
- [x] Migratie **0029**: `store_departments` (10, geseed) + `store_categories` (head_terms[] × aisle_group_ids[] binding) + `store_category_stats` (per paneel × keten) — toegepast op dev
- [x] `scripts/seed-store-categories.mjs`: gecureerd CSV → upsert op slug + prune + directe stats/thumbnail-refresh (transactioneel) — 195 panelen live op dev
- [x] API `store.ts`: `GET /v1/store/home` · `/v1/store/department/{id|slug}` · `/v1/store/category/{id}/products` (CrossChainOption-vormig incl. rank, sorteringen aanbevolen/prijs/eenheidsprijs/bonus, q-zoeken-binnen-paneel) + nightly stats-timer (04:45) + `ops/store-stats`; zod-types in `packages/shared/src/store.ts`
- [x] Data-verificatie op dev met de exacte API-queries: home 30 ms · afdeling 26 ms · paneel-producten 32 ms (doel <300 ms); 0 panelen zonder producten, 0 zonder thumbnail; "Halfvolle melk · 176 producten · vanaf €0,59 · 6 supermarkten" komt live uit de registry. promo_count overal 0 = bekend seed-snapshot-gat (verse scrape vult)
- [x] `e2e-smoke` +4 checks: entree → afdeling → paneel-producten → zoeken-binnen-paneel
- [x] **Deploy dev** + volledige e2e-smoke groen live (31 checks incl. 4× store): "halfvolle melk: 176p vanaf €0,59 bij 6 ketens" uit de live API
- [ ] Owner-curatie panel-CSV (`scripts/store-categories.curated.csv`) — owner koos "doorbouwen, review later" (2026-07-11); afdeling-indeling akkoord

### Fase 1 — Winkel-shell: navigeerbare omgeving (2026-07-11)

- [x] Data-laag `src/store/api.ts`: cache-first hooks (kv → direct tekenen, netwerk ververst; spec §26.2 "nooit een blanco laadscherm"), `useStoreHome`/`useDepartment`/`fetchPanelProducts`, "verder waar je was" (kv, spec §9)
- [x] Scene-bouwer `src/store/scene.ts`: secties ("wandvakken") uit paneel-data afgeleid — aaneengesloten fixture-runs → units (koelwand 4 deuren, stelling 6 schappen) → secties van ~8 panelen; handgeschreven manifest bewust uitgesteld naar de art-pass (anders bevriest elke curatie de layout). `THEME_AMBIANCE` per thema (wand/vloer/kast/licht/glas) als placeholder-decor + laad-fallback
- [x] `FixtureUnit` + paneel-tegels: glas-reflectie-gradient, koelcel-handgreep, AGF-krat-rand, plint, bonusvlag, a11y-label "«Halfvolle melk», 176 producten, vanaf €0,59, bij 6 supermarkten" (spec §28); leeg paneel gedimd "nu geen aanbod"
- [x] `DepartmentScene`: horizontale snap-secties (paging FlatList) vóór 2.5D-placeholderdecor — plafondlampen 0.45× en vloervoegen 0.8× parallax (uit bij `useReducedMotion`), sectie-dots + "volgend vak"-knop, afdelingsbord-header
- [x] `PanelSheet` (fase-1-versie): paneel-tik → overlay-sheet (winkel zichtbaar, sluiten = zelfde scene-positie, spec §24) met `CrossChainList`, sorteer-chips (aanbevolen/prijs/per-kilo/bonus), zoeken-binnen-paneel, keuze → zoeklijstje (zelfde pad als schap-bladeraar); detent-sheet + mand-koppeling = fase 2
- [x] `StoreMapSheet`: plattegrond-blokken in looproute-volgorde, je-bent-hier-marker, tik = afdeling-jump (acceptatie #2: elke afdeling in ≤2 interacties)
- [x] Boodschappen-tab = winkel-entree: afdeling-blokken (thema-kleur + luifel), "verder waar je was"-chip, je-lijst-kaart, klassieke weergave als link; oude start verhuisd naar `/lijst/start` (opruimen = fase 5)
- [x] tsc mobile clean + expo web export clean (routes `/winkel/[dept]` + entree gebundeld); RN 0.86-les: `StyleSheet.absoluteFillObject` bestaat niet meer

### Fase 2 — Praktische ontdek-home (owner-directive 2026-07-12: "screw the entire design, its ugly — built it like this [mockup]. practical. logische flow, logische categorisering, lijst bouwen")

- [x] **Wand-strip + alle winkel-theater weg**: ShelfStrip/StoreMapSheet/PanelSheet/walls/scene + wand-art (~5,4 MB assets) verwijderd; `/v1/store/home` en `/v1/store/strip` vervangen door één `GET /v1/store/discover`. De 25-categorieën-taxonomie + 250 subcategorieën + stats (fase 0/1c-datafundament) blijven het hart
- [x] **`GET /v1/store/discover`**: categorieën mét representatieve productfoto (uit eerste paneel met beeld) + `product_count`/`promo_count`, én "Aanbevolen voor jou" — basisproducten in de bonus, per head_term geaggregeerd (vanaf-prijs, goedkoopste keten, aanbiedingen-teller). **Dev-catalogus heeft momenteel 0 promo's** (snapshot 2026-07-05, alle promo-velden leeg) → eerlijke fallback: breedst-gevoerde basisproducten (vergelijken loont daar het meest), `offer_count: 0` → client toont "bij N supers" i.p.v. "N aanbiedingen"; zodra een verse scrape bonusdata brengt schakelt de sectie vanzelf naar bonus-modus
- [x] **Boodschappen-home** (mockup-conform): titel + winkelwagen-knop met teller (→ /lijst/start, de lijst-hub), zoekbalk → /store/zoeken, verswand-kaartenrij (groente/fruit/zuivel/bakkerij/vlees/kaas) + "Alle categorieën"-tegel, "Populaire categorieën" (meeste bonussen; zonder bonusdata grootste assortiment) als ronde foto-chips, "Aanbevolen voor jou"-productkaarten (foto · naam · inhoud · vanaf-prijs · ketenlogo · groene +). + voegt de **head_term** toe (niet de keten-specifieke naam) — de lijst vergelijkt dan over álle supers
- [x] **/store/[dept]**: subcategorie-chips (thumb + naam + bonus-dot) boven een directe productlijst — alle supers door elkaar, sorteer-chips (aanbevolen/prijs/per-kilo/bonus), zoeken-binnen-categorie, rij-tik = op je lijstje; lege categorie (glutenvrij) = eerlijke "binnenkort". **/store/categorieen**: 3-koloms grid van alle 25 mét bonus-pills. **/store/zoeken**: één veld over de hele winkel via de bestaande slimme matcher (/v1/match — lexicon/correcties/fuzzy/beeld), autofocus, rij-tik = toevoegen
- [x] **Lijst-bouwen als rode draad**: elke toevoeging → zoeklijstje (kv, zelfde pad als altijd); zwevende groene `LijstFooter` ("N op je lijstje · laatst toegevoegd · Bekijk") op álle winkel-schermen → /lijst/samenstellen → "Vind mijn prakkie" voor prijzen; teller overleeft schermwissels (focus-reload uit kv)
- [x] **UX-getest met playwright** (screenshots beoordeeld, volledige flow 2× groen, 0 page/console errors): home → categorie → rij-tik → lijst-balk → samenstellen (item staat er) → alle-categorieën-grid (25) → Diepvries → zoeken "pindakaas" (prijzen oplopend) → toevoegen → aanbevolen-+ → vinkje → cart-badge 3. Twee vondsten gefixt: (a) aanbevolen-kaart toonde het goedkoopste item als "gezicht" van een productsoort ("Eru Kids" voor kaas) → fallback-kaarten titelen nu op de productsóórt met het product als ondertitel, en het keten-logo hoort altijd bij de échte vanaf-prijs (min_chain uit het aggregaat); (b) categoriefoto kwam uit het éérste paneel (Fruit toonde een sapfles) → nu uit het gróótste paneel
- [x] tsc shared/api/mobile clean · expo web-export clean (routes /store/[dept] · /store/zoeken · /store/categorieen) · e2e-smoke volledig groen live ("kaas vanaf €0,49, 6 ketens")
- [ ] Owner-review: aanbevolen-selectie is v1 (breedst gevoerde basisproducten; wordt vanzelf bonus-gedreven zodra een verse scrape promo's brengt); "Populaire categorieën"-label bij assortiment-fallback; native device ongetest (web-only verified)

### Fase 3 — Winkelen ís samenstellen (owner 2026-07-13: "vind mijn prakkie met AI eruit slopen; categorie browsing only; daarna gewoon de summary met als enige switch supermarkt-subtotalen, default per supermarkt gesorteerd")

- [x] **AI-resolve gesloopt**: `/v1/prakkie/resolve` (endpoint) weg; schermen /lijst/samenstellen, /lijst/start (hub) en /lijst/schappen (oude schap-bladeraar) verwijderd; zoeklijstje-kv-flow weg (lijst-flow.ts rest alleen `loadMyChains`); "Vind mijn prakkie"-quota-rij van Profiel. De /v1/match-zoeker (lexicon/fuzzy) blijft — die drijft de item-sheet ("kies jouw product"), alternatieven en Alles-bij-X
- [x] **Winkelen = samenstellen** (`store/lijst.ts` v2): elke productrij-tik zet dat éne concrete product — keten + sku gepind — direct op dé lijst (lists/list_items, model ongewijzigd); zelfde product nóg eens = aantal +1; `/v1/lists/{id}/price` prijst het exact. LijstFooter/cart-knop → direct naar de summary. Aanbevolen-kaart pint het gerepresenteerde product zelf (nieuw `rep_chain`-veld in discover)
- [x] **Summary vereenvoudigd** (resultaat.tsx): default gesorteerd per supermarkt (super-logo per regel), énige switch = "supermarkt subtotalen" (groepskoppen mét subtotaal); "+ toevoegen" → de winkel; opgeslagen lijstjes laden verhuisde hierheen (AI-loos — items dragen hun productkeuzes al mee); rest onaangetast (afvinken, draft/Opslaan, Alles-bij-X, delen, favorieten). A11y-fix: terug/toevoegen/lijstjes-knoppen misten accessibilityRole
- [x] **Recept & weekplan zonder AI**: "Zet op mijn lijstje" (receptdetail) en "Zet week op je lijst" (planner-CTA, verving de wegwijzer) zetten geschaalde ingrediënten als kale regels op de lijst → productkeuze per regel op de summary ("Kies")
- [x] **Weekplanner-kopheaders** (owner: "meer imagery, gewoon om het mooi te maken"): per maaltijdmoment een foto-header (Pexels vrije licentie, sharp 900×300, ~168 kB totaal: pannenkoeken/groentebowl/fruitplank/spaghetti) met Young Serif-label in een scrim + entry-teller; tikbaar = plannen; de +'jes eronder
- [x] **UX-getest met playwright** (volledige flow groen, 0 page/console errors, screenshots beoordeeld): categorie → product-tik → balk "1 op je lijstje" → summary op /lijst/resultaat mét exacte prijs (€4,09 zoals in de winkel getoond) → subtotalen-switch (ALBERT HEIJN-kop + subtotaal) → "+ toevoegen" → zoeken "hagelslag" → 2 items · totaal €6,58 · "alles gekozen — geen verrassingen" → planner met 4 foto-headers. Copy-fix: "1 item" enkelvoud. Les: gewedgde expo-server op 8090 overleefde taskkill → poort-conflict = stale bundle; PowerShell Stop-Process
- [x] tsc shared/api/mobile clean · expo web-export clean (samenstellen/start/schappen uit de routes) · e2e-smoke volledig groen live · API deployed op dev

### Fase 3b — Categorie-poort op substituties (owner 2026-07-13: "wit brood bij Aldi werd Koopmans Witbrood MIX bij Alles-bij-Dirk — alleen matches uit dezelfde subcategorie toelaten")

- [x] **Diagnose** (probe op het exacte priceList-pad): bij Dirk stond géén echt brood in de shortlist, alleen Koopmans-mixen; de mix won met 0.85 via de beeld-brug omdat AH's "Koopmans Wit brood" (óók een mix, maar zo geheten) het AI-mislabel head='wit brood'/vers/schap-6 droeg én als foto-anker dezelfde doos bij Dirk aanwees — tekst- en beeldsignaal logen allebei
- [x] **`filterToAnchorCategory`** (match.ts, gebruikt door priceList): een automatisch substituut moet in dezelfde winkel-subcategorie (catalog.store_categories: head_terms × schap-groepen — de keten-overstijgende indeling die de owner vroeg, bestond al als fase-0-fundament) vallen als het anker-product; buiten de gecureerde panelen geldt de head-famílie (gelijk of kop-uitbreiding, mengsel-koppen "met/en" uitgesloten). Absoluut — ook foto-gelijkenis komt er niet doorheen. Blijft er niets over → eerlijk géén match ("kies alternatief"); de volledige shortlist blijft beschikbaar voor de kiezer in de app
- [x] **pickSaneBest**: `sameHead` van exact naar familie — anders versloeg een exact-'kaas' snack (Cheesepop, niet-primair) de échte jonge kaas op het head-criterium (eval-violatie)
- [x] **Datafix**: 5 Koopmans-bakmixen (AH ×4, Jumbo ×1) die het AI-label als vers brood zag → head broodmix/bakmix, schap 11, gedroogd — alle andere ketens hadden identieke producten al goed. NB: verse AI-labelrondes kunnen dit hertroduceren; de "Brood uit de pan"-lijn is een bekende valkuil
- [x] **Bewijs**: substitution-eval (gespiegeld op het nieuwe pad, env-creds gaan nu vóór az): **553 checks, 0 violaties**, 46× eerlijk geen match door de poort (~8%); witbrood-probe levert nu bij álle ketens echt brood ("Batard wit"/"Rond Wit Brood"/"BakkersHart Brood Wit"). tsc clean, deployed op dev

### Fase 1c — Wanden-strip op eigen art (owner 2026-07-12 ochtend) — **vervangen door fase 2 (praktische redesign, zelfde dag)**

- [x] **Owner-art verwerkt**: REDESIGN/1-4.png (7560×1920 ×3 + 5456×1920) → `assets/images/store/wall-1..4.jpg` (h1600, mozjpeg q80, ~5,4 MB totaal). Wand-grenzen programmatisch gedetecteerd (donkere scheidingskolommen): beeld 1-3 exact 7 gelijke wanden, beeld 4 ongelijk. **Dubbele diepvries-wand in beeld 4 eruit gesneden** (art had 26 wanden, de lijst 25; knip op de zwarte naden = onzichtbaar — owner kan vetoën)
- [x] **Wanden-taxonomie**: migratie 0030 — 25 wanden vervangen de 10 afdelingen, in de exacte loopvolgorde van de art. Generator herschreven: wand-toewijzing per pánel met term-sets (groente/fruit splitsen schap-groep 1, vlees/vis groep 3, kaas/vleeswaren groep 5 — valkuilen: leverkaas≠kaas, "aardappelen" bevat "appel"); dunne wanden gevuld via merges (tonijn incl. blik, luiers/billendoekjes/babyvoeding, honden-/kattenvoer incl. OVERIG-mislabels, mueslirepen/rijstwafels/ontbijtkoek/knijpfruit → Tussendoortjes, verse sappen/smoothies → Fruit-wand). **250 panelen** geseed; Glutenvrij bewust 0 (geen datasignaal) = eerlijke "binnenkort"-pane
- [x] **API `GET /v1/store/strip`**: alle 25 wanden mét panelen in één call (de strip tekent alles tegelijk; geen 25 requests) — deployed, e2e-checks bijgewerkt (25 wanden; zuivel-eieren)
- [x] **`ShelfStrip`** vervangt de 3D-corridor (DepartmentScene/FixtureUnit/`/winkel` verwijderd): fullscreen oneindige horizontale scroll — kloon van beeld 4 vóór en beeld 1 ná de echte reeks, teleport van precies één periode zodra je een kloon in scrolt (pixel-identiek = onzichtbare naad, klonen dragen ook panes). Per wand: hangend bord + glazen panes (blur op web) met `naam · aantal · v.a. €` en bonus-dot; >9 panes → groene "+N meer"-pane → wand-lijst-sheet; lege wand → "binnenkort". Paneel → bestaand PanelSheet → zoeklijstje. Plattegrond (icoon rechtsboven) = 25-wanden-index met jump + voetlinks (je lijst / klassieke weergave); lijst-pill met open-items-teller; "verder waar je was" op wand-niveau (kv); StatusBar licht zolang de tab focus heeft
- [x] **UX-getest met playwright** (2 rondes, screenshots beoordeeld): ronde 1 ving twee echte bugs — (a) `contentOffset`-prop werkt niet op web → strip opende op de kloon (Drogisterij) terwijl de pill "Groente" zei → altijd programmatisch scrollen bij mount; (b) vaste naam-pill bovenin dupliceerde het wand-bord → vervangen door icoon-only plattegrond-knop. Ronde 2 volledig groen: start op wand 1 → pane → sheet → product op lijstje (added-bar) → sluiten = zelfde plek → plattegrond-jump Diepvries → **loop-wrap beide kanten naadloos bewezen** (na Huisdier hangt direct Groente; ervóór Huisdier) — 0 page/console errors. Copy-fix: "1 supermarkt" enkelvoud
- [x] tsc mobile/api/shared clean · expo web export clean · e2e-smoke volledig groen (2× — één eerdere run had een timing-flake)
- [ ] Bekende puntjes voor owner-review: panes aan de wandrand vallen half buiten beeld tot je even scrollt (inherent aan continue strip; smaller pane-gebied kan), wrap-momentum stopt op web bij de naad (wheel-scroll pakt gewoon door; native ongetest), guest-met-1-keten toont eerlijk "1 supermarkt"

### Fase 1b — 3D-gangpad (owner-directive 2026-07-11: "meer game-gevoel, 3D + poppende panes") — **vervangen door 1c**

- [x] `buildCorridor` vervangt de vlakke secties: elke snap-sectie is een stuk gangpad met een **linker- en rechterwand**; koel/vries-deuren hangen zoals in een echte super aan één wand (deuren rechts, rest links; één-soort-afdelingen om-en-om). Max 2×2 panelen per wand voor leesbaarheid onder de hoek (spec §7.1)
- [x] `DepartmentScene` v2: wanden zijn perspective-panes (rotateY ±30°, perspective 900, géén 3D-engine) die tijdens het swipen subtiel meedraaien (±14°) en faden; gekantelde vloer- en plafond-panes (rotateX, `transformOrigin`), dieptemist in het verdwijnpunt, lampen 0.35× / vloervoegen 0.85× parallax. Reduced motion: statische hoek, geen walk-effect
- [x] Game-microdynamiek: paneel-pop (veer naar je toe bij aanraken, spec §10.3 focused), product/plattegrond-panes springen als platte 2D-sheets óver de 3D-wereld (`SlideInDown.springify`), entree-blokken licht gekanteld als winkelgevels
- [x] A11y-fix onderweg: sluit/terug/plattegrond-knoppen kregen `accessibilityRole="button"`; backdrop niet meer als tweede "Sluiten" voor screenreaders
- [x] **Runtime-geverifieerd** (apps/mobile:verify — Expo web + Playwright/Edge headless, 402×874): entree 10 blokken → zuivel-corridor 26 panelen, wand-transform bewezen `matrix3d(0.866, 0, 0.5, …)` = rotateY(30°), wanden naast elkaar (x=48 vs x=252) → Yoghurt-tik → sheet met prijzen/eenheidsprijzen → sluiten = zelfde positie → plattegrond-jump naar Diepvries (vriesdeuren op beide wanden) — **0 page/console errors**; screenshots beoordeeld, 3D-look staat
- [x] Verify-les: `CI=1` betekent óók stale Metro-cache na edits — herstart met `--clear`; tab-klik kan verloren gaan tijdens hydration (retry-loop in de driver)
- [ ] Owner-pixelreview van de 3D-shell (kleuren/hoek/dichtheid tunen kan per token)
- [ ] Performance-meting mid-range device (50–60 fps-doel, spec §26.3); web-headless toonde geen jank-signalen

## EAN-only productmatching + OFF-verrijkingspipeline (2026-07-14, owner-plan)

- [x] **Owner-besluit**: elke catalogusregel krijgt een EAN; cross-chain productmatching (product→product, "hetzelfde artikel bij een andere keten") draait uitsluitend op exacte EAN/GTIN-identiteit. Naam- en beeld-gelijkenis als automatische substitutie zijn eruit gesloopt. Ingrediënt→product-zoeken (term → shortlist) blijft naam-gebaseerd — een zoekterm hééft geen EAN.
- [x] **Pipeline** (`services/ean-enrichment`, nieuw): OFF-parquet (HF `openfoodfacts/product-database`) → server-side copy naar `stprakkie<env>/openfoodfacts` (max 1×/20 dgn) → DuckDB NL-filter + kolomprojectie via httpfs/SAS → offline match (exact → token-set → insluiting; merk/verpakking mogen nooit tegenspreken; ambigu = geen match) → `catalog.products.ean` alleen waar NULL + provenance in `catalog.ean_enrichment` (migratie 0034). 10 unit-tests op de matcher groen (o.a. Penotti-case, variant-ambiguïteit, pack-contradictie).
- [x] **Infra**: `infra/modules/enrichment-job.bicep` — ACR (`crprakkie<env>`) + Container Apps env + geplande job `caj-ean-enrich-<env>` (ma 03:00 UTC), user-assigned identity met KV/blob/AcrPull binnen één deployment; `deploy.ps1` bouwt het image via `az acr build` en wisselt de placeholder om. Vision-module was al verwijderd; `catalog.product_image_embeddings` dropt in 0034.
- [x] **Ingest-guard**: upsert doet nu `ean = COALESCE(EXCLUDED.ean, products.ean)` — scraper-EAN wint, maar een scraper-NULL wist een OFF-verrijkte EAN niet meer.
- [x] **Matcher policy-v2-ean**: `assessCandidate` mét anker = EAN-gelijk → accepted (0.999), anders review — dieet/variant/vorm/pakmaat/organic-heuristieken verwijderd; zonder anker blijven de kalibratie-drempels (v2-seed in 0034, zonder beeld-bron). `pricing.ts`: anker-pad is EAN-of-niets (term-shortlist blijft puur picker-aanbod); beeld-tier, categorie-poort en `findAnchorAlternatives` verwijderd uit `match.ts`. `pickSaneBest` terug naar maat/multipack/primary-gezond-verstand.
- [x] **Evals herijkt**: `substitution-eval.mjs` meet nu EAN-substitutiedekking (staples × ketens, + ankers zonder EAN); `match-policy-eval.mjs` kalibreert alleen nog ánkerloze suggesties op `policy-v2-ean`. `docs/07_matching_policies.md` herschreven.
- [x] **Verificatie**: tsc groen (api, ingest, mobile); vitest 60/60 (api) + 10/10 (ean-enrichment). **Bewust gevolg**: huismerken (eigen EAN per keten) substitueren nooit meer automatisch — eerlijk "geen match", user kiest zelf.
- [ ] **Nog te doen door owner**: `./scripts/deploy.ps1 -Env dev` (infra + image + migratie 0034), daarna eerste run `az containerapp job start -g prakkie-dev -n caj-ean-enrich-dev` en `node scripts/substitution-eval.mjs --env dev` voor de dekkingsnulmeting.

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

### v2.2 — "meest waarschijnlijk eerst" (banded ranking, owner-vraag sperziebonen)

- [x] Twee banden in de productzoeker: beste matches boven (goedkoopste eerst dáárbinnen), kopje "MEER OPTIES", rest ook op prijs. Bandregel client-side: source ≠ trgm (correctie/lexicon) óf top-3 per keten mét confidence ≥ 0.55 — per-keten-RANG i.p.v. vaste drempel (coverage-term maakt lange verse namen anders verliezers van korte blik-namen). Gedeelde `CrossChainList` voor zoekpaneel + item-sheet.
- [x] Server FORM_RX-penalty (−0.22): blik/pot/gebroken/gedroogd/ingelegd/zoetzuur/tafelzuur — alléén voor aisle-groep-1-queries (vers; kikkererwten/doperwten houden blik als top) en alleen als de query het woord zelf niet noemt. Eval-diff mét/zónder penalty: identieke misses = nul regressies; 94,7% (mais@aldi = catalogus-gat).
- [x] Seeder-guard: blik/gebroken/gedroogd/ingelegd in DISH_WORDS (nooit een blik-variant als rank-1-hint); eval +3 rijen (sperziebonen, bietjes, mais-canary — NL vers = "Suikermais").
- [x] Leer-loop = het populariteitsmechanisme: keuze → correctie (direct band 1 voor jou) → nachtconsensus ≥3 → lexicon-hint (band 1 voor iedereen). votes-boost in SQL bewust uitgesteld (dubbeltelling + dun signaal).

## Beeld-embeddings als matcher-tier (2026-07-07, owner-idee)

- [x] Probleem: zelfde product, andere winkelnaam ("Duo Penotti" @ AH = "Duopasta" @ Aldi) — trgm kansloos (word_similarity 0.25), maar de fóto's lijken wel. Lakmoesproef Azure AI Vision multimodal embeddings (Florence 1024-dim): kloon-paar cosine **0.785**, ongerelateerd ~0.57–0.63 → signaal bruikbaar, drempel 0.70.
- [x] Infra: `vis-prakkie-dev` (ComputerVision S1, westeurope) + bicep-module; key/endpoint in KV (VISION-API-KEY/-ENDPOINT). Kosten: ~$0.10/1k foto's; volledige backfill 86k ≈ $9 eenmalig.
- [x] Migratie 0016 `catalog.product_image_embeddings` (vector(1024), image_url_hash voor incrementeel her-embedden, HNSW cosine). NB: 0015 wilde `product_embeddings` maken maar die naam bestond al sinds 0002 (lege tékst-variant, 512-dim) — 0015 is teruggebracht tot grants.
- [x] `scripts/embed-product-images.mjs`: hervatbare backfill (skip bij ongewijzigde image_url-hash), 6 parallel, retry/backoff, --chain/--limit/--dry.
- [x] Matcher image-tier (match.ts): ná trgm — ketens zonder overtuigende kandidaat (best < 0.60) krijgen ANN-kandidaten op basis van de foto-ankers van sterke ketens (best ≥ 0.72, max 2). Cosine ≥ 0.70 → source 'image', confidence [0.55..0.85] (nooit boven correcties/hints). Fail-safe try/catch: kapotte Vision/embeddings breken nooit de match.
- [x] Client: source-union + bandOf herzien (band 1 = correction|lexicon; image volgt rang/confidence-regels net als trgm).

## Boodschappen v3 (2026-07-07) — draft/Opslaan, per-super groepen, favorieten, bulk-wissel

- [x] **Draft-model**: elke lijst-bewerking (toevoegen, verwijderen, hernoemen, aantal, productkeuze, bulk-wissel, lijstje laden) is een concept tot Opslaan; Annuleren gooit alles weg; dag/lijst-wissel met openstaand concept vraagt bevestiging. Afvinken blijft direct (winkel-modus). Correcties voor de matcher gaan pas mee bij Opslaan.
- [x] **Per-supermarkt groepen** met subtotaal per super (schap-categorieën weg); "Nog te kiezen"-groep onderaan; prullenbakje per regel (annuleerbaar via draft).
- [x] **"Alles bij X" tikbaar**: complete super in de "Waar ga je halen?"-kaart wisselt het hele lijstje naar de producten daar (in concept; items zonder match blijven staan; geen bulk-correcties naar de leer-loop).
- [x] **Opgeslagen lijstjes** = lijsten zonder datum: bewaar-sheet (naam) + laad-sheet (tik → items in concept van de dag; verwijderbaar). Gedeeld met het huishouden.
- [x] **Aantal ×2 = prijs ×2**: server-side kale aantallen = stuks (packs=qty, bonusprijs per stuk telt mee) — live bewezen (1× €1,29 → 3× €3,87); client schaalt draft-prijzen lineair mee incl. net gekozen product (_unit_cents).
- [x] Verificatie: tsc mobile+api, expo web export, deploy, live qty-check, e2e-smoke volledig groen.
- [x] Prijzen: dode "Koken met aanbiedingen"-rail → conditioneel + echt (recepten × deals), lege staat met CTA
- [x] Ontdek: laden ≠ geen-resultaat ≠ offline; 0-hits toont import-CTA
- [x] Matcher: morfologische aliassen in zoektermen + `lexicon_products` rank-1 hints geseed (`scripts/seed-lexicon-hints.mjs`) — "ui"→uien i.p.v. "Gehakt met ui"
- [x] Mockups 03/04/05/06 bijgewerkt op de audit-beslissingen (quick-add, AI-suggestie-conventie, + toevoegen, eerlijke meta)
- [x] `scripts/e2e-components.mjs`: per-feature live suite — import ×3 echte sites + non-recipe fail, 20 NL-staples matching, lijst-lifecycle, notitie-maaltijd, regenerate-idempotentie, households

### Ronde 8 — categorie-bladeraar gefixt + categorie-thumbnails (2026-07-09)

- [x] **Root cause "categorieën vinden niets"**: `/v1/catalog/search` filterde op `products.aisle_group_id`, maar die kolom is 0% gevuld (`chain_category_map` is nooit geseed en de silver-seed had geen `category_path`) — live bevestigd (`{"products":[]}` voor elk schap op dev). Fix: LEFT JOIN `catalog.product_intent` (86k AI-labels, ronde 7) en filter op `COALESCE(i.aisle_group_id, p.aisle_group_id)`; zoekterm matcht nu ook op `head_term`. Migratie 0026: index op `product_intent(aisle_group_id)`.
- [x] **Categorie-thumbnails** in de "product toevoegen"-sheet: `/v1/catalog/aisles` geeft per schap een `image_url` mee — de productfoto van het meest voorkomende `head_term` in dat schap (archetype: melk voor zuivel), met fallback op een basisproduct-met-foto. Aisle-kaarten in Boodschappen tonen de thumbnail (expo-image, placeholder zonder foto). Productresultaten in de categorie-bladeraar hadden al thumbnails via `CrossChainList`.
- [ ] **Nog te doen: dev-deploy** (`./scripts/deploy.ps1 -Env dev -SkipInfra`) — az CLI hing in de fix-sessie; code getypecheckt (mobile + api), maar live verificatie van beide endpoints moet nog na deploy.

### Ronde 7 — AI-productintent-fundament (2026-07-08): stokbrood≠toast, sperziebonen-blik, roomboter-hint, appel≠appelsap

- [x] **Migratie 0025** `catalog.product_intent`: per product een AI-label — `head_term` (kale NL-kern: "volle melk", "sperziebonen", "croissant"), `form` (vers/blik/pot/diepvries/gedroogd/houdbaar/bewerkt/non-food), `is_base` (basisingrediënt vs kant-en-klaar/samengesteld), `aisle_group_id` (de 20-groepen-taxonomie, was 0% gevuld op producten).
- [x] **`scripts/label-product-intent.mjs`**: OpenAI (gpt-5.4-mini), hervatbaar via `name_hash`, batches van 40, budget-guard (`--max-usd`). **86.406 producten gelabeld voor ~$4,36** van het $120-budget van de owner — retry-supervisor ving een tussentijdse PG-firewall-hik op zonder verlies.
- [x] **Matcher-integratie** (`match.ts`): `is_primary` gebruikt nu primair `head_term` (exact of kop-uitbreiding, bv. "volle melk" bij query "melk"), met een `is_base`-poort én composite-woord-check (soep/saus/mix/gebak) op dat pad — en vorm-demotie (blik/pot/gedroogd zakt onder vers bij verse-productgroepen, tenzij de query zelf om die vorm vraagt). `pickSaneBest` kreeg `anchorHead`: een verankerde substitutie (Alles-bij-X) moet hetzelfde ZIJN als het gepinde product, niet alleen tekstueel gelijkend — stokbrood wordt bij een andere keten nooit meer toast.
- [x] **`scripts/substitution-eval.mjs`** (nieuw): 20 staples × 6 anker-ketens × 5 doelketens (~600 checks), simuleert exact het `priceList`-pad. Vond via rigoureus testen **twee structurele matcher-bugs**, beide gefixt:
  - een generieke prefix/lengte-fuzzy-heuristiek liet "appel" matchen met "appelsap" (sap!) — verwijderd; de curated lexicon-aliassen (appel/appels/appelen) dekken pluralvormen al veilig zonder die heuristiek.
  - het nieuwe `head_term`-pad miste de `is_base`/composite-guard die het oudere canonical-fallback-pad al had, waardoor kant-en-klaar-producten wier kop toevallig op de zoekterm eindigde (Cup-a-Soup Tomaat, Chicken Tonight Romige Tomaat, Rode kool met appel, Koopmans Broodmix) soms toch `is_primary` werden — gefixt.
  - **Live bevestigd na deploy**: "roomboter"@Spar → "Spar roomboter goud" (kaastengel niet meer primary/best); "appel"@Dirk → "Kanzi Appelen" (Flevosap appelsap niet meer primary); "sperziebonen"@Aldi → verse "Sperziebonen" wint (0.90) ruim vóór de blik-vorm (0.68).
  - Resterende ~78 door het testscript gerapporteerde afwijkingen zijn overwegend valse positieven van het testscript zelf (strikte string-vergelijking waar de matcher al correct morfologisch matcht, bv. appel/appelen/appels — alle drie al `is_primary=true` in de praktijk) of eerlijke catalogus-hiaten per keten (een chain heeft simpelweg geen schone witte rijst en valt terug op snelkookrijst — `is_primary` staat daar al correct op `false`, er is gewoon geen beter alternatief).
  - **Nieuwe bevinding, nog niet opgelost**: voor "tomaat" bevat de shortlist bij Jumbo/PLUS/Dirk in de top-5 geen enkele verse tomaat — alleen samengestelde producten (hummus, aioli, cup-a-soup), stuk voor stuk correct `is_primary=false`, maar bij gebrek aan een primary alternatief in de shortlist wordt zo'n non-primary toch de "best"-fallback. Dit wijst op een trgm-scoringsprobleem (of catalogus-gat) specifiek voor "tomaat" bij die ketens — apart onderzoek nodig, niet binnen deze ronde gefixt.
- [x] **Keyboard-fix**: de typ-sheets in Plannen (notitie-maaltijd) en Boodschappen (item-zoek, bewaar-lijstje) zaten onder het telefoon-toetsenbord verstopt — `KeyboardAvoidingView` toegevoegd, getypecheckt.
- [x] **Regressie**: `match-eval` 93,7% (600 items), geen verslechtering t.o.v. de 94,8%-baseline van vóór deze ronde (het verschil zit in twee items die door de striktere `is_base`-poort nu een iets lagere maar nog steeds correcte match kregen — binnen ruis).

### Ronde 6 — huishouden-beheer met rechten, recepten delen, profielfoto's (2026-07-08 nacht)

- [x] **Rechtenmodel** (migratie 0024): rollen owner (admin) / editor (mag bewerken) / viewer (alleen lezen); bestaande 'member' → editor. **Server-enforced**: sync-push weigert elke mutatie van een viewer op huishouden-rijen (incl. afvinken; expliciet gedeelde `shared_with`-lijsten blijven schrijfbaar), child-inserts checken de rol via de parent, een rij ín een huishouden hangen vereist zelf schrijfrechten dáár (dichtte ook het gat dat je een willekeurig household_id kon zetten), `list-generate` eist schrijfrechten, uitnodigen is admin-only.
- [x] **Beheerscherm `/huishouden`**: leden met profielfoto, rol-label en "laatst actief" (devices.last_seen_at, ververst bij token-rotatie); admin deelt rechten toe per lid (chips Mag bewerken / Alleen lezen via nieuwe PATCH members-endpoint, eigen rol kan niet — er blijft altijd een admin), verwijdert leden, nodigt uit; leden kunnen verlaten. Profiel kreeg een "Huishouden"-instellingenrij; de oude invite/household-sheets op Profiel zijn vervangen.
- [x] **Profielfoto's**: tik op je avatar (Profiel) → expo-image-picker → POST /v1/me/avatar (base64 → publieke `avatars`-blobcontainer, `users.avatar_url` + cache-bust). Zichtbaar op Profiel, in de Ontdek-header (kv-cache) en in het beheerscherm. NB: `stprakkiedev` kreeg `allowBlobPublicAccess=true` via az — **bicep moet dit ook zetten** anders draait een volledige infra-deploy het terug.
- [x] **Recepten delen met huishouden**: actie "Deel met huishouden" op de receptpagina (zet `household_id`; visibility bestond al in sync) + nieuwe filterchip **"Gedeeld"** in Ontdek naast "Mijn recepten" ("Mijn" filtert nu echt op eigenaarschap via owner_id).
- [x] **Onboarding-tour**: extra stap "Je huishouden beheren" (rechten, uitnodigen admin-only, delen) — nu 6 stappen.
- [x] **Live probes** (twee gast-sessies, opgeruimd): huishouden 201 + rol owner; avatar-upload 200, URL op /v1/me én blob publiek leesbaar (200); recept delen applied mét household_id; members-endpoint levert rol + laatst-actief; eigen-rol-PATCH → 400; níét-lid die naar andermans huishouden deelt → forbidden en ziet het gedeelde recept niet in zijn pull. Volledige viewer-blokkade e2e vergt een tweede e-mail-account (grondlogica identiek aan de wél geteste niet-lid-weigering).

### Ronde 5 — "echte roomboter eerst": is_primary relevantie-fundament

- [x] **Probleem**: zoeken op "roomboter" toonde croissants/appelflappen/boterhamzakjes vóór echte boter — de suggestielijst sorteerde puur op prijs (banden waren op verzoek weg) en goedkoop gebak wint dat altijd. Plus een vergiftigde hint: "Spar kaastengel roomboter" stond als rank-1 lexicon-hint.
- [x] **`is_primary` op elke matcher-kandidaat** (match.ts, drie lagen): (1) canoniek exact gelijk aan term/alias → zeker primary; (2) samengesteld-woord (gebak/gerecht; suffix-match vangt boterhamZAKJES/eiercakeJES/roomIJS, apostrof-veilige fold vangt "kano's") in naam of canoniek dat de query zelf niet noemt → zeker niet; (3) restwoord-net: canoniek woord dat geen alias, geen kwaliteits-adjectief (gesloten whitelist: gezouten/verse/bio/goud/…) en geen marker is → kop van een ander product ("roomboter KAASKANTJES", "KRAKELINGEN roomboter") → niet primary.
- [x] **LES (aanname gefalsificeerd)**: de AI-canonieken zijn óntmerkte productnamen, geen kop-labels ("Spar kaastengel roomboter" → "kaastengel roomboter", soms zelfs gehusseld) — een NL-kop-finaal "eindigt-op-term"-regel werkt dus niet; exact-gelijk + uitsluitingsregels wel.
- [x] **Client sorteert primary→prijs** (ProductOptions, beide lijsten): één vlakke lijst, eerst alle échte varianten goedkoopste-eerst, dan de samengestelde producten. `pickSaneBest` kreeg primary als eerste sorteersleutel + verbrede tier wanneer een niet-primaire lexicon-hint bovenaan staat.
- [x] **Hints geschoond**: migratie 0023 (marker-regel; eerdere kop-match-versie op dev hersteld via) volledige reseed — 517 hints met nieuwe guards (DISH_WORDS + canonical-marker-check in seed-lexicon-hints.mjs, zodat de nachtelijke loop de rommel niet terugbrengt).
- [x] **Bewijs**: eval 94,8% (600 gescoord, incl. roomboter-canary). Live: eerste 10 cross-chain-rijen voor "roomboter" zijn allemaal echte boter (Aldi €1,35 eerst); kano's/appelflap/kaastengel gedegradeerd; Spar's best = "Spar roomboter goud". Regressies groen: melk→zuivel, volle melk→Volle Melk 1L, croissant→croissants (dáár juist primary), sandwichspread→spread.

### Ronde 4b — verankerde substitutie ("Melkan halfvolle werd AH Volle melk")

- [x] **Waarom term-matching niet genoeg was**: de lijstterm is vaak generiek ("melk") en `lexicon_products` heeft daar een rank-1-hint op AH Vólle melk — de gepinde halfvolle keuze van de user legde het altijd af. De intentie zit in het gekózen product, niet in de term.
- [x] **Anker-substitutie in `priceList`**: heeft een item een `user_pinned` product, dan wordt dát het anker voor alle andere ketens — (1) de canonieke naam van het anker (`name_canonical`: "Melkan halfvolle houdbare melk" → "halfvolle melk") vervangt de generieke term en verslaat lexicon-hints, mét variant-penalty als vangnet; (2) `imageNeighbours()` (export uit match.ts) levert foto-gelijkende sku's bij de doelketen als voorkeur in `pickSaneBest` (weegt mee bij twijfel-matches < 0.70); (3) de anker-pakmaat vult de maat-eis aan als de regel geen hoeveelheid heeft.
- [x] **Pin invalideert oude automatches** (client): `pinProduct` gooit niet-gepinde ketens-matches weg zodat de server ze vers en verankerd her-afleidt — geen stale "AH Volle melk" meer uit een eerdere ronde.
- [x] **Live bewezen** (e2e met gast-sessie, opgeruimd): item "melk" + Aldi "Verse halfvolle melk" gepind → AH-substituut = **"AH Halfvolle melk"** (0.90); "sandwichspread" + Jumbo Heinz naturel gepind → AH = **"Heinz Sandwich spread naturel"** (niet "AH Sandwich bacon ei").
- [x] Beeld-embeddings worden hierdoor structureel benut bij substitutie — de backfill (~23k resterende foto's) verhoogt de dekking vanzelf.

## Owner-directives ronde 4 (2026-07-07 avond) — logische substituties (playtest-pass Boodschappen)

- [x] **Wortel-oorzaak "AH volle melk → Jumbo halfvolle 6×200ML"**: het lexicon (0009) had `volle melk` als *alias* van `melk` — de variant werd vóór het matchen weggegooid. Migratie **0022**: volle/magere melk, wit/bruin/volkorenbrood, magere kwark, witte/zilvervliesrijst zijn eigen entries; vertalingen blijven alias. Effect: varianten mergen niet meer weg in `generateLines` en de matcher-query behoudt het variantwoord.
- [x] **Variant-conflict-penalty** (match.ts, −0.50): query noemt "volle" en product zegt "halfvolle/magere/lactosevrij" → fout product, hard omlaag. Woordgrens-veilig (`\m..\M`): "volle" matcht niet ín "halfvolle".
- [x] **`pickSaneBest`** (match.ts, ook gebruikt door pricing): de stille default is nooit een multipack/tray tenzij de query erom vraagt, en mét bekende benodigde hoeveelheid wint het pak tussen 0,5×–2× die maat (1 L nodig → 1L-pak). Grijpt alléén in als de top écht scheef zit; shortlist blijft compleet.
- [x] **`priceList` substitueert maat-bewust**: ketens zonder opgeslagen match krijgen `pickSaneBest(shortlist, {neededBase})` — dit voedt de keten-chips én *Alles bij X*.
- [x] **Matchterm-hygiëne client**: `pinProduct` bewaart `item_normalised` (kale ingrediëntterm); een gepinde brand-titel wordt nooit de zoekterm richting andere ketens.
- [x] **Eerlijke substituties**: *Alles bij X* stempelt de échte match-confidence (niet 1.0); regels < 0.6 tonen "automatisch vervangen — controleer".
- [x] **Eval**: 4 canaries (volle melk / wit brood / bruin brood / witte rijst) toegevoegd; run groen ≥90% zonder regressies (2 nieuwe misses = catalogus-gaten Dirk/Spar). **Live bewezen na deploy**: best @ Jumbo = "Volle Melk 1 L", best @ Aldi = "Verse volle melk"; de 6×200ML-tray staat nog als kiesbare optie.
- [x] **Ontdek-zoek slim**: tsv ÓF titel-substring + relevantie-ranking (trgm-index in 0021) — "cake" vindt nu ook "Oranje cake", "Kokos cheesecake", "Bietencake" (live geverifieerd, 60 hits).
- [x] **RecipeCard web-crash**: like-hartje was een Pressable ín de kaart-Pressable (`<button>` in `<button>` op web) — hartje is nu een sibling-overlay.
- [x] Zelfde deploy: platte productsuggestie-lijst (banden weg, puur prijs), lijst-delen met losse huisgenoten (`lists.shared_with`, 0021 + visibility + UI-sheet), week-strip zonder datumkop (pijltjes naast de dagen, maand eronder), draft-footer zonder statusteksten, Recepten-filterbalk (Mijn recepten-chip + prijs/tijd-sliders, dependency-vrije `FilterSlider`), tour-tekst over huishouden/rollen + rol (admin/lid) op Profiel.

## Owner-directives ronde 3 (2026-07-07) — Ontdek als thuisscherm, maaltijdslots, logout

- [x] **Recepten-tab omgedraaid**: Ontdek is nu het standaardscherm bij openen; "Mijn recepten" is het segment-filter. Ontdek-kaarten kregen een like-hartje (bewaar/verwijder uit eigen bibliotheek via `source_url`-match); `discover-feed` geeft nu ook `source_url` mee. Voorraadknop + hele Voorraadkast-scherm (`pantry.tsx`) verwijderd — "koken met wat je op voorraad hebt" is weg.
- [x] **Ontdek gevuld**: lokale crawler-burst (Azure-timeout van ~4 min omzeild) — 1676 recepten live (24Kitchen 400, Uit Paulines Keuken 399, Leukerecepten 399, Jumbo 398, Lekker en Simpel 80). Sitemap-fixes: jumbo.com (juiste pad), voedingscentrum.nl uiteindelijk uitgeschakeld (geen Recipe-JSON-LD op de pagina's), plus.nl/smulweb.nl uit (onbereikbaar/SPA-404). Feed-limit 30→60.
- [x] **Plannen v2**: `meal_slot` kreeg een vierde waarde `snack` (migratie 0017, live geverifieerd via sync-push/pull round-trip). UI groepeert per dag in ontbijt/lunch/avondeten/tussendoor; elk gerecht editable (slot wisselen, porties, dag verplaatsen) en verwijderbaar. Nieuwe kalender-sheet op de CTA: kies de boodschappen-dag, hoeveelheden worden server-side opgeteld per canonieke term (bestaande `generateLines`-logica, geen wijziging nodig) — supermarkt/variant kiest de user daarna op Boodschappen.
- [x] **Echte supermarkt-logo's**: 11 merk-logo's gedownload (Wikipedia/Clearbit/favicon-fallback) naar `assets/images/chains/`; nieuw `ChainLogo`-component met initialen-fallback voor onbekende ketens. Ingeplugd in Boodschappen (groepen + "Waar ga je halen?"), Profiel (supermarkten-rij + kiezer) en de onboarding-tour.
- [x] **Login/uitloggen**: nieuw `/login`-scherm (in-/registreren); `logout()` (bestond al in api.ts, was nergens aan UI gekoppeld) nu bereikbaar via Profiel — wist lokale replica + tokens, terug naar login. Sessie blijft bewaard bij app-sluiten (ongewijzigd SecureStore-gedrag); alleen expliciet uitloggen breekt de sessie.
- [x] **Onboarding-tour**: vervangt het oude eenmalige chain-select-scherm. Next-next-next overlay met pijl naar het tab-icoon; stap 1 (supermarkten kiezen op Profiel) is niet-overslaanbaar, daarna Recepten (Ontdek + import via +, met trial/quota-copy), Plannen (slots + kalender-CTA), Boodschappen. Getriggerd door `prakkie.tour_pending` (gezet bij registratie).
- [x] Meer top-marge op alle tab-schermen (`insets.top + 8` → `+24`) — zat te dicht tegen de statusbar.
- [~] **Beeld-embeddings backfill hervat**: stond op 62.733/85.853 (73%, gestopt sinds 15:09 die dag) — vervolg-run gestart voor de resterende ~23k productfoto's (§ Beeld-embeddings hierboven).

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
