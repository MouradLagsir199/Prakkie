# Plan 12 — Boodschappen-redesign: de Virtuele Nederlandse Supermarkt

> Bron-spec: [`REDESIGN/virtual_dutch_supermarket_feature.md`](../REDESIGN/virtual_dutch_supermarket_feature.md) (2026-07-11).
> Dit document vertaalt die spec naar een gefaseerd bouwplan op de bestáánde Prakkie-fundamenten.
> Kernbelofte blijft ongewijzigd: **"Loop door één virtuele supermarkt. Shop bij álle supermarkten. Vergelijk automatisch."**

---

## 0. Waarom dit haalbaar is — wat er al ligt

De spec vraagt om een visuele winkel bovenop een prijsvergelijkings-engine. De engine bestaat al; de winkel is nieuw. Concreet herbruikbaar:

| Spec-onderdeel | Bestaat al als |
|---|---|
| Afdelingen/taxonomie | `catalog.aisle_taxonomy` (20 groepen) + **`catalog.product_intent`** (86k AI-labels: `head_term`, `form`, `is_base`, `aisle_group_id`) |
| Categorie-panelen ("Halfvolle melk") | `head_term` is exact dit granulariteitsniveau — alleen curatie + aggregatie ontbreekt |
| Panel → productlijst per keten | `GET /v1/catalog/search` + `GET /v1/match` (cascade-matcher met correcties/lexicon/trgm/beeld-tier) |
| Cross-chain productvergelijking (prijs, eenheidsprijs, bonus-mechanic, foto) | `ProductOptions.tsx` → `CrossChainList` — 1-op-1 de product-sheet uit spec §14 |
| Gecombineerde multi-super-mand | `list_items.matches` (per-keten keuze, `user_pinned`), draft/Opslaan-model, per-super groepen + subtotalen (Boodschappen v3) |
| Mand-optimalisatie | "Alles bij X" + "Slim verdelen" (client `storeAdvice`) + server `GET /v1/lists/{id}/compare` |
| Prijstransparantie | `unit_price_cents_per_std`, promo-mechanics, staleness ("prijzen van {datum}"), eerlijke gaten (geen halve totalen) |
| Boodschappenlijst-invoer | zoeklijst-kv, weekplan-import, recept→lijst, `/v1/prakkie/resolve` |
| Bladeraar-prototype | `apps/mobile/src/app/lijst/schappen.tsx` — de "platte catalogus" die de spec juist wil vervangen, maar de dataflow klopt |

**Wat écht nieuw is:** (1) de visuele 2.5D-winkelomgeving, (2) een gecureerde panel-registry met live aggregaten (aantal · vanaf-prijs · #supers · bonus), (3) de winkelplattegrond + lijst-geleide route, (4) het driestanden-productsheet, (5) subtiele game-laag (besparings-feedback, voortgang).

---

## 1. Bewuste afwijkingen van de spec (klein, met reden)

Het hoofdconcept — virtuele winkel — blijft. Vier afwijkingen:

1. **Geen 5-tab navigatie (spec §22).** Prakkie is recepten-eerst met 4 tabs (Recepten/Plannen/Boodschappen/Profiel). De Boodschappen-tab **wordt** de winkel ("Winkel"-ervaring); Zoeken, Mandje en Lijst leven ín de winkel als vaste overlay-elementen (zoekbalk boven, zwevende winkelwagen-knop met teller onder, lijst-paneel). *Reden: de spec is geschreven voor een standalone shopping-app; Prakkie's recepten- en plan-tabs kunnen niet wijken, en 6+ tabs fragmenteert.*
2. **De "mand" = het bestaande lijst-model, geen nieuwe entiteit.** De virtuele winkelwagen schrijft naar dezelfde `lists`/`list_items` + draft-model als vandaag. *Reden: sync, huishouden-deling, rechten, cart-handoff en de leer-loop (E5-correcties) werken daar al op; een tweede basket-entiteit forkt state en dupliceert alle randgevallen.*
3. **Equivalentie-groepen (§14.4) via `product_intent`, geen nieuwe entiteit.** `head_term` + `is_base` + `form` ís de groepering (halfvolle ≠ volle ≠ lactosevrij zit in head_term/vorm); "verwante alternatieven" = gerelateerde head_terms binnen hetzelfde panel. *Reden: 86k producten zijn al gelabeld; een aparte groeps-entiteit is dubbel onderhoud.*
4. **Bezorg-/ophaalkosten, minimum-orders en loyaliteitskaart-condities als data bestaan niet → gefaseerd.** Optimalisatie-presets die alleen prijsdata nodig hebben schepen mee (laagste prijs, alles-bij-één, slim verdelen, max-2-winkels, voorkeurswinkels); fee-bewuste presets (§16.2 "lowest total including fees", delivery/pickup) komen ná een `chain_fees`-configtabel. Bonus-condities (mechanic-tekst) tónen we wel — die data is er. *Reden: eerlijkheid is een kernwaarde van dit product; geschatte fees verzinnen is erger dan ze eerlijk weglaten ("excl. bezorgkosten").*

Verder één scope-keuze: **6 live ketens** (ah/jumbo/plus/dirk/spar/aldi), niet de 11 uit de spec-ambitie — panelen tonen eerlijke keten-tellingen.

---

## 2. Architectuur van de winkel

### 2.1 Rendering: authored scenes, geen 3D-engine

Stack blijft RN 0.86 + Expo 57 + Reanimated 4 + `react-native-svg` + `expo-glass-effect` + `expo-image`. Géén Skia/three.js erbij (spec §7.2 verbiedt free movement toch al; §26.1 vraagt expliciet om gescheiden statische assets + live data).

Eén afdeling = één **scene**:

```
DepartmentScene
├── backdrop        pre-rendered illustratie (stylized 2.5D gangpad, per afdeling)
├── fixtures[]      interactieve RN-views, gepositioneerd via scene-manifest
│     GlassPanel | FreezerDoor | FridgeShelf | ProduceTable | BakeryRack | EndCap
├── overlays        zoekbalk (top) · plattegrond-knop · winkelwagen-FAB (bottom)
└── ambient         Reanimated-loops (koellicht-glow, mist, prijskaart-flip) — uit bij reduced motion
```

- **Scene-manifest** (JSON per afdeling): backdrop-asset, secties (horizontale snap-pagina's), fixture-slots `{type, x, y, w, h}` in genormaliseerde scene-coördinaten, elk gebonden aan een `store_category_id`. Handmatig geauthored, dus voorspelbaar en licht.
- **Navigatie**: horizontale snap-scroll tussen secties binnen een afdeling (parallax op de backdrop via scroll-interpolatie); afdeling-wissel via plattegrond of "volgend vak"-pijl. Transitie-budgetten uit spec §7.3 (150–300 ms sectie, 300–600 ms afdeling).
- **Placeholder-first**: fixtures zijn volledig code-gerenderd (glas-effect, gradients, tokens) en werken op een egale sfeerkleur per afdeling vóórdat er backdrop-art bestaat. Art is een parallelle track, nooit een blocker.
- **Toegankelijkheid**: elk fixture is een `accessibilityRole="button"` met label "«Halfvolle melk», 42 producten, vanaf €0,99"; daarnaast blijft een **lijst-modus** (doorontwikkelde `schappen.tsx`) als volwaardig alternatief (spec §28).

### 2.2 Data: panel-registry + aggregaten

Nieuw in `catalog.*` (migraties):

```sql
catalog.store_departments   -- ~10 winkel-afdelingen (MVP), mapping op 20 aisle-groepen
  (id, slug, name_nl, sort, fixture_theme,        -- 'dry' | 'fridge' | 'freezer' | 'produce' | 'bakery'
   aisle_group_ids smallint[])

catalog.store_categories    -- de gecureerde "glazen panelen", ~120–200 stuks
  (id, slug, name_nl, department_id, fixture_type, section, shelf_pos,
   head_terms text[],       -- binding op product_intent.head_term (de query-definitie)
   keywords text[],         -- zoek-synoniemen
   related_ids int[])       -- "verwante alternatieven" (§14.4)

catalog.store_category_stats -- nachtelijk ververst (bestaat als tabel, geen matview-lock-gedoe)
  (category_id, chain_id, product_count, min_price_cents, min_unit_price, promo_count, refreshed_at)
```

- **Curatie-pipeline**: `scripts/generate-store-categories.mjs` genereert kandidaten uit `product_intent` (head_term × aisle, gerangschikt op productdekking over ketens) → CSV → owner cureert → seed-migratie. Zo is de registry data-gedreven begonnen maar redactioneel af.
- **Stats-refresh** haakt in de bestaande nightly (`price-precompute`-timer) + `ops/`-trigger.

Nieuwe endpoints (`services/functions-api/src/functions/store.ts`):

| Route | Doel |
|---|---|
| `GET /v1/store/home` | afdelingen + samenvatting (panelen-count, bonus-count, "verder waar je was") — de entree |
| `GET /v1/store/department/{id}?chains=` | scene-payload: panelen met `product_count / min_price / chain_count / promo_count` uit stats, gefilterd op de ketens van de user |
| `GET /v1/store/category/{id}/products?chains=&sort=` | panel-inhoud: producten cross-chain via head_terms (hergebruikt catalog-search-query, plus `is_base`-band "beste matches / meer opties"), sorteringen uit §14.3 |

Client houdt spec §26.2 aan: shell direct, summaries apart (kv-cache per afdeling), producten pas bij panel-tap, stale data gelabeld met bestaande staleness-copy.

### 2.3 De shop-loop (panel → sheet → mand)

1. Tap op panel → **detent-bottom-sheet** (3 standen: preview / half / vol; winkel blijft zichtbaar op half). Voorkeur: `@gorhom/bottom-sheet` v5 mits compatibel met Reanimated 4/Expo 57 — anders eigen sheet op gesture-handler (spike in fase 2, dag werk, geen risico).
2. Sheet toont `CrossChainList` (bestaand): banden beste-matches/meer-opties, bonus-flag met mechanic, eenheidsprijs, keten-logo.
3. "+" → regel in het **draft**-lijstmodel met gepind product (bestaand `pinProduct`-pad, voedt E5-correcties bij Opslaan); qty-stepper verschijnt op de kaart (spec §14.2).
4. Winkelwagen-FAB toont teller + subtotaal; tap → mand-overlay = de bestaande resultaat-weergave (per-super groepen, "Waar ga je halen?", Alles-bij-X, slim verdelen) gerestyled als "kassa/mand".
5. Sheet dicht → exact dezelfde scene-, sectie- en scrollpositie (spec §24) — scene-state leeft buiten de sheet, dus dit is gratis.

---

## 3. Fasering + TODO

> Elke fase is los shipbaar; de winkel vervangt de oude flow pas aan het eind van fase 2. Checklist-items verhuizen naar `progress.md` zodra een fase start.

### Fase 0 — Datafundament: panelen & aggregaten *(backend, ~geen UI)*

- [ ] `scripts/generate-store-categories.mjs`: kandidaat-panelen uit `product_intent` (head_term × aisle × dekking) → CSV ter curatie
- [ ] Owner-curatie kandidatenlijst → definitieve panel-set (~120–200) + afdeling-indeling (~10 afdelingen over 20 aisle-groepen)
- [ ] Migratie: `store_departments`, `store_categories`, `store_category_stats` + seeds
- [ ] Stats-refresh in nightly timer + `ops/store-stats`-trigger; staleness-veld
- [ ] `GET /v1/store/home` · `/v1/store/department/{id}` · `/v1/store/category/{id}/products` (+ zod-types in `packages/shared`)
- [ ] Panel-thumbnails: archetype-productfoto per panel (zelfde LATERAL-truc als `catalog-aisles`)
- [ ] Live verificatie op dev (gast-token, conform az-CLI-workaround) + uitbreiding `e2e-smoke`
- **Klaar wanneer:** elk panel live `count · vanaf €x,xx · n supers · bonus-count` levert voor de 6 ketens, < 300 ms warm.

### Fase 1 — Winkel-shell: navigeerbare omgeving *(mobiel)*

- [ ] Scene-manifest-formaat + loader (`apps/mobile/src/store/scenes/*.json`)
- [ ] Fixture-componenten: `GlassPanel`, `FreezerDoor`, `FridgeShelf`, `ProduceTable`, `BakeryRack`, `EndCap` — tokens/glas-effect, states uit spec §10.3 (default/focused/pressed/loading/lijst-match/bonus)
- [ ] `DepartmentScene`: horizontale snap-secties, parallax-backdrop-laag (placeholder-kleur per thema), fixture-plaatsing uit manifest
- [ ] Entree-scherm (`/v1/store/home`): afdelings-strip, "verder waar je was", zoekbalk, lijst-knop — géén verplichte landing bij terugkeer (spec §9)
- [ ] Plattegrond-sheet: gestileerde SVG-blokken, tap = afdeling-jump, huidige-locatie-marker
- [ ] Boodschappen-tab → winkel-entree; oude flow bereikbaar via tijdelijke "klassieke weergave"-link
- [ ] Reduced-motion: alle ambient/parallax uit via `AccessibilityInfo.isReduceMotionEnabled`
- [ ] Performance-check op mid-range device + web-export sanity (expo web is het dagelijkse testkanaal)
- **Klaar wanneer:** door 10 afdelingen swipen/springen met live panel-data, 50–60 fps, sectie-transitie < 300 ms.

### Fase 2 — Shop-loop: panel → sheet → mand *(de kern)*

- [ ] Spike: `@gorhom/bottom-sheet` v5 op Expo 57/Reanimated 4 → anders eigen detent-sheet (besluit vastleggen)
- [ ] Product-sheet met 3 standen; `CrossChainList` erin; sorteringen (aanbevolen/goedkoopst/eenheidsprijs/bonus/keten); sluiting via knop/swipe/back (spec §14.1)
- [ ] Toevoegen → draft-lijst met pin (hergebruik `pinProduct`-pad + `_unit_cents`-schaal); qty-stepper op productkaart
- [ ] Winkelwagen-FAB (teller + subtotaal, altijd zichtbaar in de winkel) → mand-overlay: restyle van bestaand resultaat-scherm (per-super groepen, totalen, Opslaan/Annuleren-draft)
- [ ] Optimalisatie-presets in de mand: laagste prijs · alles bij één · slim verdelen (bestaand) + **max 2 winkels** + **voorkeurswinkels** (nieuw, client-side op bestaande pricing); uitleg-regel bij elk advies (spec §16.3), voetnoot "excl. bezorgkosten"
- [ ] Context-behoud: sheet dicht = zelfde scene/sectie/scroll (spec §24, acceptatie #10)
- [ ] Besparings-microfeedback: "€0,45 goedkoper"-toast + haptic bij goedkoper alternatief (subtiel, spec §18.2)
- [ ] Oude `samenstellen`/`schappen`-entree vervangen; `schappen.tsx` doorontwikkelen tot **lijst-modus** (a11y-alternatief, spec §28)
- [ ] `e2e-components`-uitbreiding: panel→product→mand-flow live
- **Klaar wanneer:** acceptatie #3 (categorie openen + product toevoegen in 2 interacties) en #7/#8 (multi-super-mand met totalen per super) live werken.

### Fase 3 — Lijst-integratie, route & zoeken

- [ ] Actieve lijst → panel-markers: lijstregels (item_normalised) → head_terms → fixtures krijgen lijst-badge; afgevinkte categorieën dimmen
- [ ] Plattegrond toont resterende lijst-items per afdeling + "volgend vak"-suggestie (optionele geleide route, spec §17.1)
- [ ] Lijst-paneel in de winkel: bestaande lijsten/weekplan-import/opgeslagen lijstjes bereikbaar zonder de winkel te verlaten
- [ ] In-winkel zoeken: `/v1/match`-resultaten + actie "ga naar schap" (jump naar afdeling + panel auto-open) — acceptatie #13
- [ ] "Eerder gekozen"-rail bij panel-opening (uit match_corrections/lijst-historie); favorieten-markering v1
- [ ] Checkout-einde: lijst-klaar-moment → totaal + besparing + handoff (bestaande AH-deeplinks/kopieer-lijst)
- **Klaar wanneer:** een weeklijst van 15 regels via de geleide route in te winkelen is zonder zoeken buiten de winkel.

### Fase 4 — Art & beleving *(parallel aan 2–3 te starten)*

- [ ] Art-richtlijn: stijlgids backdrop-illustraties (warm NL-supermarkt, neutraal merk, Prakkie-palet) + generatie-prompts per afdeling
- [ ] Backdrops 10 afdelingen (2–3 secties per afdeling) — gecomprimeerd, texture-budget per scene, laadstrategie (alleen aangrenzend preloaden)
- [ ] Afdeling-specifieke fixture-skins: koeling (glasdeuren, koellicht, condens-accent), diepvries (frost), AGF (kratten/tafels), bakkerij (warm licht, rekken)
- [ ] Ambient-details (spec §19, max 2–3 per scene): deur-glow, prijskaart-flip, mist-puls — allemaal uit bij reduced motion / low-power
- [ ] Eén seizoens-eindkap als proof (bijv. zomer/BBQ) op de entree — zelfde panel-interactie, nooit blokkerend (spec §34)
- [ ] Voortgang/afronding: mandje-vult-zich-indicator, lijst-compleet-moment (kort, skipbaar)
- [ ] Geluid/haptiek: opt-in, standaard uit (spec §29)
- **Klaar wanneer:** acceptatie #15 — "het oogt als een supermarkt, niet als een catalogus" — owner-sign-off.

### Fase 5 — Hardening & lancering van de redesign

- [ ] Error-states uit spec §33: prijs onbeschikbaar / leeg panel / keten-storing (winkel blijft bruikbaar) / product vervallen na keuze
- [ ] Offline: gecachte winkel-shell + laatst bekende panelen/prijzen met label; mand-wijzigingen queuen (bestaand offline-engine-pad)
- [ ] A11y-pass: screenreader door hele shop-loop, focus-volgorde, contrast, 44px-targets, lijst-modus feature-pariteit
- [ ] Performance-doelen meten (spec §26.3): entree < 2 s, afdeling uit cache < 1 s, sheet < 250 ms, mand-feedback < 100 ms
- [ ] Analytics-events (spec §32 basisset): store_entered, department_opened, panel_tapped, product_added, basket_optimized, search_used
- [ ] Oude schermen opruimen (`samenstellen`/`resultaat`-restanten), routes/redirects, tour-stap "Boodschappen" herschrijven op de winkel
- [ ] `e2e-smoke` + `e2e-components` volledig groen; match-eval geen regressie
- **Klaar wanneer:** alle 20 acceptatiecriteria uit spec §37 afgevinkt (fee-gerelateerde delen van #9 conform afwijking 4).

### Later / v2 (bewust buiten deze redesign)

- `chain_fees`-configtabel → fee-bewuste presets ("laagste totaal incl. kosten", delivery/pickup-filters)
- Prijshistorie-grafiek in productdetail (`catalog.price_history` bestaat al)
- Echte product-favorieten-entiteit + "vaste boodschappen"-schap
- Personalisatie (favoriete afdelingen naar voren, thema's/trolley-skins), avatar
- Tablet/web side-by-side layout (spec §25.3–25.4)
- Meer ketens (Vomar/Hoogvliet/Ekoplaza/Picnic/DekaMarkt) zodra connectors landen

---

## 4. Risico's & mitigaties

| Risico | Mitigatie |
|---|---|
| **Art-assets worden de bottleneck** (10 afdelingen × secties, consistente stijl) | Placeholder-first: fase 1–3 draaien volledig op code-gerenderde fixtures + sfeerkleuren; art is een parallelle track met eigen sign-off |
| **Panel-curatie valt tegen** (head_terms te lang-staartig/rommelig) | Kandidaten-script rangschikt op keten-dekking; panelen mogen meerdere head_terms bundelen; start met 8–10 afdelingen en de 120 sterkste panelen (spec §35 vraagt niet meer) |
| **Perf op mid-range** (parallax + glas-effecten + lijsten) | Budget per scene (1 backdrop + ≤12 fixtures), Reanimated op de UI-thread, LOD: glas→plat bij lage refresh, meten in fase 1 niet fase 5 |
| **Bottom-sheet-dependency past niet** op RN 0.86/Reanimated 4 | Spike vroeg in fase 2 met harde fallback (eigen detent-sheet, beperkte scope) |
| **Trage winkel = spec-doodzonde** (§3: nooit langzamer dan zoeken) | Zoekbalk + lijst-modus + "verder waar je was" vanaf fase 1; snelheids-acceptatie (#2, #3) is gate per fase, geen eind-check |
| **Promo-data ontbreekt in seed-snapshot** | Bonus-indicatoren degraderen netjes (geen flag i.p.v. lege flag); verse scrape-run vult ze — bestaand bekend gat |
| **Dubbele waarheid oud/nieuw scherm tijdens de bouw** | Winkel schrijft vanaf dag één naar hetzelfde lijst/draft-model; oude flow blijft read-compatible tot fase 5-opruiming |

## 5. Owner-inputs die dit plan nodig heeft

1. **Panel-curatie-ronde** (fase 0): CSV met kandidaten doornemen — het enige echt redactionele werk.
2. **Art-besluit** (fase 4): AI-gegenereerde backdrops in stijlgids vs. externe illustrator vs. langer op placeholder-thema's shippen.
3. **Afdelingen-indeling MVP**: voorstel 10 afdelingen (AGF · Bakkerij · Zuivel & kaas · Vlees, vis & vega · Ontbijt & beleg · Voorraadkast · Snoep & snacks · Dranken · Diepvries · Huishouden & verzorging) — akkoord of schuiven.
4. **Sign-off game-laag**: hoe speels mag het (streaks/milestones uit §18.1 aan of uit bij launch).
