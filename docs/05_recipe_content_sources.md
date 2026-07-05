# Prakkie — Dutch recipe content sources (discovery feed)

> **Purpose:** inventory of the known Dutch recipe websites we will crawl to populate the discovery feed (Module N in `01_functional_spec.md`), with per-site technical clues, crawl posture and the legal model that makes this defensible.
> **Golden rule:** we **index and attribute, we don't republish**. The feed shows title + image + our own computed price/time badges + source; full structured content powers matching/pricing and the user's *saved* copy, exactly like a user-initiated import (spec B2/B7). Every recipe links out to its source.

---

## 1. Extraction approach (applies to all sites)

1. **JSON-LD first.** Virtually all serious Dutch recipe sites (both supermarket-owned and food blogs) embed `schema.org/Recipe` structured data for Google's recipe rich results — machine-readable title, image, ingredients, instructions, yield, times, ratings. That is our primary extraction path: cheap, stable, and it's data the publisher *deliberately* exposes for indexing.
2. **Sitemap-driven discovery.** Crawl `sitemap.xml` (recipe sitemaps are usually separate) rather than spidering links — fewer requests, full coverage, easy change detection via `lastmod`.
3. **LLM fallback** only for high-value sources without JSON-LD (rare) — same extraction pass as import B2.
4. **Politeness:** obey robots.txt, ≤1 req/sec/site, weekly cadence, stable User-Agent with contact address ("PrakkieBot/1.0; +https://prakkie.nl/bot"), honour `noindex`, immediate per-domain blocklist on request.

## 2. Source inventory — the sites we crawl

This is the **complete supported set** — a focused list of large, well-structured Dutch recipe sites that reliably emit `schema.org/Recipe` JSON-LD. No other sites are in scope; keeping the list tight keeps crawl volume, dedup work and legal surface small.

| Source | Type / scale | Clues |
|---|---|---|
| **AH Allerhande** (ah.nl/allerhande) | Supermarket-owned, ~17–20k recipes, the national reference | Full JSON-LD; also reachable via AH's own APIs alongside product data (`02…`). Highest-quality NL structured recipes; ingredient lines map cleanly to AH SKUs — a matching-engine goldmine. Note the competitive irony: their recipes, our cross-chain prices. |
| **Jumbo recepten** (jumbo.com/recepten) | Supermarket-owned, thousands | JSON-LD; site backend shared with product API family. |
| **Plus recepten** (plus.nl/recepten) | Supermarket-owned | JSON-LD. |
| **Smulweb** (smulweb.nl) | UGC platform, one of NL's largest recipe databases (hundreds of thousands) | JSON-LD on recipe pages; quality varies wildly (UGC) — crawl, but rank low unless highly rated. |
| **Leukerecepten** (leukerecepten.nl) | Top independent food blog, thousands | JSON-LD (WordPress recipe plugins emit it). |
| **Lekker en Simpel** (lekkerensimpel.com) | Top food blog (the mockups even use @lekkersimpelnl as the example creator) | JSON-LD. |
| **Uit Paulines Keuken** (uitpaulineskeuken.nl) | Major food blog | JSON-LD. |
| **24Kitchen** (24kitchen.nl) | TV/media brand, large recipe DB | JSON-LD. |
| **Voedingscentrum** (voedingscentrum.nl/recepten) | Government nutrition centre | Public-interest recipes, nutrition-annotated; ideal for the health/nutrition angle (Module J). |

**Explicitly out of scope:** paywalled media recipes (NRC, Volkskrant koken), Pinterest (aggregator, not a source), and YouTube/Instagram/TikTok — those are the *import* pipeline (B1/B4), never bulk-crawled. Additional blogs can be added later one config file at a time (§5), but only after the supported set above is live and stable.

## 3. Content pipeline & storage

```
sitemap fetch (weekly, per site)
  → changed/new URLs → fetch page → extract JSON-LD
  → normalise into canonical Recipe schema (spec B8) with:
      origin: "crawled", source_site, source_url, author, image_url (hotlink or cached thumb ≤50KB),
      crawl fields: first_seen, last_seen, content_hash
  → ingredient normalisation (E1) → price-per-portion precompute per supported chain
  → discovery index (feed ranking features: deal overlap, diet flags, season, price p.p.)
```

- Storage: same store as the product catalog decision (`03…` §5) — a crawled-recipe corpus of even 100k recipes is ~1–2 GB with thumbs; fits every option in the €50 envelope. Raw HTML snapshots → cool Blob, 30-day retention.
- **Precomputed price-per-portion** on crawled recipes is what makes our feed unlike anyone else's: Allerhande can't show Jumbo prices; blogs show no prices at all.
- Dead-link job: source 404/410 → hide from feed (saved user copies unaffected, spec A2/N5).

## 4. Legal posture (stricter than price data — read this)

- **Ingredient lists and basic method steps are generally not copyright-protected** (facts/procedures), but **creative recipe prose, story text and photos are**, and EU **database rights** can cover substantial extraction from a curated collection. A discovery feed is more exposed than user-initiated import because *we* choose to copy at scale.
- The design mitigations are structural, not cosmetic:
  1. **Feed displays only:** title, one thumbnail, our own computed badges, attribution. No step text, no prose, in the feed.
  2. **Detail view before save:** show structured ingredients + our pricing + a prominent "Bekijk op {site}" link-out; keep step display minimal or require save-to-library (a deliberate user act, equivalent to import) — final display depth is a **launch decision pending legal advice**.
  3. JSON-LD-only extraction = taking what publishers publish *for indexing purposes*; robots.txt compliance; named bot; instant blocklist honoring.
  4. **Partnership track:** the feed sends traffic to publishers — approach the blogs early with stats; converts risk into relationships (and later, creator features).
- Get NL counsel review of the feed display depth before the feed ships. Budget line item, not optional.

## 5. What Fable 5 should build (checklist)

- [ ] Sitemap-based crawler framework with per-site config (robots, cadence, selectors) — one config file per source, no per-site code.
- [ ] JSON-LD Recipe extractor + validator (reject incomplete: no ingredients or no image → skip).
- [ ] Dedup across sites (same recipe syndicated): near-dup detection on title + ingredient set.
- [ ] Price-per-portion precompute job reusing the matching engine (E).
- [ ] "Ontdek" segment UI in the Recepten tab reusing the mockup-01 card grid + source attribution line (see `04_design_guardrails.md` addendum §5).
- [ ] Ranking v1: deal-overlap score > diet-flag match > seasonality > price p.p. ascending.
- [ ] Per-domain kill switch + takedown workflow (config flag, effective next deploy or faster).
