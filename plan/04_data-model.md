# Data model (PostgreSQL, three schemas)

**Conventions:** PKs `uuid` (UUIDv7, client-generatable for offline sync); money = `integer` cents; every synced `app.*` table carries `created_at`, trigger-maintained `updated_at`, `deleted_at` (tombstone). Embeddings **`vector(512)`** (`text-embedding-3-small`, `dimensions=512`) — deliberate B1ms sizing: 300k × 512 ≈ 0.6 GB incl. index.

## 1. Schema `app` (all synced, all in GDPR export)

```
users             id · email citext UNIQUE NULL (guest) · apple_sub/google_sub UNIQUE NULL · password_hash NULL ·
                  display_name · is_guest · locale ('nl'|'en') · units · default_servings · diet_flags text[] ·
                  home_chain_ids text[] · purge_after NULL · timestamps+deleted_at
devices           id · user_id · platform · push_token NULL · refresh_token_hash · notification_prefs jsonb · last_seen_at
households        id · name · created_by;   household_members (household_id,user_id) PK · role · joined_at
recipes           id · owner_id · household_id NULL · title · origin ('import'|'manual'|'crawled_save'|'shared') ·
                  source_url · source_platform · source_author · images jsonb ·
                  servings_base · time_prep_min · time_cook_min ·
                  ingredients jsonb   -- B8: [{raw_text,quantity,unit,item_normalised,note,confidence}]
                  steps jsonb         -- B8: [{order,text,timer_seconds?}]
                  nutrition jsonb · missing_fields text[] ·
                  tags text[] · cuisine · diet_flags text[] ·                    -- promoted B8 columns
                  ingredient_keys text[] GENERATED · search_tsv GENERATED ('dutch') ·
                  price_cache jsonb NULL (24h TTL) · last_cooked_at NULL · timestamps+deleted_at
                  IDX GIN(ingredient_keys) · GIN(search_tsv) · (owner_id,updated_at) · (household_id,updated_at)
recipe_collections id · owner/household · name · sort_order;  collection_membership (collection_id,recipe_id) PK
recipe_notes      id · recipe_id · user_id · note_text · modifications jsonb · UNIQUE(recipe_id,user_id)  -- C5; one writer/row
lists             id · owner/household · name · layout_chain_id ("AH-indeling" chip) · sort_order
list_items        id · list_id · name · quantity · unit · item_normalised NULL ·
                  aisle_group_id FK catalog.aisle_taxonomy (user-overridable, G3) · sort_order · is_manual ·
                  provenance jsonb    -- [{recipe_id,plan_entry_id,quantity,unit}] → "samengevoegd: shakshuka (1) + nasi (2)"
                  matches jsonb       -- {chain_id:{sku_id,confidence,user_pinned}}
                  checked · checked_by · checked_at · IDX (list_id,updated_at)   -- sync hot path
plans             id · owner/household · week_start date · applied_template_id NULL · UNIQUE(scope,week_start)
plan_entries      id · plan_id · recipe_id · entry_date date NULL (NULL = "Zonder datum") · meal_slot · servings · sort_order
plan_templates    id · owner/household · name · entries jsonb ([{weekday|null,meal_slot,recipe_id,servings}])
pantry_items      id · owner/household · name · item_normalised · quantity NULL · unit · ean NULL ·
                  source ('manual'|'purchased'|'barcode') · expires_at NULL
match_corrections id · user_id · chain_id · item_normalised · chosen_sku_id · rejected_sku_id NULL ·
                  UNIQUE(user_id,chain_id,item_normalised)             -- per-user override, wins at match time
match_overrides_agg (chain_id,item_normalised,sku_id) PK · votes · last_seen_at   -- nightly rebuilt aggregate (E5)
import_jobs       id (=importId) · user_id · source_url · url_hash · platform ·
                  status ('queued'|'scraping'|'transcribing'|'parsing'|'ready'|'failed') ·
                  failure_kind ('unusable_422'|'transient_503') NULL · warnings jsonb ·
                  result_recipe jsonb NULL · apify_cost_usd · IDX (user_id,created_at) · (url_hash)
subscriptions     user_id PK · tier ('free'|'premium'|'lifetime') · store · store_txn_id · status · valid_until
usage_counters    (user_id, period 'YYYYMM') PK · video_imports · ocr_imports   -- monthly quota enforcement
export_jobs       id · user_id · kind ('gdpr_export'|'account_delete') · status · blob_path · requested/completed/expires_at
```

## 2. Schema `catalog` (ingest-owned; read-only to the API)

```
chains            id text PK ('ah','jumbo','plus','dirk','dekamarkt','aldi','vomar','hoogvliet','spar','picnic','ekoplaza') ·
                  display_name · connector ('detailresult' for dirk+dekamarkt) ·
                  full_assortment bool (false: aldi, dekamarkt, picnic → honest-gaps UX) ·
                  enabled (kill switch) · last_ingest_at · last_ingest_status jsonb
products          (chain_id, sku_id) PK · ean NULL · name · brand NULL · pack_size_value · pack_size_unit ·
                  price_cents · unit_price_cents_per_std · std_unit ·
                  promo jsonb NULL ({type,price_cents,mechanic,valid_from,valid_to}) ·
                  promo_price_cents NULL · promo_valid_to NULL          -- denormalised for deal queries
                  category_path text[] · aisle_group_id · image_url · product_url NULL (picnic: none) · available ·
                  content_hash · first_seen_at · last_seen_at · updated_at
                  IDX GIN(name gin_trgm_ops)                            -- the E3 fuzzy workhorse
                  IDX (chain_id,aisle_group_id) · (ean) · PARTIAL (chain_id,promo_valid_to) WHERE promo — "in de aanbieding"
price_history     (chain_id,sku_id,valid_from) PK · price_cents · promo…   -- delta rows only; trends for free
product_embeddings (chain_id,sku_id) PK · embedding vector(512) · model · updated_at
                  IDX HNSW cosine (m=16, ef_construction=64; ivfflat fallback if B1ms RAM bites)
                  -- separate table so nightly upserts never rewrite vectors; embed only new/renamed products
aisle_taxonomy    id smallint PK · slug · name_nl ('GROENTE & FRUIT', 'ZUIVEL & EIEREN', …) · default_sort  -- ~20 rows, seeded
chain_aisle_profiles (chain_id,aisle_group_id) PK · sort_order          -- "AH-indeling", "Jumbo-indeling"
chain_category_map  (chain_id,category_prefix) PK · aisle_group_id      -- chain taxonomy → ours
ingredient_lexicon  id · item_normalised UNIQUE · aliases text[] · default_unit · aisle_group_id ·
                    embedding NULL · is_seed · IDX GIN(aliases)         -- cold-start seed (spec §21)
lexicon_products    (item_normalised,chain_id) PK · sku_id · rank       -- curated hints; beat fuzzy/vector when present
```

## 3. Schema `discovery` (Module N)

```
crawl_sources     id · domain UNIQUE · name · sitemap_url · cadence ('weekly') · robots_config jsonb ·
                  enabled · last_crawl_at · last_crawl_stats jsonb      -- one row per docs/05 §2 site; config-only
blocklist         domain PK · reason · added_at                         -- checked by crawler AND feed; same-day takedown
crawled_recipes   id · source_id · source_url UNIQUE · canonical_url · title · author · site_name (attribution) ·
                  image_url · cached_thumb_path (≤50KB) ·
                  recipe jsonb (canonical B8, origin:'crawled') ·
                  ingredient_keys text[] · diet_flags · tags · servings · time_total_min ·
                  content_hash · dedup_key (sha256(norm title + sorted item set)) — cross-site syndication ·
                  search_tsv GENERATED · first_seen_at · last_seen_at · dead_at NULL (404/410 ⇒ hidden)
                  IDX GIN(ingredient_keys) — "ook in Ontdek zoeken" (N4) · GIN(search_tsv) · (dedup_key) · (source_id)
recipe_prices     (crawled_recipe_id,chain_id) PK · price_per_portion_cents NULL · missing_count ·
                  matched_skus jsonb — changed-SKU invalidation · deal_overlap_count · computed_at
                  IDX (chain_id,price_per_portion_cents)                -- feed ranking
```

## 4. Indexes that matter (consolidated)

trgm GIN on `products.name` (E3 fuzzy) · HNSW on `product_embeddings` (semantic: "passata" ≈ "gezeefde tomaten") · GIN `ingredient_keys` on both corpora (mockup-02 filter: `@>` = *alle*, `&&` = *één van*) · GIN `search_tsv` dutch config (C3 + N4) · `(scope, updated_at)` on every synced table (pull-cursor hot path) · partial promo index (Prijzen deals + ranking).

## 5. Sync model

- **Pull:** per-entity cursor = highest server-set `updated_at` seen; `GET /sync?since=…&entities=…` returns changed rows incl. tombstones (kept 90 days; older offline clients full-resync).
- **Push:** client-generated UUIDv7 ids; mutations carry `base_updated_at`; conflicts = **LWW per field group** (on `list_items`: {checked…} · {name,qty,unit} · {aisle,sort} · {matches}; on `recipes`: {ingredients,steps} · {tags,cuisine,diet}); server timestamp breaks ties.
- **Notes exempt:** `recipe_notes` keyed `(recipe_id,user_id)` — one writer per row; household members can never overwrite each other's notes.
- Offline: recipes readable from local cache (expo-sqlite); mutation queue replays in order; rejected pushes surface as non-blocking toasts (M2).

## 6. GDPR export & delete (A2/A4, P0)

Export: `POST /me/export` → queue → worker streams all owned `app.*` rows into a zip (`data.json` human-readable + `*.ndjson` per table + recipe images) → `gdpr-exports` + 24 h SAS URL via push/in-app. Delete: soft-delete + revoke all refresh tokens, `purge_after = now()+30d`, nightly purge hard-deletes rows/blobs; owner's household-shared recipes transfer or delete by explicit choice. Durability backstop = PITR **plus** the independent nightly immutable `pg_dump`.
