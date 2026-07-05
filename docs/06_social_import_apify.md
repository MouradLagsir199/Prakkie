# Prakkie — Social recipe import pipeline (Apify + Azure + OpenAI)

> **Purpose:** the implementation spec for Module B (recipe import) — how a social/blog URL becomes a structured Dutch recipe.
> **Provenance:** this is the owner's already-prototyped Apify architecture, **re-homed from Supabase Edge Functions to Azure** and aligned with the rest of the pack. **Scraping/transcription = Apify actors. Parsing = OpenAI.** The Apify actor IDs and inputs below are the owner's tested configuration — reproduce them **verbatim**; they are the hard-won part.
> **Where this sits:** it *is* Module B (B1–B4, B7) of `01_functional_spec.md`. The functional spec says *what* import does; this file says *how*.

---

## 0. What changed vs the original Supabase design

| Original (uploaded doc) | Prakkie / Azure |
|---|---|
| Supabase Edge Function `import-recipe` (Deno) | **Azure Function `import-recipe`** (HTTP-triggered) — same responsibilities |
| Edge Function secret `APIFY_API_TOKEN` | **Azure Key Vault** secret `APIFY_API_TOKEN`, read via managed identity |
| OpenAI key as Edge secret | **Key Vault** secret `OPENAI_API_KEY` |
| Supabase infra | Azure (West Europe), see `03_azure_architecture_and_storage.md` |
| Apify only inside the Edge Function; app never calls Apify | **Unchanged** — Apify only inside the backend; the mobile app only ever calls our own `import-recipe` endpoint |
| OpenAI parses the fused context | **Unchanged** — OpenAI is the parser |

Everything else about the flow, actors, fallbacks and cost guards is carried over as-is.

---

## 1. Global import flow

The mobile app POSTs a `sourceUrl` to the Azure Function `import-recipe`. The function detects the platform with `detectPlatform()`:

- `instagram.com` → `instagram`
- `tiktok.com` → `tiktok`
- `facebook.com` or `fb.watch` → `facebook`
- `pinterest.*` or `pin.it` → `pinterest`
- `youtube.com` or `youtu.be` → `youtube`
- else → `blog`

It then builds a `LinkContext` (title, description/caption, image, provider, structured recipe data, transcript, warnings). Only then does **OpenAI** parse the content into a Dutch recipe.

**Rule:** Apify is used **only inside the Azure Function**. The mobile app never calls Apify directly. This keeps the `APIFY_API_TOKEN` server-side and lets us cache, cost-guard and swap actors without shipping an app update.

### Azure hosting notes (new)
- **Compute:** the fast paths (blog/caption/metadata) return in a few seconds and fit Azure Functions Consumption comfortably. The **video-transcript paths can run 120–180 s** (see §3), which is awkward for a synchronous mobile request and can hit gateway timeouts. Recommended:
  - keep `import-recipe` synchronous for the fast paths;
  - for video transcription, run it **asynchronously** — either Azure **Durable Functions** (orchestrator + polling status endpoint) or the queue already in `03…` (return `202 Accepted` + `importId`, app polls `GET /import/{id}`), OR host `import-recipe` on **Azure Container Apps** (no hard request-timeout) if you prefer to keep it one synchronous call. The mockup-04 "12 s" experience is the common case; the async path protects the 5-minute tail.
- **Secrets:** `APIFY_API_TOKEN`, `OPENAI_API_KEY` in Key Vault; Function uses managed identity, never inlines keys.
- **Caching (new, saves real money):** hash the canonical `sourceUrl` and cache the raw Apify result + parsed recipe in Blob/store for N days. Re-imports of the same viral Reel then cost €0 and return instantly. Apify charges per run; dedupe is the cheapest optimisation available.
- **Premium gating:** video-transcript imports are the expensive path → gate behind premium per the monetisation model (`01…` §20). Blog/caption imports stay free/unlimited.

---

## 2. Shared Apify wrapper

All Apify calls go through `runApifyActor(actorId, input, options)`.

- Requires the `APIFY_API_TOKEN` secret (now from Key Vault).
- Uses Apify endpoint `run-sync-get-dataset-items`.
- Sends `format=json` and `clean=true`.
- Default `timeout` = 120 s unless overridden.
- Always sets `maxPaidDatasetItems=1`.
- Can set `maxTotalChargeUsd` per actor.
- Throws if the actor call is not 2xx.

Imports are deliberately **single-post / single-result**. We do **not** run search or batch scrapes from the app-import path.

---

## 3. Video & transcript rules

- `MAX_SOCIAL_VIDEO_SECONDS = 5 * 60` → social video transcription is capped at 5 minutes.
- A transcript is only added to the import context if ≥ ~40 chars of usable transcript text comes back.
- The transcript is then truncated to ≤ 12,000 chars.

---

## 4. Per-platform integration

### 4.1 Instagram

**Apify actors used**

1. `apify~instagram-reel-scraper` — Reel URLs only.
```json
{
  "username": ["<canonical-instagram-url>"],
  "resultsLimit": 1,
  "includeTranscript": false,
  "includeDownloadedVideo": false,
  "includeSharesCount": false
}
```
2. `apify~instagram-scraper` — second attempt for reels and posts.
```json
{
  "directUrls": ["<canonical-instagram-url>"],
  "resultsType": "reels | posts",
  "resultsLimit": 1,
  "addParentData": false
}
```
3. `apify~instagram-post-scraper` — last metadata/caption fallback.
```json
{
  "username": ["<original-url>"],
  "resultsLimit": 1,
  "dataDetailLevel": "basicData"
}
```
4. `S9A11NvceWaGorwwh` — Instagram transcript actor.
```json
{ "videoUrl": "<instagram-url>" }
```
5. `CVQmx5Se22zxPaWc1` — universal social transcript fallback.
```json
{ "start_urls": "<instagram-url>" }
```

**Fallback strategy** — Instagram has its own path via `collectInstagramLinkContext()`:
1. Fetch page metadata with `fetchPageMetadata(url, 12)`.
2. If that already has usable recipe signal, stop.
3. Otherwise try the three IG metadata actors above, in fixed order.
4. An Apify metadata result must have a caption/text; without one it counts as failed.
5. If the caption/metadata has usable recipe signal, stop.
6. If not, try the specific transcript actor `S9A11NvceWaGorwwh`.
7. If that yields no transcript, try the universal transcript actor `CVQmx5Se22zxPaWc1`.
8. If still nothing, return context with warnings; `hasUsableRecipeSignal()` decides go/no-go.

**Used from IG results:** caption from `caption|description|text|alt`; owner from `ownerUsername|username|ownerFullName|fullName`; url from `inputUrl|url|shortUrl`; image from `displayUrl|imageUrl|thumbnailUrl|thumbnail|image|images|displayResources|media`.

**Limitations:** IG oEmbed isn't really configured in `fetchPlatformOembed()` (only TikTok + Pinterest have endpoints); private/login-required posts are unreliable; a Reel that only *talks about* a recipe without quantities must be marked incomplete by OpenAI, never hallucinated.

### 4.2 TikTok

**Apify actors used**
1. `CVQmx5Se22zxPaWc1` — universal social transcript actor.
```json
{ "start_urls": "<tiktok-url>" }
```

**Not yet used:** no dedicated TikTok metadata/post scraper. TikTok metadata currently comes from `fetchPageMetadata(url)`, public TikTok oEmbed (`https://www.tiktok.com/oembed?url=...`), and optionally the transcript actor.

**Fallback strategy** — general `collectLinkContext()` path:
1. Fetch page metadata.
2. Try TikTok oEmbed.
3. Build base context (title, description, image, provider, any JSON-LD recipe data).
4. If no complete structured recipe, always try the universal transcript actor.
5. If transcription succeeds, transcript goes to OpenAI.
6. If it fails, only page metadata/oEmbed remains.
7. If no usable signal after that, return 422 or 503 depending on warnings.

**Limitations:** without a TikTok post scraper we may miss captions not visible via oEmbed/page metadata; transcription is the key fallback, so the universal transcript actor must be reliable enough for TikTok or TikTok import stays fragile.

### 4.3 Facebook

**Apify actors used**
1. `KoJrdxJCTtpon81KY` — Facebook post scraper.
```json
{
  "startUrls": [{ "url": "<facebook-url>" }],
  "resultsLimit": 1,
  "captionText": true
}
```
2. `CVQmx5Se22zxPaWc1` — universal social transcript actor.
```json
{ "start_urls": "<facebook-url>" }
```

**Fallback strategy** — general `collectLinkContext()` path:
1. Page metadata and the FB post scrape run in parallel.
2. The FB actor must return post text; the code looks at `text` first.
3. If there's a `sharedPost`, it also uses `sharedPost.text`.
4. Image comes from the shared/source post first, then the top-level post.
5. No FB oEmbed endpoint is configured.
6. Transcription is only attempted when there's no complete structured recipe **and** (the URL looks like an FB video **or** the metadata/post text has no usable recipe signal).
7. Transcription runs via the universal social transcript actor.
8. If FB returns no post text and page metadata is also useless → 422 or 503.

**Limitations:** posts in groups or behind login can fail; no dedicated FB transcript actor; shared posts only partly supported (need `sharedPost` with usable text).

### 4.4 Pinterest

**Apify actors used**
1. `tseqJicQpIxyFdHNB` — Pinterest pin scraper (currently `PINTEREST_MEDIA_ACTOR`).
```json
{
  "startUrls": ["<pinterest-or-pin.it-url>"],
  "type": "all-pins",
  "limit": 1,
  "sentinent_analysis": false,
  "content_analysis": false,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```
Extra guard: `maxTotalChargeUsd = 1.00`; wrapper also sets `maxPaidDatasetItems=1`.

2. `VZTENHFJOyJEGIKCv` — direct media transcript actor for Pinterest video URLs.
```json
{
  "mediaUrl": "<direct-video-url>",
  "maxAudioMinutes": 5,
  "diarize": false,
  "smartFormat": true
}
```
Extra guard: `maxTotalChargeUsd = 0.25`; timeout = 180 s.

**Fallback strategy** — general `collectLinkContext()` path:
1. Page metadata and the Pinterest scrape run in parallel.
2. Pinterest oEmbed tried via `https://www.pinterest.com/oembed.json?url=...`.
3. Actor output may have fields on the item directly, but the code also supports the newer nested format under `item.pin`.
4. It looks for title, description, image, linked recipe URL, video URL, captions URL and rich recipe data.
5. If there's a `linkedRecipeUrl`, it also fetches that external page via `fetchPageMetadata(linkedRecipeUrl)`.
6. Structured recipe data is gathered from `pinterestMedia.richRecipe`, JSON-LD of the linked page, and JSON-LD of the original Pinterest page.
7. If no complete structured recipe and the actor found a video URL, try transcription.
8. First try public captions via `captionsUrl`.
9. If captions are missing/fail, try direct media transcription via `VZTENHFJOyJEGIKCv`.
10. Direct media transcription only runs when there's a video URL, a known duration, and duration ≤ 5 min.

**Used from Pinterest results:** `pin` from `item.pin` else `item`; maker from `item.creator`; description from `rich_summary.display_description|pin.closeup_description|pin.description|pin.closeup_unified_description|pin.alt_text|item.description|item.text|item.caption`; images from `item.media.images|pin.media.images|pin.images|item.images|` generic image fields; external recipe link from `item.source_url|item.sourceUrl|item.trackedLink|item.link|pin.tracked_link|pin.trackedLink|pin.link|pin.sourceUrl`; rich recipe from `pin.rich_metadata.recipe`.

**Limitations:** the pin scraper is a broad actor used deliberately with `limit: 1` for single-pin import; a `pin.it` shortlink that doesn't resolve cleanly can yield little data; video transcription needs a direct media URL + duration; if duration is missing, transcription is skipped to protect cost.

### 4.5 YouTube

**Apify actors used:** none yet.

**Fallback strategy:** YouTube is recognised as a platform but has no Apify metadata/transcript integration yet. Only plain page metadata is tried (no YouTube oEmbed, no transcript actor). Import can only proceed if the page itself has enough recipe signal or structured recipe data.

**Limitations:** YouTube video recipes are functionally not supported yet — an explicit future integration slot.

### 4.6 Blogs & general websites

**Apify actors used:** none.

**Fallback strategy:** plain HTML fetch with browser-like headers → read metadata from title/meta tags → extract JSON-LD Recipe data → if no usable recipe signal, return 422. (This is the same JSON-LD-first path the discovery crawler uses; see `05_recipe_content_sources.md`.)

---

## 5. When 422 vs 503 comes back

After all scraping/transcript steps, `hasUsableRecipeSignal()` checks whether there's enough for OpenAI to parse. A context is usable if e.g.:
- JSON-LD recipe data with ingredients/instructions/name/description;
- a transcript of ≥ 60 chars;
- for Pinterest, a linked recipe URL;
- a title/description/oEmbed text of ≥ 80 chars containing recipe words (ingredients, bereiding, bakken, koken, sauce, soup, pasta, …).

If there's no usable signal:
- **503** if warnings look like transient infra problems (rate limits, memory limits, timeouts, 5xx);
- **422** if the platform simply returned no public recipe data.

---

## 6. After Apify → OpenAI parsing

Apify never produces the final recipe. It only supplies source material: caption, post text, title, description, image/thumbnail, linked recipe URL, rich recipe data, transcript. OpenAI then receives the merged context. The prompt requires:

- all user-facing output in natural Dutch;
- ingredients as Dutch supermarket terms;
- `green onion` / `spring onion` / `scallion` / `lente-ui` always as `bosui`;
- **no invented** quantities, ingredients, servings or instructions;
- incomplete imports marked with `missingFields`;
- Dutch tags generated for filtering.

The parsed result maps onto the canonical `Recipe` schema in `01_functional_spec.md` §B8 (with `missing_fields[]` populated and per-ingredient `confidence`), then lands in the edit-before-save review screen (mockup 04).

> **Parser choice:** OpenAI, matching the owner's existing implementation. Keep the parser behind a thin interface (`parseRecipe(context) -> Recipe`) so the model/provider is swappable without touching the scraping layer — but OpenAI is the chosen default across this pack.

---

## 7. Known improvement points (owner's backlog)

1. TikTok lacks a dedicated metadata/caption actor.
2. Facebook lacks a dedicated transcript actor.
3. Instagram oEmbed isn't really enabled → effectively not a source today.
4. YouTube has no real import strategy yet.
5. Pinterest is now cost-safe, but therefore unsuitable for search pages / batch import from the app (by design).
6. Across all platforms: private/login-only content stays unreliable without an explicit session/auth strategy.

## 8. Azure additions to prioritise (new, on top of the backlog)

- [ ] Move `APIFY_API_TOKEN` + `OPENAI_API_KEY` to Key Vault; wire managed identity.
- [ ] Implement URL-hash caching (raw Apify result + parsed recipe) in Blob/store — dedupe viral reels, cut Apify spend.
- [ ] Async path (Durable Functions or queue + status endpoint) for the ≤5-min video transcription tail; keep fast paths synchronous.
- [ ] Per-user monthly video-import quota tied to the premium gate (`01…` §20).
- [ ] Apify spend alerting: dashboard on runs/day and $/day; the per-actor `maxTotalChargeUsd` + `maxPaidDatasetItems=1` are the hard caps, alerting is the early warning.
