# Prakkie — Functional Specification (v2)

> **App name:** `Prakkie` (earlier working label in the mockups: "Bordje" — those HTML assets need re-exporting with the new name).
> **One-liner:** Save any recipe from social media, and instantly turn it into a priced, aisle-sorted shopping list matched to real Dutch supermarket products — compared across every chain we can price.
> **Status:** v2.1 functional spec (adds Module N — discovery feed), rewritten for implementation via Claude Fable 5 / Claude Code Plan Mode.
> **Companion docs:** `02_supermarket_data_sources.md` (price data), `05_recipe_content_sources.md` (recipe content data), `03_azure_architecture_and_storage.md` (infra), `04_design_guardrails.md` (UX contract).
> **Author:** Mourad

---

## 1. Product thesis

### 1.1 The wedge
Two incumbents own adjacent territory but neither owns the middle:

- **ReciMe** is a world-class recipe *organizer* (import from Instagram/TikTok/blogs into clean structured recipes) but has **zero Dutch grocery integration**, is US-centric (imperial units, US aisle logic), and generates strong user resentment over its subscription model.
- **Albert Heijn / Steijn** owns product data, live Bonus pricing and delivery, but only works inside AH's own ~17,000 recipes, single chain, and cannot import a recipe you found on TikTok.

**Prakkie sits in the gap:** best-in-class social/video recipe import (ReciMe's strength) + real Dutch multi-supermarket product matching and price comparison (AH's strength, but cross-chain and neutral). AH will never tell you Jumbo is cheaper this week. Prakkie will.

### 1.2 Defensible differentiators
1. **Video-first import** that reliably parses spoken/on-screen ingredients from Reels & TikTok (ReciMe's biggest weakness). Mockup 03/04 shows the flow: clipboard-link detection → one-tap import → review screen with per-field confidence ("feta 100 g? — Gehoord in video: *flink wat feta* — hoeveelheid geschat").
2. **Neutral cross-chain price comparison** across every Dutch chain with a public priced assortment — **AH, Jumbo, Plus, Dirk, DekaMarkt, Aldi, Vomar, Hoogvliet, Spar, Picnic, Ekoplaza** — with live Bonus/aanbieding awareness. This is the complete supported set; chains without a public priced assortment (Lidl, Nettorama, Boni) are out of scope — see `02_supermarket_data_sources.md`. The comparison screen (mockup 07) degrades honestly for chains with partial online coverage ("2 items niet in assortiment").
3. **Genuinely smart shopping list** (merges duplicates, Dutch aisle order, editable categories, live-linked to the weekplan) — the #1 functional complaint about ReciMe. Mockup 06 is the contract.
4. **Full NL localisation** (Dutch language parsing, metric by default, Dutch supermarket aisle layout).
5. **Monetisation that doesn't enrage** (§12) — the loudest single theme in ReciMe reviews.

### 1.3 Non-goals (explicitly out of scope)
- Not a delivery/logistics operator (we hand off to supermarket carts, we don't fulfil).
- Not a social network. Sharing exists; feeds/followers do not.
- Not a general price-tracker for non-food (Kruidvat lists exist as *plain* lists, unpriced).

---

## 2. Target users

| Persona | Description | Primary jobs-to-be-done |
|---|---|---|
| **The saver** | Screenshots/bookmarks dozens of recipes across IG, TikTok, Pinterest, blogs; loses track of them. | Capture reliably, find later, actually cook them. |
| **The planner** | Cooks for a household, plans the week, wants to control grocery spend. | Weekly plan → one consolidated, priced shopping list. |
| **The optimiser** | Price-sensitive; already checks Bonus/aanbiedingen. | Know where a basket is cheapest this week. |
| **The keeper** | Has handwritten/cookbook family recipes to digitise. | OCR import, permanence, no data loss. |

Primary market: NL households, Dutch- and English-speaking (expats included). iOS + Android.

---

## 3. Feature map (module overview)

```
Prakkie
├── A. Accounts & onboarding
├── B. Recipe import  ← core moat        (mockups 03, 04)
├── C. Recipe library & organisation      (mockups 01, 02)
├── D. Recipe detail & cook mode
├── E. Ingredient → product matching engine  ← core moat
├── F. Price comparison & deals           (mockup 07)
├── G. Smart shopping list                (mockup 06)
├── H. Meal planning                      (mockup 05)
├── I. Pantry & "cook from what I have"
├── J. Nutrition
├── K. Household & sharing
├── L. Grocery handoff / ordering
├── N. Discovery feed (NL recipe sites)   ← new in v2.1
└── M. Cross-cutting (localisation, sync, notifications, offline)
```

App-level navigation is fixed by the approved designs: a 4-tab bottom bar — **Recepten · Plannen · Lijst · Prijzen** — with a centre floating **[+]** button that opens the import sheet (mockup 03). See `04_design_guardrails.md`.

---

## 4. Module A — Accounts & onboarding

**A1. Sign-up / sign-in.** Email + OAuth (Apple, Google). Guest mode allowed for first import (no lost-first-impression paywall).

**A2. Data durability guarantee (P0).** Recipes are server-persisted and survive: subscription changes, re-install, platform switch (iOS↔Android), and sign-out. *(Directly addresses ReciMe's "recipes disappeared after I subscribed" and "blank white screen on launch" bug reports — data loss is an instant-uninstall event.)* Storage implications: whichever Azure store is chosen (see `03…` §5) must support point-in-time restore or continuous backup, and one-tap GDPR export.

**A3. Onboarding flow.**
1. Pick primary supermarket(s) — multi-select from the eleven supported chains (`02…`); default = AH. This drives the "jouw winkel" marker in the Prijzen tab and the aisle layout of the Lijst tab ("AH-indeling").
2. Pick language (NL/EN) and units (metric default).
3. Household size (drives default serving scaling; mockup 05 shows per-dish "4 pers").
4. Optional: import an existing recipe immediately as the "aha" moment (guest → prompt to save account after first successful import).

**A4. Account settings.** Language, units, default servings, home supermarket(s), dietary defaults (veg/vegan/gluten-free/halal flags used for substitution hints), notification prefs, data export & delete (GDPR).

---

## 5. Module B — Recipe import (core moat)

Import methods, in priority order of reliability effort. The **implementation** (platform detection, per-platform Apify actors, OpenAI parsing, fallbacks, cost guards) is fully specified in `06_social_import_apify.md` — this section is the product view. The import entry point is the centre FAB → import sheet (mockup 03), which offers: detected clipboard link, **Plak een link**, **Foto of scan**, **Tekst plakken**, **Handmatig**, plus the share-sheet education footer ("Deel → Prakkie. Eén tik, klaar.").

**B1. Share-sheet import.** From any app (Instagram, TikTok, YouTube, Pinterest, Facebook, Safari/Chrome, WhatsApp), user taps Share → Prakkie. This is the primary capture path; must be one tap and stay out of the way. Secondary path: clipboard-link detection when the app opens (mockup 03 shows "Link op je klembord gevonden").

**B2. Blog / website import.** Fetch page, strip narrative fluff, extract ingredients + steps + yield + time. Prefer structured `schema.org/Recipe` JSON-LD when present; fall back to LLM extraction.

**B3. Caption import (text-in-post).** Parse ingredients/steps from a social caption. Solved problem — must be near-100%.

**B4. Video import (the differentiator).** For Reels/TikTok/Shorts where ingredients are *spoken* rather than in the caption:
- Fetch caption/metadata via the platform's **Apify actor(s)** (`06…` §4).
- Transcribe spoken audio via **Apify transcript actors** (NL + EN), capped at 5 minutes (`06…` §3) — no self-hosted ASR.
- Fuse caption + metadata + transcript into one `LinkContext`, then **OpenAI** parses it into the canonical recipe schema.
- Confidence flags + `missing_fields` on anything the model was unsure about, surfaced in the edit-before-save step. Mockup 04 defines the UX: success banner ("Video geïmporteerd in 12 s — audio, tekst in beeld en caption gecombineerd"), per-ingredient confidence chips, and provenance hints ("Gehoord in video: *flink wat feta* — hoeveelheid geschat").
- *Enhancement (not in the current Apify flow):* keyframe OCR of on-screen ingredient overlays — a future signal to fuse in when a video shows quantities on screen but doesn't speak them.
> This is where ReciMe loses users ("only imports the recipe 10% of the time"). Reliability here is the product.

**B5. Photo / OCR import.** Photograph a cookbook page or handwritten card → OCR → structured recipe. Support **multiple photos per recipe** (ReciMe caps at one — a named complaint).

**B6. Manual entry.** Always free, always unlimited (see monetisation §12). Structured form + free-text paste that auto-parses.

**B7. Edit-before-save.** Every import lands in the review screen (mockup 04): editable ingredients (qty / unit / item), steps, servings, source link preserved ("Reel · @lekkersimpelnl · bron blijft bewaard"). Low-confidence fields highlighted. Nothing is saved silently wrong. Primary CTA: **Bewaar in Mijn recepten**.

**B8. Canonical recipe schema (internal).**
```
Recipe {
  id, title, source_url, source_platform, image[],
  servings_base, time_prep, time_cook,
  ingredients[]: { raw_text, quantity, unit, item_normalised, note, confidence },
  steps[]: { order, text, timer_seconds? },
  tags[], cuisine, diet_flags[], nutrition{}, missing_fields[],
  origin, source_platform, created_at, updated_at, owner_id, household_id?
}
```
The `item_normalised` field is the join key into the product-matching engine (§8).

---

## 6. Module C — Recipe library & organisation

The library is the home tab (mockup 01): greeting header, search bar, horizontally scrolling collection chips ("Alles · 23", "Doordeweeks", "Meal prep", "Vega", "Feestdagen"), a sort control ("Nieuwste eerst"), and a 2-column card grid where every card shows photo, title, cook time and a **price-per-portion badge** ("€ 1,85 p.p.") plus an optional **Bonus-tip** badge when an ingredient is on offer.

**C1. Cookbooks / collections.** User-defined; a recipe can live in multiple.

**C2. Tags & auto-tags.** Meal type, cuisine, diet, protein — auto-suggested on import, user-editable.

**C3. Search.** Full-text over title, ingredients, steps, notes ("Zoek op titel of ingrediënt…").

**C4. Sort & filter (fix ReciMe's gap).** Sort by: newest, oldest, alphabetical A–Z, recently cooked, prep time — exactly the sort sheet in mockup 02. **Filter by ingredient** with multi-select chips and an all/any toggle ("recepten met **alle** gekozen ingrediënten") — mockup 02 shows the target: "3 recepten met courgette + kip", each result listing its key ingredients. *(ReciMe cannot do alphabetical, newest-first, or ingredient filter — all explicit review requests.)*

**C5. Personal notes & modifications.** Per-recipe notes and edited quantities persist separately from the imported original.

**C6. Source link preservation.** Always keep the original URL/creator handle so users can revisit the source (ReciMe users specifically praise this — keep it).

---

## 7. Module D — Recipe detail & cook mode

**D1. Detail view.** Ingredients (scaled to chosen servings), steps, nutrition, source, tags, price-to-cook badge (from §9).

**D2. Serving scaler.** Adjust servings → all quantities recompute; metric/imperial toggle.

**D3. Cook mode.** Screen stays awake; step-by-step large-text view; inline timers auto-detected from steps ("simmer 20 min" → tappable 20:00 timer). *(ReciMe users complain the screen sleeps mid-cook — table stakes to get right.)*

**D4. Add-to-list / add-to-plan** from the detail view in one tap.

---

## 8. Module E — Ingredient → Dutch product matching engine (core moat)

This is the engine that turns a free-text ingredient into a real, buyable, priced supermarket SKU. It's the hardest and most defensible part, and squarely a data-engineering / entity-resolution problem.

**E1. Normalisation.** `"2 el olijfolie extra vierge"` → `{ qty: 2, unit: tbsp→ml, item: "olijfolie extra vierge" }`. Handle NL + EN, abbreviations (el/tl/g/kg/ml/l/snufje), fractions, ranges, "naar smaak".

**E2. Product catalog ingestion.** Pull structured product data per chain (name, unit price, pack size, category, Bonus/aanbieding price, availability). Strategy, per-chain endpoints, refresh cadence and legal posture are specified in **`02_supermarket_data_sources.md`** — summary: we ingest all eleven chains ourselves from their reverse-engineered mobile/web APIs, capturing the full field set (pack size, category tree, Bonus metadata, images, EANs). AH and Jumbo expose the richest data and anchor the aisle taxonomy and Bonus features.

**E3. Matching (entity resolution).** Map normalised ingredient → best product SKU per selected chain. Hybrid approach:
- Exacte EAN/GTIN-identiteit gaat vóór semantische substitutie wanneer twee ketens hetzelfde handelsartikel voeren.
- Lexical + fuzzy match on product names.
- Embedding similarity for semantic matches ("passata" ≈ "gezeefde tomaten").
- Pack-size reconciliation (recipe needs 200 g; product sold in 400 g tin → compute fractional cost + flag leftover). Mockup 06 shows the payoff: "Kipdijfilet · 600 g — 2 × 300 g · restje van 0 g — pakt precies".
- Retrieval en automatische acceptatie zijn gescheiden. Scores worden per matcher-versie/bron gecalibreerd; onzekere matches onthouden zich en laten de user kiezen uit een shortlist.
- “Alles bij X” heeft **Nauwkeurig** (standaard), **Praktisch** en **Voordelig**. Harde product-/dieetgrenzen versoepelen nooit; prijs rangschikt alleen al-geldige equivalenten.

**E4. Substitution & dietary awareness.** Respect diet flags (suggest plantaardige alternatives etc.). Offer cheaper same-category swaps — mockup 06: "huismerk-tip: € 0,80 goedkoper dan A-merk".

**E5. Learning loop.** User corrections to matches feed back to improve future matching (per-user overrides + aggregate signal). This compounds into a moat over time.

**E6. Output.** For any recipe or list: matched products, per-item cost, pack-size waste, total basket cost per chain.

---

## 9. Module F — Price comparison & deals

The Prijzen tab (mockup 07) is the contract for this module.

**F1. Price-to-cook badge.** Every recipe shows an estimated cost per portion, computed from matched products (library cards, planner entries and list lines all display it).

**F2. Cross-chain basket comparison.** For a shopping list, show the total per chain, cheapest first, with the user's home store marked ("jouw winkel") and honest gaps flagged ("… — 2 items niet in assortiment"). This is the feature no incumbent offers. Include every supported chain the user selected in onboarding; chains with partial online coverage (e.g. Aldi, DekaMarkt, Picnic) show the not-in-assortiment count rather than a fake total.

**F3. Bonus / aanbieding awareness.** Flag list items currently on offer per chain (mockup 07: "Van jouw lijst in de aanbieding" with old/new prices, "Bonus t/m zondag", "1 + 1 gratis", "25% korting"); optionally suggest recipes that lean on this week's deals ("Koken met aanbiedingen · 3 recepten uit je bibliotheek leunen op deals van deze week").

**F4. Savings surfacing.** "€ 4,20 goedkoper bij Jumbo — vooral door kip en olijfolie" — always explain *why* a chain wins, naming the driving items.

---

## 10. Module G — Smart shopping list

Fix everything ReciMe's list gets wrong. Mockup 06 is the contract: multiple named list tabs, aisle-grouped sections, per-line matched product + price, merge provenance, Bonus strikethrough pricing, and a sticky footer with the chain total and the cross-chain teaser ("Totaal bij AH € 47,80 · € 4,20 goedkoper bij Jumbo").

**G1. Auto-generation** from any recipe or a whole week's plan, scaled to servings.

**G2. Duplicate merging.** Same ingredient across multiple recipes combines into one line with summed quantity and visible provenance — mockup 06: "Rode ui · 3 st — samengevoegd: shakshuka (1) + nasi (2)". *(ReciMe does not merge — top complaint.)*

**G3. Dutch aisle sorting.** Group by supermarket aisle order (GROENTE & FRUIT → ZUIVEL & EIEREN → VLEES & VIS → …), matching the chosen chain's store layout ("AH-indeling" chip). Categories **editable and reorderable**; items movable between categories. *(ReciMe locks categories and mis-files items with no fix.)*

**G4. Live plan sync.** Editing the meal plan or serving sizes auto-updates the list — no manual re-add ("live gekoppeld aan weekplan"). *(ReciMe requires manual re-adding; a known error source.)*

**G5. Multiple named lists.** e.g. "Weekboodschappen", "Feestje za", "Kruidvat/non-food" — mockup 06 shows the tab row with "+ Nieuw". *(Explicit review request.)*

**G6. Pantry-aware.** Optionally subtract what's already in the pantry (§11) so you don't rebuy staples.

**G7. Priced.** Each line shows matched product + price; Bonus items show old price struck through ("€ 2,49 → € 1,87 · Bonus 25%"); footer shows chain total + cheapest-elsewhere teaser linking to the Prijzen tab.

**G8. Check-off / shopping mode.** Tap to check items; check state syncs live across devices/household ("6 afgevinkt · gesynct met Sanne").

---

## 11. Module H — Meal planning

The Plannen tab (mockup 05) is the contract: week header ("Week 28 · 6 – 12 juli · 5 gerechten gepland · sjabloon: *Standaard week*"), day rows MA–ZO with drag targets ("Sleep een recept hierheen"), per-dish servings + price ("4 pers · € 2,10 p.p.") and inline Bonus context ("feta in de Bonus"), a **Zonder datum** parking strip, and a bottom CTA "Boodschappenlijst maken · 6 gerechten".

**H1. Weekly calendar** (dinner-first; breakfast/lunch slots optional), drag recipes in.

**H2. Multi-week view** (ReciMe shows only one week — fix). Week switcher in the header.

**H3. Plan without a date.** The "Zonder datum · deze week nog inplannen" strip supports loose planning not tied to specific days (review request).

**H4. Reusable / saved plans.** Save a week as a template ("sjabloon") and re-apply. *(ReciMe cannot reuse plans — a family-planning gap.)*

**H5. Plan → list.** One tap generates the consolidated, merged, priced list (§10).

---

## 12. Module I — Pantry & "cook from what I have"

**I1. Pantry inventory.** Lightweight list of what the user has (manual add, add-from-purchased, barcode scan optional).

**I2. Cook-from-pantry.** Suggest recipes from the user's *own library* that mostly match current pantry + show the few missing items. *(AH already does fridge→recipe on its own catalog; Prakkie does it on the user's saved recipes — different and complementary.)*

**I3. Waste reduction.** Nudge recipes using soon-to-expire / leftover pack quantities flagged by the matching engine (§8 E3).

---

## 13. Module J — Nutrition

**J1. Per-recipe nutrition** (calories, protein, carbs, fat) computed from matched products / a nutrition DB, per serving.

**J2. Diet flags & goals** (optional): high-protein, low-cal filters for library and planning.

*(Nutrition is table-stakes parity with ReciMe, not a differentiator — keep it simple.)*

---

## 14. Module K — Household & sharing

**K1. Household accounts.** Shared library, shared shopping list, shared meal plan across members. *(ReciMe has no shared households — a real family gap.)*

**K2. Real-time list sync.** Two people, one list, live check-off (mockup 06: "gesynct met Sanne").

**K3. Recipe sharing.** Send a recipe via link / WhatsApp / etc. Recipient can import it in one tap.

---

## 15. Module L — Grocery handoff / ordering

**L1. Cart handoff.** Push the matched shopping list into the chosen chain's online cart (via that chain's cart/deep-link mechanism where available), then the user checks out / books delivery in the supermarket's own app.

**L2. No fulfilment ownership.** Prakkie never handles payment or delivery — it stops at "your cart is ready at AH/Jumbo." (Keeps scope, liability and ops light; monetisation via affiliate where a program exists.)

---

## 16. Module N — Discovery feed (new in v2.1)

Users who don't yet have a saved library need a reason to open the app; discovery also feeds the "Koken met aanbiedingen" surface (mockup 07). We build a discovery feed populated by **crawling the known Dutch recipe websites** (full source inventory, per-site feasibility and legal posture in `05_recipe_content_sources.md`).

**N1. Feed placement.** Discovery lives **inside the Recepten tab** as a segment ("Mijn recepten / Ontdek") — the approved 4-tab + FAB navigation is not changed. The Ontdek screen reuses the library card grid (photo, title, time, price-per-portion badge, Bonus-tip badge) so discovered recipes are visually priced from day one — that pricing is our differentiator over the source sites themselves.

**N2. Content model — index, don't republish.** For each crawled recipe we store the *structured data* (title, ingredients, steps, yield, times, image URL, canonical source URL, author/site) extracted primarily from `schema.org/Recipe` JSON-LD. In the feed we show **title + image + our computed price/time badges + prominent source attribution**; tapping opens our detail view with a clear source link. Saving to "Mijn recepten" uses the exact same import pipeline (B2/B7) — so discovery is really "import suggestions at scale," not a separate content system.

**N3. Ranking & personalisation.** Rank by: overlap with this week's aanbiedingen (deal-driven recipes first — unique to us), match with the user's diet flags and past saves, seasonality, and computed price per portion. No social graph, no UGC, no comments — this remains a utility, not a content platform.

**N4. Search across the index.** The library search extends with an "ook in Ontdek zoeken" scope so "courgette + kip" (mockup 02) can pull from the crawled index when the user's own library has few hits.

**N5. Freshness & hygiene.** Weekly re-crawl per source; dead links pruned; recipes whose source page disappears are hidden from the feed (users who already saved them keep their copy — spec A2). Respect robots.txt and per-site crawl budgets (see `05…`).

**N6. Creator posture.** We always link out, never claim authorship, and honour takedown requests immediately. If a publisher objects, their domain goes on a blocklist the same day. (This is also the path to partnerships: the feed drives traffic *to* the sites, which is the pitch.)

---



## 17. Module M — Cross-cutting concerns

**M1. Localisation.** Dutch + English throughout; metric default; Dutch aisle taxonomy; NL number/quantity parsing (comma decimals, "€ 1,85").

**M2. Sync.** Cloud-first, multi-device, offline-tolerant. Recipes readable offline; edits queue and sync.

**M3. Notifications (opt-in, restrained).** "Your Bonus list is ready", weekly-plan reminder. No spam.

**M4. Accessibility.** Large-text cook mode, high contrast, VoiceOver/TalkBack.

**M5. Web companion.** Read/organise library on desktop (ReciMe users value this).

---

## 18. Non-functional requirements

- **Import reliability target:** ≥95% field accuracy on blog/caption; ≥85% on video with confidence flagging. Reliability is the product — treat regressions as P0.
- **Retrieval target:** ≥90% top-1 correct product match on common ingredients; always offer a shortlist fallback.
- **Bulk-accept target:** meet precision en coverage afzonderlijk. `Nauwkeurig` gebruikt een gecalibreerde ≥99% precision-doelstelling; niet-geaccepteerde regels tellen niet mee in totalen en gaan naar controle.
- **Latency:** import result < ~15 s for video (mockup 04 celebrates "12 s"), < 3 s for blog/caption; list price computation < 2 s.
- **Privacy / GDPR:** EU data residency (Azure West Europe); explicit consent; one-tap export and delete. No selling data.
- **Resilience:** product-data outage must degrade gracefully (recipe features keep working; prices show "laatst bijgewerkt" timestamps).
- **Cost ceiling:** total Azure spend ≤ €50/month up to ~500 users (see `03_azure_architecture_and_storage.md`).

---

## 19. Technical alignment

- **Import & extraction:** per-platform **Apify actors** for scraping + transcription (single-post, cost-guarded via `maxPaidDatasetItems=1` and per-actor `maxTotalChargeUsd`); **OpenAI** parses the fused `LinkContext` into the canonical NL recipe schema with NL-tuned prompts (bosui normalisation, no invented quantities, `missing_fields`). Full spec: `06_social_import_apify.md`. Hosted as the Azure Function `import-recipe`.
- **Matching engine:** entity resolution = embeddings + fuzzy + rules; classic data-engineering territory. Vector capability required — see storage decision in `03…` §5.
- **Product data:** own per-chain ingestion of the reverse-engineered mobile/web APIs for all eleven chains (details and endpoints in `02…`). EU-hosted; polite, low-volume, nightly refresh.
- **Recipe content data:** weekly crawler over the Dutch recipe sites in `05_recipe_content_sources.md`, JSON-LD-first extraction, stored in the same canonical recipe schema (B8) with `origin: crawled` and source attribution fields.
- **Backend:** Azure (see `03…`), event/timer pipeline for catalog refresh, per-user correction store feeding the learning loop.
- **Clients:** cross-platform mobile (iOS + Android) + thin web reader.

---

## 20. Monetisation (avoid the ReciMe subscription-rage trap)

The single loudest negative theme in ReciMe reviews is the paywall: 8-import free cap read as bait-and-switch, surprise annual charges, difficult cancellation, and "still shows ads after paying." Design around it:

- **Generous free tier:** unlimited manual entry, unlimited saved recipes, unlimited blog/caption imports, basic shopping list. Never hold a user's own data hostage.
- **Premium = the expensive-to-run magic:** unlimited *video* imports, OCR imports, cross-chain price comparison, nutrition, household sharing, pantry intelligence.
- **Offer a one-time / lifetime option alongside the subscription** — multiple ReciMe reviewers explicitly say they'd pay once but resent recurring billing.
- **Honest trial:** clear pre-charge reminder, frictionless in-app cancel, no dark patterns.
- **No ads for paying users. Ever.**
- Possible secondary: affiliate revenue on cart handoff where programs exist.

---

## 21. Key risks & open questions

- **Platform risk:** AH could add social import; mitigate with cross-chain neutrality they can't match.
- **Data-source risk:** unofficial APIs can change or be blocked at any time — mitigations (polite low-volume ingestion, caching, commercial-provider fallback, affiliate partnerships) are detailed in `02…` §5.
- **Video import cost:** Apify transcript actors + OpenAI parsing per import is the swing cost — gate video behind premium, enforce per-user quotas, and cache by URL-hash aggressively (`06…` §1, §8).
- **Legal:** recipe imports (attribution, ToS of source platforms), product data usage (see legal notes in `02…` §5), and — heavier — the discovery feed's crawling and display of third-party recipe content (see `05_recipe_content_sources.md` §4: ingredient lists are facts, but creative step text and photos are copyrighted; the index-and-attribute model is designed around this) — get written advice before scale.
- **Cold-start:** matching quality depends on corrections volume — seed with a manually curated NL ingredient↔product lexicon.
- **Open:** final name; which chains a user sees in the Prijzen tab (recommend: the chains the user selects in onboarding); AH affiliate partnership vs. neutrality.
