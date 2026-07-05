# Prakkie — Spec pack for Claude Fable 5

> **App:** Prakkie — save any recipe from social media and turn it into a priced, aisle-sorted shopping list matched to real Dutch supermarket products.
> **Owner:** Mourad · **Market:** Netherlands · **Platforms:** iOS + Android (mobile-first), thin web reader later.
> **Purpose of this pack:** input documents for a Claude Fable 5 / Claude Code Plan Mode session that will design and build the app.

## How to use this pack

Feed these files as context, in this order. Each file is self-contained but they cross-reference each other.

| File | What it is | How Fable 5 should treat it |
|---|---|---|
| `01_functional_spec.md` | The full functional specification (modules A–N, monetisation, risks) | **Source of truth for scope.** This describes the whole app; build all of it to this spec. |
| `02_supermarket_data_sources.md` | The eleven Dutch supermarkets with an online product list that can be reverse-engineered, with technical clues and legal notes | **Source of truth for the data layer.** These eleven chains are the complete supported set; no other chains are in scope. |
| `03_azure_architecture_and_storage.md` | Azure target architecture under a €50/month Visual Studio subscription budget | **Constraints + open decisions.** Storage choice is deliberately left open — Fable 5 must make the call using the decision matrix in §5 of that file, and record the decision. |
| `04_design_guardrails.md` | Design system + screen inventory extracted from the 7 approved HTML tab mockups | **Non-negotiable guardrails.** Colours, typography, tab structure, and the seven screens are already approved by the owner. New screens (incl. the "Ontdek" discovery segment) must follow these tokens. |
| `05_recipe_content_sources.md` | The Dutch recipe websites to crawl for the discovery feed (Module N), extraction pipeline and legal model | **Source of truth for discovery content.** The listed sites are the complete supported set; index-and-attribute model is mandatory. |
| `06_social_import_apify.md` | The social/blog import pipeline: per-platform Apify actors, fallbacks, cost guards, and OpenAI parsing — the owner's tested config, re-homed to Azure | **Source of truth for Module B implementation.** Reproduce the Apify actor IDs and inputs verbatim. Scraping/transcription = Apify; parsing = OpenAI; hosting = Azure Function `import-recipe`. |

## Hard rules for the build session

1. **The 7 mockups are the UX contract.** Tab bar = Recepten · Plannen · [+ import FAB] · Lijst · Prijzen. Do not invent a different navigation model. The discovery feed lives as an "Ontdek" segment *inside* the Recepten tab — no fifth tab.
2. **Stay inside the €50/month Azure budget** for everything up to the first ~500 users. `03_azure_architecture_and_storage.md` §4 shows the budget envelope.
3. **Storage is an open decision** — pick from the shortlist in `03…` §5, justify the choice against the decision criteria, and document it in an ADR (architecture decision record) before writing code.
4. **Data durability is a P0 product guarantee** (spec §A2). Whatever storage is chosen must support backup/export from day one.
5. **Never hold user data hostage** behind the paywall (spec §Monetisation). Free tier limits compute-heavy features, never stored recipes.
6. **NL-first:** Dutch UI strings (as in the mockups), metric units, Dutch aisle taxonomy, EU data residency (West Europe region).
7. **Fixed stack choices:** hosting is **Azure** (not Supabase); social/blog scraping + transcription is **Apify** (single-post, cost-guarded); recipe parsing is **OpenAI**. Storage is the only open infra decision (rule 3).

## Open items the owner still needs to decide (flag, don't block)

- (Resolved) App name is **Prakkie**. Note: the seven source mockup HTML files still display the earlier label "Bordje" in titles and the share footer — they need re-exporting with the new name before or during the build.
- (Resolved) Lidl is **out of scope** — no public priced assortment. The mockup-07 "2 items niet in assortiment" pattern is retained for in-scope chains with partial online coverage (Aldi, DekaMarkt, Picnic).
- AH affiliate partnership vs. strict neutrality.
- Discovery feed display depth (feed = title/image/badges only; whether the detail view shows full steps before save is pending legal advice — `05…` §4).
