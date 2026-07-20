# Prakkie — Dutch supermarket data sources

> **Purpose:** the definitive inventory of every Dutch supermarket whose product assortment is published online in a form we can ingest (reverse-engineer), with technical clues, refresh strategy and legal posture.
> **Verified:** July 2026 against public product endpoints and community reverse-engineering knowledge.
> **Scope:** the eleven chains in §2 are the complete supported set. Chains without a public priced assortment (Lidl, Nettorama, Boni, wholesale/account-walled shops) are out of scope.

---

## 1. Data strategy

Ten chains in §2 publish their product assortment through a public web endpoint
we can read the way a browser does. Picnic is the single account-bound
exception and uses its read-only app API. **We ingest each chain ourselves** by
reverse-engineering those endpoints — there is no third-party price aggregator
in the loop.

Owning the ingestion is a deliberate choice: it gives us the **full field set** the product needs — pack size, category tree, promotion metadata (Bonus type, mechanic, valid dates), product images, EANs — rather than a lowest-common-denominator feed, and it keeps the entire data pipeline under our control and our own EU hosting. The per-chain access notes in §2 say where each chain's data lives; §4 covers how we pull and refresh it.

---

## 2. The eleven chains we support

These are every Dutch chain with a public priced assortment we can ingest. This is the **complete supported set** — no other chains are in scope. Chains without a public priced assortment (Lidl, Nettorama, Boni, wholesale/account-walled shops, etc.) are explicitly **not supported**; if a user shops there, the app shows unpriced list mode gracefully (see §6).

| Chain | Market position | Data access clue | Data richness & notes |
|---|---|---|---|
| **Albert Heijn** (ah.nl) | #1, ~35% share; Bonus is the national reference promo | Web storefront is backed by a GraphQL API; the mobile app uses a separate mobile-services REST API that issues **anonymous tokens** (no account needed) and returns rich product JSON incl. Bonus data, categories, images, EANs. Widely reverse-engineered in community projects. | Richest data of any chain — the reference for our aisle taxonomy ("AH-indeling") and the full Bonus feature set (F3/F4). Default home store in onboarding. |
| **Jumbo** (jumbo.com) | #2, ~20% share | Mobile REST API (versioned path, unauthenticated for browsing) + public website JSON endpoints; search, product detail, promotions all reachable. Also widely reverse-engineered. | Rich mobile + web JSON; search, product detail and promotions all available. Second pillar of the cross-chain comparison. |
| **Plus** (plus.nl) | #3 after absorbing Coop | SPA website with JSON backend; full priced webshop. Note: **Coop no longer exists** — merged into Plus (conversion completed 2023/24). Treat old "Coop" sources as legacy. | Full priced webshop with JSON backend. |
| **Dirk van den Broek** (dirk.nl) | Discounter, price-fighter — important for "cheapest basket" credibility | Public API used by site/app (Detailresult group); known in community projects, returns products incl. prices and offers. | Public Detailresult API; products incl. prices and offers. Key for cheapest-basket credibility. |
| **DekaMarkt** (dekamarkt.nl) | Regional (Noord-Holland); same parent as Dirk (Detailresult) | Detailresult API family, but its own store/gateway configuration and category walk. | Dedicated scraper covers all 146 web groups; the full online assortment is used for basket totals. |
| **Aldi** (aldi.nl) | Discounter | Website lists products with prices (assortment partially online); app API exists. Weekly "acties" are structured on the site. | Prices on site (assortment partially online); structured weekly "acties". Partial coverage → honest not-in-assortiment UX (§6). |
| **Vomar** (vomar.nl) | Regional (Randstad/NH) | Full priced webshop; ingestible. | Full priced webshop; straightforward to ingest. |
| **Hoogvliet** (hoogvliet.com) | Regional (Zuid-Holland) | Full priced webshop (commerce platform with JSON endpoints); ingestible. | Full priced webshop with JSON endpoints. |
| **Spar** (spar.nl) | Convenience/city stores | Priced webshop; ingestible. Prices skew higher — good contrast in comparisons. | Priced webshop; prices skew higher — useful price contrast in comparisons. |
| **Picnic** (picnic.nl) | Online-only, app-only supermarket | No public website assortment, **but** the app API is famously reverse-engineered (community client libraries exist, e.g. python-picnic-api); requires a (free) account login. No product links. | Reverse-engineered app API requires a free account login → higher ToS risk; keep read-only and low-frequency. No product deep-links. |
| **Ekoplaza** (ekoplaza.nl) | Organic chain (absorbed Marqt) | Full priced webshop with JSON backend; ingestible. Niche but loved by a vocal segment. | Full priced webshop with JSON backend; organic niche with a loyal segment. |

### Defunct — do not model as chains
- **Coop** → merged into **Plus**.
- **Jan Linders** → converted to **Albert Heijn** franchise stores.
- **Marqt** → merged into **Ekoplaza**.
- **Getir/Gorillas** → exited the Dutch market.

---

## 3. What we ingest per chain (target schema)

```
Product {
  chain, sku_id, ean?, name, brand?, 
  pack_size_value, pack_size_unit,        // 400, "g"
  price_cents, unit_price_cents_per_std,  // per kg/l for honest comparison
  promo?: { type, price_cents, mechanic, valid_from, valid_to },  // "Bonus 25%", "1+1 gratis"
  category_path[],                        // chain taxonomy → mapped to our aisle taxonomy
  image_url?, product_url?, available: bool,
  fetched_at
}
```

Plus a **chain-agnostic aisle taxonomy** of ~20 groups (GROENTE & FRUIT, ZUIVEL & EIEREN, VLEES & VIS, …) with per-chain ordering profiles ("AH-indeling", "Jumbo-indeling") to drive the shopping-list sort (spec §G3).

---

## 4. Ingestion architecture & cadence

- **Nightly full refresh** per chain (prices change at most daily; Bonus flips weekly on Monday for AH, mid-week variants elsewhere). Timer-triggered jobs, one per chain, staggered.
- **Politeness rules (non-negotiable):** respect robots.txt where it applies, throttle to ~1 req/sec per chain, cache aggressively, identify with a stable User-Agent, back off on 429/403. We are reading public price information the way a browser does — behave like a considerate one.
- **Snapshot raw responses to blob storage** before parsing (cheap, and lets us re-parse historically when a chain changes its JSON shape without losing days of data).
- **Change detection:** hash per product; only write deltas to the hot store. Keeps storage tiny and gives us price history for free (future feature: price trends).
- **Kill-switch per chain:** a chain integration failing must never block the pipeline for others; the app shows "prijzen van <date>" staleness per chain (mockup 07 header says "prijzen van vandaag" — make that dynamic).

Volume reality check: the entire priced NL assortment across all eleven chains is on the order of **~300k product rows**, a few hundred MB with history. This is small data — it fits comfortably in the €50/month Azure envelope (see `03…`).

---

## 5. Legal & risk posture (read before scaling)

- **Prices are facts** and facts are not copyrightable, but **database rights (EU Database Directive)** can protect substantial extractions of a structured collection, and **ToS** of the sites typically prohibit scraping. Risk is asymmetric: chains rarely act against small consumer-benefit tools (comparable consumer price-comparison tools have operated publicly for years), but a cease & desist is possible once we're visible.
- Mitigations, in order: (1) keep our own ingestion **low-volume and polite** (§4), (2) budget for a **commercial data provider** (e.g. a Pepesto-style normalised multi-chain API) as a drop-in replacement the moment revenue justifies it — our `Product` schema above is provider-agnostic by design, (3) seek **affiliate/API partnerships** (AH and Jumbo both run affiliate programs; a partnership converts the risk into a contract).
- **Account-bound APIs** are a step riskier (explicit auth = explicit ToS acceptance). Of the eleven supported chains, only **Picnic** is account-bound — keep it read-only and low-frequency, and treat it as the highest-ToS-risk connector of the set. (Out-of-scope account-walled shops like Lidl Plus and Crisp are not touched at all.)
- Get one round of written advice from an NL tech lawyer before public launch — cheap insurance.

---

## 6. What this means for the mockups

- **Onboarding chain picker (spec A3):** offer chains with a successfully
  imported live catalog. Picnic appears only after its first authenticated
  snapshot; an empty account-bound chain is never exposed.
- **Prijzen tab (mockup 07):** comparison rows for the user's selected chains;
  chains with partial online coverage (Aldi and, once activated, Picnic) show
  "*n* items niet in assortiment" instead of a fake total. The mockup
  demonstrates this pattern with a Lidl row — Lidl itself is out of scope, but
  keep the honest partial-coverage UX for the in-scope chains that need it.
- **Lijst tab (mockup 06):** per-line prices from the user's home chain; footer teaser computed across selected chains.
- **Bonus badges (mockups 01/05/06/07):** driven by the promotion metadata we ingest per chain (Bonus type, mechanic, valid dates). AH and Jumbo expose the richest mechanics ("1+1 gratis", "t/m zondag", end dates); chains with sparser promo data fall back to a simpler price-drop badge.
