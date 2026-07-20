# Productmatching en “Alles bij X”

## Contract (policy-v2-ean, owner 2026-07-14)

Er zijn twee wezenlijk verschillende vragen, met elk hun eigen regels:

1. **Ingrediënt → product** (“welke producten passen bij ‘melk’ bij keten X?”):
   retrieval via eigen correcties, lexicon, naam/trigram en tekstembedding.
   Dit is zóéken en kan alleen op naam; het voedt uitsluitend de
   shortlist/picker. Ook wanneer nog niets gekozen is, wordt een naamtreffer
   nooit stil als product of vervanging geaccepteerd.
2. **Product → product** (“hetzelfde artikel bij een andere keten”): **alleen
   exacte EAN/GTIN-identiteit** (genormaliseerd op leidende nullen,
   0032-index). Zodra een item een gekozen ankerproduct heeft, is de enige
   automatische substitutie elders de rij met exact dezelfde EAN. Geen
   naam-, foto- of AI-intent-gelijkenis meer: geen EAN-treffer = eerlijk
   “geen match”, en de user kiest handmatig uit de term-shortlist.

De EAN-dekking komt van de scrapers (AH/Jumbo/Spar/Dirk grotendeels) plus de
wekelijkse **OFF-verrijkingsjob** (`services/ean-enrichment`): Open Food Facts
parquet → blob-cache → NL-filter → offline naam/merk/verpakking-match voor
regels zonder EAN (Aldi, PLUS, ontbrekende AH) → `catalog.products.ean`, met
provenance in `catalog.ean_enrichment`.

Prijs is pas een optimalisatiedoel nadat een kandidaat geaccepteerd is.

## Beleid

Beleid (`precise`/`practical`/`value`) bepaalt alleen de rangschikking van de
handmatige shortlist (`catalog.match_policy_calibration`, matcher-versie
`policy-v2-ean`); geen enkel beleid mag een naamtreffer automatisch accepteren.
Met anker geldt beleid-onafhankelijk: EAN-gelijk → `accepted` (0.999), anders
→ `review`. Een reviewregel telt nooit mee in een mandjestotaal.

Huismerken hebben per definitie een eigen EAN per keten en substitueren dus
nooit meer automatisch — dat is een bewuste keuze: liever een handmatige keuze
in de picker dan een “lijkt-op”-artikel in iemands mandje.

## Keuzeherkomst

- `automatic`: suggestie, nooit stil opslaan.
- `bulk_accepted`: de user accepteerde een beleid voor een lijst. Mag de huidige
  winkelkeuze bepalen, maar is geen individuele correctie.
- `user_confirmed`: de user koos dit concrete product. Alleen deze status zet
  `user_pinned=true` en voedt `match_corrections`.

Prijs- en preview-operaties zijn read-only voor `list_items`. Alleen de lokale
draft plus **Opslaan** wijzigt de lijst. Acceptatie- en correctie-events worden
apart vastgelegd in `app.match_events` voor audit en latere calibratie.

## Evaluatiepoorten

- `scripts/match-eval.mjs` blijft de retrieval-top-1 regressietest
  (ingrediënt → product).
- `scripts/substitution-eval.mjs` meet **EAN-substitutiedekking**: staples ×
  anker-ketens → bij hoeveel doelketens levert de anker-EAN een exacte treffer
  op, en hoeveel ankers hebben überhaupt geen EAN. Dit is dekking, geen
  kwaliteit — een EAN-treffer ís het product.
- `scripts/match-policy-eval.mjs` meet precision/coverage van de handmatige
  shortlist en kan na menselijke controle de rangschikking calibreren
  (`--write-calibration`, schrijft op `policy-v2-ean`).

## Operationeel

- `scripts/embed-product-text.mjs --env dev` vult tekstembeddings voor de
  semantische retrieval-tier van het ingrediënt-zoeken (512-dim,
  `text-embedding-3-small`); de matcher degradeert veilig zolang de backfill
  loopt.
- EAN-verrijking draaien: `az containerapp job start -g prakkie-<env> -n
  caj-ean-enrich-<env>`, of lokaal `node services/ean-enrichment/src/run.mjs`
  (zie `services/ean-enrichment/README.md`; `DRY_RUN=1` rapporteert alleen).
- Beeldembeddings (0016) zijn verwijderd (migratie 0034); de Vision-resource
  en backfill-scripts bestaan niet meer.
