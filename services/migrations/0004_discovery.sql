-- 0004 — schema discovery (Module N crawler corpus) — plan/04 §3

CREATE TABLE discovery.crawl_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain           text NOT NULL UNIQUE,
  name             text NOT NULL,
  sitemap_url      text,
  cadence          text NOT NULL DEFAULT 'weekly',
  robots_config    jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled          boolean NOT NULL DEFAULT true,
  last_crawl_at    timestamptz,
  last_crawl_stats jsonb
);

-- checked by crawler AND feed; same-day takedown
CREATE TABLE discovery.blocklist (
  domain   text PRIMARY KEY,
  reason   text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery.crawled_recipes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES discovery.crawl_sources(id),
  source_url        text NOT NULL UNIQUE,
  canonical_url     text,
  title             text NOT NULL,
  author            text,
  site_name         text NOT NULL,          -- attribution: "via Leukerecepten"
  image_url         text,
  cached_thumb_path text,                   -- ≤50KB blob thumb
  recipe            jsonb NOT NULL,         -- canonical B8, origin:'crawled'
  ingredient_keys   text[] GENERATED ALWAYS AS (public.jsonb_ingredient_keys(recipe->'ingredients')) STORED,
  diet_flags        text[] NOT NULL DEFAULT '{}',
  tags              text[] NOT NULL DEFAULT '{}',
  servings          integer,
  time_total_min    integer,
  content_hash      text NOT NULL,
  -- sha256(normalised title + sorted item set) — cross-site syndication dedup
  dedup_key         text NOT NULL,
  search_tsv        tsvector GENERATED ALWAYS AS (
                      to_tsvector('dutch', coalesce(title, '') || ' ' || public.imm_join(tags))
                    ) STORED,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  dead_at           timestamptz             -- 404/410 ⇒ hidden from the feed
);
CREATE INDEX idx_crawled_ingredient_keys ON discovery.crawled_recipes USING gin (ingredient_keys);  -- N4
CREATE INDEX idx_crawled_search ON discovery.crawled_recipes USING gin (search_tsv);
CREATE INDEX idx_crawled_dedup ON discovery.crawled_recipes (dedup_key);
CREATE INDEX idx_crawled_source ON discovery.crawled_recipes (source_id);

-- price-per-portion precompute (the badge no source site can copy)
CREATE TABLE discovery.recipe_prices (
  crawled_recipe_id       uuid NOT NULL REFERENCES discovery.crawled_recipes(id) ON DELETE CASCADE,
  chain_id                text NOT NULL REFERENCES catalog.chains(id),
  price_per_portion_cents integer,
  missing_count           integer NOT NULL DEFAULT 0,
  matched_skus            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- changed-SKU invalidation
  deal_overlap_count      integer NOT NULL DEFAULT 0,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crawled_recipe_id, chain_id)
);
CREATE INDEX idx_recipe_prices_ranking ON discovery.recipe_prices (chain_id, price_per_portion_cents);
