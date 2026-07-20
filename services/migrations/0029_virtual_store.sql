-- 0029 — virtuele supermarkt fase 0 (plan/12): de winkel-registry.
-- Drie tabellen:
--   store_departments  — de ~10 loopbare winkel-afdelingen (vaste indeling
--                        over de 20 schap-groepen; OVERIG staat er bewust
--                        niet in — alleen vindbaar via zoeken)
--   store_categories   — de gecureerde "glazen panelen": een paneel bindt
--                        product_intent-producten via head_terms × schap-
--                        groepen (curatie: scripts/store-categories.curated.csv
--                        → scripts/seed-store-categories.mjs)
--   store_category_stats — nachtelijk ververste aggregaten per paneel × keten
--                        (aantal · vanaf-prijs · bonus-count) zodat een
--                        afdeling-scene één goedkope query is, geen live
--                        count(*) over 86k producten per request.

CREATE TABLE IF NOT EXISTS catalog.store_departments (
  id              smallint PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  name_nl         text NOT NULL,
  theme           text NOT NULL CHECK (theme IN ('produce', 'bakery', 'fridge', 'freezer', 'dry', 'nonfood')),
  sort            smallint NOT NULL,
  aisle_group_ids smallint[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS catalog.store_categories (
  id              serial PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  name_nl         text NOT NULL,
  department_id   smallint NOT NULL REFERENCES catalog.store_departments(id),
  fixture_type    text NOT NULL CHECK (fixture_type IN ('shelf', 'fridge', 'freezer', 'produce', 'bakery', 'endcap')),
  sort            integer NOT NULL DEFAULT 0,
  aisle_group_ids smallint[] NOT NULL,
  head_terms      text[] NOT NULL,
  keywords        text[] NOT NULL DEFAULT '{}',
  image_url       text,          -- archetype-productfoto, gezet door de stats-refresh
  enabled         boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_categories_dept ON catalog.store_categories (department_id, sort) WHERE enabled;

CREATE TABLE IF NOT EXISTS catalog.store_category_stats (
  category_id     integer NOT NULL REFERENCES catalog.store_categories(id) ON DELETE CASCADE,
  chain_id        text NOT NULL,
  product_count   integer NOT NULL,
  min_price_cents integer NOT NULL,
  promo_count     integer NOT NULL DEFAULT 0,
  refreshed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, chain_id)
);

-- Vaste afdeling-indeling (plan/12 §5.3); idempotent zodat een her-run of een
-- latere herindeling gewoon dezelfde migratie-stijl kan volgen.
INSERT INTO catalog.store_departments (id, slug, name_nl, theme, sort, aisle_group_ids) VALUES
  (1,  'agf',            'Groente & fruit',          'produce', 10,  '{1}'),
  (2,  'bakkerij',       'Bakkerij',                 'bakery',  20,  '{6}'),
  (3,  'zuivel-kaas',    'Zuivel, kaas & eieren',    'fridge',  30,  '{2,5}'),
  (4,  'vlees-vis-vega', 'Vlees, vis & vega',        'fridge',  40,  '{3,4}'),
  (5,  'ontbijt-beleg',  'Ontbijt & beleg',          'dry',     50,  '{7}'),
  (6,  'voorraadkast',   'Voorraadkast',             'dry',     60,  '{8,9,10,11}'),
  (7,  'snoep-snacks',   'Snoep, koek & snacks',     'dry',     70,  '{12,13}'),
  (8,  'dranken',        'Dranken',                  'dry',     80,  '{15,16,17}'),
  (9,  'diepvries',      'Diepvries',                'freezer', 90,  '{14}'),
  (10, 'huishouden',     'Huishouden & verzorging',  'nonfood', 100, '{18,19}')
ON CONFLICT (id) DO UPDATE SET
  slug = EXCLUDED.slug, name_nl = EXCLUDED.name_nl, theme = EXCLUDED.theme,
  sort = EXCLUDED.sort, aisle_group_ids = EXCLUDED.aisle_group_ids;

-- API leest alles; de stats-refresh draait ín de API (nightly timer + ops-
-- trigger) en schrijft stats + paneel-thumbnail. Panelen zelf worden als
-- admin geseed (seed-store-categories.mjs), ingest blijft er vanaf.
GRANT SELECT ON catalog.store_departments, catalog.store_categories, catalog.store_category_stats TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.store_category_stats TO prakkie_app;
GRANT UPDATE (image_url, updated_at) ON catalog.store_categories TO prakkie_app;
GRANT SELECT ON catalog.store_departments, catalog.store_categories, catalog.store_category_stats TO prakkie_ingest;
