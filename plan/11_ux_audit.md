# 11 · UX-audit — elke tab als zelfstandige feature (2026-07-06)

Uitgangspunt (owner): behandel elke tab als een feature die **op zichzelf werkt**,
zonder de andere tabs nodig te hebben — maar mét integraties waar dat waarde
toevoegt. Alles beperkt tot de 6 live supermarkten (AH, Jumbo, Plus, Dirk,
Spar, Aldi); de overige 5 zijn verticale schaal, later.

Legenda: 🔴 blokkerend · 🟠 hoog · 🟡 middel · ⚪ laag. Status ✅ = in deze pass gefixt.

## Cross-cutting

| # | Ernst | Bevinding | Fix |
|---|---|---|---|
| C1 | 🔴 | Receptdetail heeft **geen terug-knop** (header global uit, hero vult top; iOS-gebruikers stranden) | Zwevende terug-chevron op de hero ✅ |
| C2 | 🔴 | Onboarding toont **11 ketens terwijl er 6 live zijn** — wie Vomar als "jouw winkel" kiest krijgt een app zonder prijzen | 5 niet-live ketens disabled + "binnenkort"-label; selectie beperkt tot live ✅ |
| C3 | 🟠 | **Geen instellingen-scherm**: "aanpassen kan altijd" (onboarding) is onwaar; huishoudens hebben een volledig geteste backend maar **nul UI** | Nieuw `/instellingen`: ketens, personen, huishouden (maak/uitnodig/join), avatar in home-header opent het ✅ |
| C4 | 🟡 | Import-tip belooft "Deel → Prakkie" maar er ís geen share-target (expo-share-intent niet geïnstalleerd) | Eerlijke tip: kopieer de link → klembord-detectie doet de rest. Share-target = dev-build roadmap ✅ |
| C5 | ⚪ | Geen OTA (expo-updates) → preview-APK's bevriezen | Roadmap; dev-build is de iteratieroute |

## Recepten (tab werkt standalone ✓)

| # | Ernst | Bevinding | Fix |
|---|---|---|---|
| R1 | 🟡 | Ontdek toont "Ontdek laadt… (internet nodig)" óók bij 0 zoekresultaten | Aparte lege-staat: "niets gevonden voor 'x'" + import-CTA ✅ |
| R2 | 🟡 | Ontdek-zoek over ~10 gecrawlde recepten stelt bijna altijd teleur ("pasta" → 0) | Verwachting sturen in UI; meer crawlen = verticale schaal (nightly loop staat) ✅ |
| R3 | ⚪ | Sorteeroptie "laatst gekookt" heeft nooit data — kookmodus zet `last_cooked_at` niet | "Klaar" in kookmodus stempelt `last_cooked_at` ✅ |

## Import + Controleer (FAB-feature, standalone ✓ na fixes)

| # | Ernst | Bevinding | Fix |
|---|---|---|---|
| I1 | 🔴 | **"Handmatig" is een doodlopend pad**: review opent met 0 ingrediënten en er is geen manier om ingrediënten/stappen toe te voegen | Review krijgt "+ ingrediënt", verwijderen, en een stappen-editor ✅ |
| I2 | 🟠 | Parser verzint bewust niets (goed) maar **suggereert ook niets** — gebruiker blijft met gaten zitten | AI-gap-fill: ontbrekende hoeveelheden/stappen als **gemarkeerde suggesties** (confidence 0.5, note "AI-suggestie — stond niet in de bron") → amber "controleer"-patroon in review ✅ |
| I3 | 🟡 | Ingrediënt bewerken in review laat `item_normalised` staan → match op verouderde term | Bij handmatige bewerking normalisatie wissen; server herleidt bij lijst/prijs ✅ |
| I4 | ⚪ | Regel zonder geparste hoeveelheid verliest de bron-tekst visueel | raw_text als subregel wanneer qty leeg ✅ |

## Plannen (standalone ✓ na fixes)

| # | Ernst | Bevinding | Fix |
|---|---|---|---|
| P1 | 🟠 | Lege dag → `router.push('/')`: context weg, gebruiker moet zelf recept → Inplannen → week/dag opnieuw kiezen | In-place kiezer-sheet op de dag: eigen bibliotheek zoeken, tik = ingepland ✅ |
| P2 | 🟠 | "Boodschappenlijst maken" maakt **elke tik een nieuwe** "Weekboodschappen"-lijst | Bestaande weeklijst hergebruiken + `replace_generated` ✅ |
| P3 | 🟡 | Zonder recepten is Plannen dood — geen notitie/vrije maaltijd ("uit eten", "restjes") | Migratie 0012: `plan_entries.recipe_id` nullable + `title`; "+ eigen notitie" in de kiezer ✅ |
| P4 | ⚪ | `meal_slot` ongebruikt (één avond-slot) | Bewuste productkeuze — blijft |

## Lijst (standalone ✓ na fixes)

| # | Ernst | Bevinding | Fix |
|---|---|---|---|
| L1 | 🔴 | **Geen handmatig toevoegen** — lege staat zegt letterlijk "voeg toe vanuit een recept". Een boodschappenlijst waar je geen melk op kunt zetten | Quick-add invoer (pantry-patroon): offline-first insert `is_manual`, online verrijking (normalisatie + schap) via `/v1/match` ✅ |
| L2 | 🟠 | Item **verwijderen/hoeveelheid wijzigen kan niet** — mis-import staat er voorgoed | Variant-sheet krijgt −/+ hoeveelheid en "Verwijder van lijst" ✅ |
| L3 | 🟡 | "live gekoppeld aan weekplan" suggereert sync die er niet is (lijst is een snapshot) | Eerlijke metaregel ✅ |
| L4 | ⚪ | Ongematcht item toont "—" zonder uitleg | Variant-sheet toont "geen match gevonden" per keten (bestond al) — ok |

## Prijzen (standalone ✓ na fixes; leunt bewust op een lijst)

| # | Ernst | Bevinding | Fix |
|---|---|---|---|
| PR1 | 🟠 | "Koken met aanbiedingen"-rail is een **dode knop** (`onPress={()=>{}}`) en er zijn 0 deals (geen promo-data in snapshot) | Rail alleen tonen mét deals; tik opent recepten uit bibliotheek die deal-items raken. Promo-data komt uit de nightly scrape ✅ |
| PR2 | 🟡 | Lege staat zonder lijst heeft geen actie | CTA-knop → Lijst-tab ✅ |
| PR3 | ⚪ | "Alles · 0" oogt kapot bij nul deals | Link verbergen bij 0 ✅ |
| PR4 | ⚪ | Lijstkeuze impliciet (deze week, anders eerste) | Genoeg voor MVP; later picker |

## Voorraadkast · Kookmodus · Huishouden

- Voorraadkast: **het referentie-patroon** voor standalone (invoer + verwijderen + suggesties). Geen bevindingen.
- Kookmodus: solide (keep-awake, timers, sluiten) — alleen R3.
- Huishouden: backend af + getest; UI zat nergens → landt in `/instellingen` (C3).

## Wat bewust NIET in deze pass

- Vomar/Hoogvliet/DekaMarkt/Ekoplaza/Picnic-connectors (verticale schaal; scrapers van owner blijven onaangeroerd)
- Foto/OCR + tekst-plakken import (blijft "binnenkort", nu eerlijk gelabeld)
- Betalen/RevenueCat en Google/Apple-login (expliciet uitgesloten)
- Share-target (native module → dev-build traject)

## Teststrategie per feature (e2e, live API)

1. **Import**: 3+ echte links — JSON-LD-blog, pagina zónder JSON-LD (AI-fallback), schrale bron (gap-fill-suggesties gemarkeerd, niets stilletjes verzonnen).
2. **Matching**: steekproef Nederlandse basisboodschappen → top-1 moet een echt NL-supermarktproduct zijn bij ≥1 live keten.
3. **Lijst**: quick-add → verrijking → prijs per keten → variant pinnen → totaal verandert → verwijderen.
4. **Plannen**: notitie-maaltijd sync-roundtrip; lijst-hergebruik (2× genereren ⇒ 1 lijst).
5. **Recepten/Ontdek**: feed, detail → review → bewaren; zoekstaten.
6. **Prijzen**: compare + deals + rail-logica (0-deals verbergt rail).
