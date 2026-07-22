-- 0043 — Canonical Product Graph (matching v2, docs/09 §3 pijler 2 / Fase 3; owner 2026-07-21).
--
-- Voorberekende equivalentieklassen: elke geverifieerde SKU hoort bij één
-- canonieke knoop (categorie + harde facetten). Siblings onder dezelfde knoop
-- zijn "hetzelfde product-concept" over ketens/merken heen — de basis voor
-- runtime EXACT/EQUIVALENT (Fase 4) en de basket-optimizer (Fase 6). Offline
-- gebouwd door services/ean-enrichment/canonical-run.mjs uit catalog.product_facets.
CREATE TABLE IF NOT EXISTS catalog.canonical_product (
  canonical_id    text PRIMARY KEY,
  category        text,
  facet_key       text NOT NULL,
  label           text,
  member_count    integer NOT NULL DEFAULT 0,
  matcher_version text NOT NULL,
  built_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.canonical_member (
  chain_id      text NOT NULL,
  sku_id        text NOT NULL,
  canonical_id  text NOT NULL REFERENCES catalog.canonical_product(canonical_id) ON DELETE CASCADE,
  confidence    numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  reasons       text[] NOT NULL DEFAULT '{}',
  built_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id)
);
CREATE INDEX IF NOT EXISTS idx_canonical_member_node ON catalog.canonical_member (canonical_id);

GRANT SELECT ON catalog.canonical_product TO prakkie_app;
GRANT SELECT ON catalog.canonical_member  TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.canonical_product TO prakkie_ingest;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.canonical_member  TO prakkie_ingest;
