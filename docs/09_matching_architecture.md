# Cross-supermarkt matching v2 — Canonical Product Graph + Basket Optimizer

> **Status: ontwerp / plan (nog niet gebouwd).** Dit document beschrijft de
> volgende matcher-architectuur (`graph-v1`) die het huidige `policy-v2-ean`
> regime (zie [07_matching_policies.md](07_matching_policies.md)) opvolgt. Het
> doel is één ding: **direct een eerlijk totaal per supermarkt tonen** zonder dat
> de gebruiker elk mandje handmatig hoeft samen te stellen — en substantieel
> beter dan alles wat er eerder stond. Fasering, tabellen en poorten staan
> onderaan. Niets hierin verandert de runtime totdat een fase expliciet wordt
> gebouwd en de evalpoort haalt.

## 1. Het probleem, scherp

`policy-v2-ean` is **eerlijk maar te streng**. Product→product substitutie loopt
alleen op exacte EAN/GTIN. Gevolg (bewust, gedocumenteerd): **huismerken
substitueren nooit** — AH huismerk cola zero en PLUS huismerk cola zero hebben
elk hun eigen EAN, dus nul cross-chain matches. Juist huismerk is het grootste
deel van een Nederlands mandje. De gebruiker moet daardoor elke keten met de
hand samenstellen. Dat is de pijn die we oplossen.

### Waarom v1 stierf (de lessen die we niet mogen vergeten)

De vorige fuzzy aanpak ("Vind mijn prakkie" + naam/foto-substitutie) is
gesloopt om drie concrete redenen (`plan/progress.md:212-249`):

1. **Verkeerde facetten.** "Koopmans Witbrood **MIX**" (een bakmix) was
   AI-gelabeld als `vers`/brood met head_term `wit brood`.
2. **Eén fragiel signaal vertrouwd.** Dat foute head_term ankerde vervolgens via
   beeldgelijkenis exact dezelfde verkeerde doos bij een andere keten — het
   signaal loog en het beeld waste de fout wit over ketens heen.
3. **Stille relaxatie.** "Geen cola zero → hier is gewone cola" telde stil mee
   in het totaal.

**Conclusie voor v2:** het probleem was nooit "matchen is onmogelijk". Het was
*ongeverifieerde facetten + één fragiel signaal + stil accepteren*. v2 draait
die drie om: **geverifieerde, multi-signaal facetten, offline voorberekend, met
een compromis-status die naar de gebruiker teruggaat.**

## 2. Ontwerpprincipes

- **Constraint satisfaction, geen similarity-score.** Een substituut is geldig
  dan en slechts dan als het de *harde* facetten van het bron-product deelt.
  Similarity (embeddings) rangschikt hooguit; het beslist nooit.
- **Zwaar werk offline, runtime deterministisch.** Alle fuzzy/AI-redenering
  gebeurt bij ingest (één keer per EAN, gecached, auditbaar). Runtime is een
  lookup in een voorberekende graaf — snel, herhaalbaar, uitlegbaar.
- **Compromis is een eersteklas, zichtbare uitkomst.** Nooit stil een harde
  facet loslaten. "Kan de harde facetten niet bevredigen" gaat terug naar de
  gebruiker.
- **Uitlegbaarheid op elke regel.** Elke auto-keuze draagt een leesbare reden
  ("gematcht: cola · zero · huismerk — verschilt: 1,5 L vs 1 L").
- **Vertrouwen verdien je, kwaliteit poort je.** Onzekere facetten mogen nooit
  auto-matchen; ze vallen naar COMPROMISE. Een precisiedrempel op een golden set
  is de release-poort.

## 3. Architectuur — vier pijlers

### Pijler 1 — Geverifieerde facet-extractie (offline)

Per EAN, één keer, gecached: reduceer elk product tot een schone struct.

```
ProductFacets {
  category            // fijnmazige categorie (frisdrank/cola, groente/sperziebonen…)
  brand_tier          // 'a_merk' | 'private_label' | 'value_line'  (NIET de merknaam)
  variant             // regular | zero | light | cafeïnevrij | …
  flavor              // regular | cherry | vanille | …
  form                // vers | blik | pot | diepvries | gedroogd | houdbaar | …
  dietary[]           // bio, lactosevrij, glutenvrij, …
  type                // categorie-specifiek subtype (kristal/basterd/riet; volle/halfvolle)
  pack {value, unit, count, std_unit, per_std_cents}
}
```

**De anti-"wit brood"-maatregel is verificatie.** De LLM-struct moet het eens
zijn met de gestructureerde velden die je al hebt (`pack_size_value`,
`std_unit`, `category_path`, `name_canonical.is_organic`, `brand`). Bij
onenigheid → **lage confidence → dit product mag niet auto-matchen** (valt naar
COMPROMISE). Facetkwaliteit wordt gepoort, niet gehoopt.

**Bouwt voort op:** `catalog.product_intent` (heeft al `form`, `head_term`,
`is_base`, `aisle_group_id`) en `name_canonical` (`canonical_key`,
`is_organic`). Nieuwe opslag: `catalog.product_facets`. Pipeline-huis:
`services/ean-enrichment` (OpenAI-sleutel al gewired).

### Pijler 2 — Canonical Product Graph (offline)

Cluster SKU's over ketens heen tot **canonieke productknopen** op basis van
facet-tuple + brand_tier. Voor huismerken adjudiceert de LLM de equivalentie
("is AH huismerk cola zero hetzelfde product-concept als PLUS huismerk cola
zero?") en slaat **confidence + leesbare redenen + provenance** per edge op.

- "Zelfde product bij andere keten" = siblings onder één canonieke knoop.
- "Substituut" = nabije canonieke knopen die de harde facetten bevredigen.
- Het dure redeneren gebeurt bij ingest, niet als de gebruiker naar een spinner
  kijkt. En het is **auditbaar** — het tegenovergestelde van de gesloopte
  "Vind mijn prakkie".

**Bouwt voort op:** `name_canonical.canonical_key` is al een proto-versie
hiervan. Nieuwe opslag: `catalog.canonical_product` + `catalog.canonical_member`.

### Pijler 3 — Per-categorie hard/zacht beleid (offline, zelf-tunend)

Een kleine, inspecteerbare tabel bepaalt *per categorie* welke facetten hard
zijn (kunnen niet weg-gerankt worden) en welke zacht (alleen rangschikking).

| categorie | hard | zacht |
|---|---|---|
| frisdrank/cola | variant, flavor | brand_tier, form, size |
| groente | form, variety | brand_tier, size, bio |
| zuivel | fat_content (type), lactosevrij | brand_tier, size |
| suiker | type | brand_tier, form, size |

- **LLM-gedraft, mens-gecontroleerd** voor je top ~50 aisle-categorieën.
- **Conservatieve fallback** voor de longtail: categorie + form hard, rest zacht
  → neigt naar "vraag het de gebruiker", nooit naar een zelfverzekerde foute
  swap.
- **Zelf-tunend:** elke keer dat een gebruiker een auto-keuze overschrijft, is
  dat een gelabeld signaal dat beleid of facetten voor die categorie fout zijn.

**Bouwt voort op:** `aisle-taxonomy.ts` (20 groepen) + de al bestaande
`freshProduce`-toggle. Nieuwe opslag: `catalog.category_facet_policy`. De
zelf-tuning-loop (`match_events`, `match_overrides_agg`,
`match_policy_calibration`) is **al gescaffold** — alleen slapend.

### Pijler 4 — Basket Optimizer (de kop-feature)

Matching is de input; dit is de uitkomst die de gebruiker wil. Gegeven de hele
lijst × jouw supers, bereken en toon **direct**:

- goedkoopste enkele winkel,
- goedkoopste multi-store split,
- "één extra stop bij Lidl bespaart €6".

**Bouwt voort op:** het bestaande `basket-compare`-endpoint (`list-ops.ts:218`).

## 4. De eerlijkheids-poort (runtime funnel)

Per lijstregel × doelketen, deterministisch, vier uitgangen:

- **EXACT** — zelfde EAN/GTIN. "Identiek product, hier goedkoper." Auto-toepassen.
- **EQUIVALENT** — ≥1 canonieke sibling bevredigt alle harde facetten. Auto-
  toepassen, rangschik op zachte facetten, toon de "waarom".
- **COMPROMISE** — kandidaten bestaan in de categorie maar géén bevredigt de
  harde facetten. **Niet** auto-kiezen; teruggeven met de gebroken facet benoemd,
  gebruiker beslist.
- **NO_MATCH** — niets in de categorie bij die keten. Eerlijk "niet beschikbaar",
  bied handmatig zoeken.

Het **directe totaal** = EXACT + EQUIVALENT. COMPROMISE + NO_MATCH klappen samen
tot een korte wachtrij: **"3 om te kiezen (+ vanaf €4,20)"**. Snel én
betrouwbaar — niet het één ten koste van het ander.

**Bouwt voort op:** `pricing.ts` levert al `accepted/review/unavailable` per
regel en `shopping-session` levert al alle policies × ketens met alternatieven.
De funnel-swap verandert *wat* de decision voedt (canonieke graaf i.p.v.
EAN-only), niet de bezorgstructuur.

## 5. Datamodel

### Nieuwe tabellen (migraties 0041+)

- `catalog.product_facets` — PK `product_id` (of `ean`). Kolommen per facet +
  `facet_confidence`, `verified boolean`, `source ('llm'|'structured'|'hybrid')`,
  `matcher_version`, `content_hash`. Onzeker/onverifieerd → sperren voor
  auto-match.
- `catalog.canonical_product` — `canonical_id`, `category`, `brand_tier`,
  facet-tuple, `label`.
- `catalog.canonical_member` — `canonical_id` × `product_id`, `edge_confidence`,
  `reasons text[]`, `method`, `provenance`.
- `catalog.category_facet_policy` — PK `(category)`, `hard_facets text[]`,
  `soft_facets text[]`, `source`, `reviewed_by`, `reviewed_at`.

### Hergebruikt (geen wijziging nodig)

`catalog.product_intent`, `catalog.name_canonical`, `catalog.aisle_taxonomy`,
`app.match_corrections`, `app.match_overrides_agg`, `app.match_events`,
`catalog.match_policy_calibration`, `catalog.ean_enrichment`.

### `app.list_items.matches` (uitbreiding)

Het `ProductMatch`-model (`packages/shared/src/product.ts:65`) krijgt er twee
velden bij, backward-compatible:

- `canonical_id?` — de canonieke knoop waaruit deze keuze kwam.
- `decision_reason?` — de leesbare "waarom" voor de UI.

`origin` breidt uit: `'automatic' | 'bulk_accepted' | 'user_confirmed'` →
+ `'graph_equivalent'` (auto-toegepaste canonieke sibling; telt mee in het
totaal, in tegenstelling tot het oude `automatic` dat werd genegeerd).

## 6. Endpoints

- **`GET /v1/lists/{id}/shopping-session`** — ongewijzigde vorm; voedt de funnel
  nu uit de canonieke graaf. Levert per regel `decision` + `decision_reason` +
  `canonical_id` + `alternatives`.
- **`GET /v1/lists/{id}/basket-plan`** (nieuw of uitbreiding van
  `basket-compare`) — de Basket Optimizer: single/split/near-optimal met
  besparing.
- **`POST /v1/lists/{id}/substitution-feedback`** — ongewijzigd; voedt nu ook
  de beleids-zelf-tuning.

## 7. Evaluatiestrategie (de release-poort)

Geen auto-toepassing gaat live vóór de golden set een precisiedrempel haalt.

- **Facet-eval** (nieuw, `scripts/facet-eval.mjs`): golden set van hand-gelabelde
  producten; meet facet-precisie per categorie. Poort voor Pijler 1.
- **Equivalentie-eval** (nieuw): hand-geoordeelde canonieke paren (vooral
  huismerk×huismerk); meet EQUIVALENT-precisie. **"wit brood → MIX" is hier een
  vastgezette regressietest** — mag nooit EQUIVALENT worden.
- Bestaand: `scripts/match-eval.mjs` (retrieval top-1), `substitution-eval.mjs`
  (EAN-dekking), `match-policy-eval.mjs` (shortlist-precisie),
  `scripts/ai-match-eval.mjs` (hergebruik als facet/equivalentie-harnas).

**Drempel-voorstel:** EQUIVALENT-precisie ≥ 98% op de golden set vóór
auto-toepassen; anders degradeert de categorie automatisch naar COMPROMISE-only.

## 8. Fasering (elke fase los shippable en veilig)

- **Fase 0 — Facet-spike (proof). ✅ GO (2026-07-21).** Facet-extractie +
  verificatie voor frisdrank/zuivel/groente/suiker/brood; gemeten tegen
  `fixtures/facet-golden.json` via `scripts/facet-eval.mjs`. Resultaat: **98,3%
  facet-precisie**, verify-gate 100% (wit-brood-bakmix uitgesloten, alle verse
  producten door). Kernlessen ingebakken: `form`/`category` komen van het schap
  (niet LLM-geraden); anti-wit-brood = gerichte "vers-label op mix/poeder"-check.
  Code: `services/ean-enrichment/src/facets.mjs` (+ `.test.mjs`, 12 tests),
  `facet-extract.mjs`.
- **Fase 1 — Facet-pipeline at scale** → `product_facets`, backfill via
  `ean-enrichment`.
- **Fase 2 — Categorie-beleidstabel + conservatieve fallback. ✅ (2026-07-21).**
  Migration `0042_category_facet_policy` (mens-bewerkbaar, geseed voor
  frisdrank/zuivel-melk/groente/suiker). `facets.mjs` laadt DB-beleid via
  `mergeCategoryPolicies()`; onbekende categorie → conservatieve in-code
  fallback. LLM-draft voor de longtail: `facet-policy-draft.mjs` (concept,
  source='llm', mens keurt goed vóór het telt).
- **Fase 3 — Canonical graph. ✅ (2026-07-21).** `canonical-graph.mjs`:
  canonicalKey = categorie + harde facetten; SKU's met dezelfde sleutel zijn
  siblings (brand_tier zacht → huismerk + A-merk clusteren samen). Migration
  0043 (`canonical_product`/`canonical_member`), builder `canonical-run.mjs`,
  5 tests. **Bewezen op dev**: de knoop `frisdrank · zero` bundelt 80 cola-zero
  SKU's over 6 ketens (huismerk G'woon/1 de Beste/Jumbo + A-merk Coca-Cola/Pepsi)
  — de cross-chain huismerk-match die EAN-only nooit kon. Verfijnpunten voor de
  facet-golden: cafeïnevrij als eigen as, "zero lemon" als flavor=lemon.
- **Fase 4 — Runtime funnel. ✅ server (2026-07-22).** `lib/basket-plan.ts`:
  anker → canonieke knoop → goedkoopste sibling per keten →
  EXACT/EQUIVALENT/COMPROMISE/NO_MATCH + uitlegbaarheid. **Additief & read-only**
  (raakt de bestaande EAN-only pricing niet). Endpoint `GET /v1/lists/{id}/basket-plan`.
  8 unit-tests; volledige functions-api-suite groen (91). Rest: deploy naar dev.
- **Fase 6 — Basket Optimizer. ✅ server (2026-07-22).** In `basket-plan.ts`:
  goedkoopste enkele winkel / split per item / besparing. Meegetest. Rest: UI.
- **Fase 5 — Client three-bucket UX** (direct totaal + wachtrij + "waarom") in
  `apps/mobile/src/app/lijst/resultaat.tsx`, consumeert `/basket-plan`. Open
  (na deploy van het endpoint).
- **Fase 7 — Zelf-tuning activeren** vanuit `match_events`/`overrides_agg` naar
  `match_policy_calibration`. Open.

### Rollout-status
1. **Deploy** functions-api → dev. ✅ `/basket-plan` live (CD 2026-07-22).
2. **Broad backfill** (dev, ~118k producten, ~$15–20 gpt-4o-mini). ✅ **draait in Azure**:
   - `caj-facet-enrich-dev` (Manual) — facet-extractie, nu bezig (~99,7% verified).
   - `caj-facet-graph-dev` (Schedule, 04:00 UTC dagelijks) — bouwt de canonical graph
     uit de facetten; goedkoop + idempotent, dus self-healing.
   - Beide: image `crprakkiedev.azurecr.io/ean-enrichment:matching-v2`, identity
     `id-ean-enrich-dev`, **`AZURE_CLIENT_ID` env vereist** (anders faalt de
     managed-identity KV-fetch in de SDK). Nog te doen: in Bicep gieten
     (`infra/modules/enrichment-job.bicep`) i.p.v. via CLI.
   - Herstart backfill: `az containerapp job start -n caj-facet-enrich-dev -g prakkie-dev`
     (hervatbaar — gate op `matcher_version`).
3. **Client** (Fase 5) — consumeert `/basket-plan`. Open.
4. **Zelf-tuning** (Fase 7). Open.

## 9. Het risico dat telt

**Facetkwaliteit** — het is wat v1 doodde. De-risking is ingebouwd: offline
verificatie (LLM vs gestructureerd), confidence-gepoorte auto-toepassing
(onzekere facetten kunnen *alleen* COMPROMISE worden), en een precisiedrempel op
de golden set vóór elke auto-toepassing, met "wit brood → MIX" als vastgezette
regressietest. Haalt Fase 0 de drempel niet op 3 categorieën, dan leren we dat
goedkoop vóórdat we de graaf bouwen.

## 10. Open beslissingen

- **Strengheid auto-toepassen:** alleen EXACT+EQUIVALENT (aanbevolen) vs ook
  COMPROMISE voorlopig invullen met markering.
- **Embeddings:** `catalog.product_embeddings` (vector 512) staat leeg. Optioneel
  vullen als recall-hulp *binnen* categoriebuckets voor de clustering — niet
  vereist voor v1. Alleen toevoegen als recall bewijsbaar de bottleneck is.
- **Longtail-dekking:** hoeveel categorieën handmatig reviewen vóór launch
  (top-50 volume?) en waar de conservatieve fallback het overneemt.
