-- 0002 — schema catalog (ingest-owned; read-only to the API) — plan/04 §2

CREATE TABLE catalog.chains (
  id                 text PRIMARY KEY,
  display_name       text NOT NULL,
  -- one connector can serve multiple chains ('detailresult' → dirk + dekamarkt)
  connector          text NOT NULL,
  -- false: aldi, dekamarkt, picnic → honest-gaps UX, never a fake total
  full_assortment    boolean NOT NULL DEFAULT true,
  -- per-chain kill switch (WS2); flipping it must never require a deploy
  enabled            boolean NOT NULL DEFAULT true,
  last_ingest_at     timestamptz,
  last_ingest_status jsonb
);

CREATE TABLE catalog.aisle_taxonomy (
  id           smallint PRIMARY KEY,
  slug         text NOT NULL UNIQUE,
  name_nl      text NOT NULL,
  default_sort smallint NOT NULL
);

CREATE TABLE catalog.chain_aisle_profiles (
  chain_id       text NOT NULL REFERENCES catalog.chains(id),
  aisle_group_id smallint NOT NULL REFERENCES catalog.aisle_taxonomy(id),
  sort_order     smallint NOT NULL,
  PRIMARY KEY (chain_id, aisle_group_id)
);

CREATE TABLE catalog.chain_category_map (
  chain_id        text NOT NULL REFERENCES catalog.chains(id),
  category_prefix text NOT NULL,
  aisle_group_id  smallint NOT NULL REFERENCES catalog.aisle_taxonomy(id),
  PRIMARY KEY (chain_id, category_prefix)
);

CREATE TABLE catalog.products (
  chain_id                 text NOT NULL REFERENCES catalog.chains(id),
  sku_id                   text NOT NULL,
  ean                      text,
  name                     text NOT NULL,
  brand                    text,
  pack_size_value          numeric,
  pack_size_unit           text,
  price_cents              integer NOT NULL,
  unit_price_cents_per_std numeric,
  std_unit                 text,
  promo                    jsonb,          -- {type,price_cents,mechanic,valid_from,valid_to}
  promo_price_cents        integer,        -- denormalised for deal queries
  promo_valid_to           timestamptz,
  category_path            text[] NOT NULL DEFAULT '{}',
  aisle_group_id           smallint REFERENCES catalog.aisle_taxonomy(id),
  image_url                text,
  product_url              text,           -- NULL for picnic (no deep links)
  available                boolean NOT NULL DEFAULT true,
  content_hash             text NOT NULL,  -- delta upserts skip unchanged rows
  first_seen_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id)
);
-- the E3 fuzzy workhorse
CREATE INDEX idx_products_name_trgm ON catalog.products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_chain_aisle ON catalog.products (chain_id, aisle_group_id);
CREATE INDEX idx_products_ean ON catalog.products (ean) WHERE ean IS NOT NULL;
-- "in de aanbieding" / Prijzen deal queries
CREATE INDEX idx_products_promo ON catalog.products (chain_id, promo_valid_to) WHERE promo IS NOT NULL;

-- delta rows only; price trends for free
CREATE TABLE catalog.price_history (
  chain_id    text NOT NULL,
  sku_id      text NOT NULL,
  valid_from  timestamptz NOT NULL,
  price_cents integer NOT NULL,
  promo       jsonb,
  PRIMARY KEY (chain_id, sku_id, valid_from),
  FOREIGN KEY (chain_id, sku_id) REFERENCES catalog.products(chain_id, sku_id) ON DELETE CASCADE
);

-- separate table so nightly catalog upserts never rewrite vectors;
-- embed only new/renamed products (plan/04 §2)
CREATE TABLE catalog.product_embeddings (
  chain_id   text NOT NULL,
  sku_id     text NOT NULL,
  embedding  vector(512) NOT NULL,
  model      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id),
  FOREIGN KEY (chain_id, sku_id) REFERENCES catalog.products(chain_id, sku_id) ON DELETE CASCADE
);
CREATE INDEX idx_product_embeddings_hnsw ON catalog.product_embeddings
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- cold-start seed lexicon (~500 NL ingredient↔SKU pairs, spec §21)
CREATE TABLE catalog.ingredient_lexicon (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_normalised text NOT NULL UNIQUE,
  aliases         text[] NOT NULL DEFAULT '{}',
  default_unit    text,
  aisle_group_id  smallint REFERENCES catalog.aisle_taxonomy(id),
  embedding       vector(512),
  is_seed         boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_lexicon_aliases ON catalog.ingredient_lexicon USING gin (aliases);

-- curated hints; beat fuzzy/vector when present
CREATE TABLE catalog.lexicon_products (
  item_normalised text NOT NULL,
  chain_id        text NOT NULL REFERENCES catalog.chains(id),
  sku_id          text NOT NULL,
  rank            smallint NOT NULL DEFAULT 1,
  PRIMARY KEY (item_normalised, chain_id)
);
