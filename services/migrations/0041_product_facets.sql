-- 0041 — ProductFacets (matching v2, docs/09_matching_architecture.md; owner 2026-07-21).
--
-- Per product een schone, geverifieerde facetstruct — de basis voor de canonical
-- product graph (0042+) en de EXACT/EQUIVALENT/COMPROMISE-funnel. Offline gevuld
-- door services/ean-enrichment (LLM-extractie in facet-extract.mjs + kruiscontrole
-- in facets.mjs::verifyFacets). Rijen met verified=false zijn bewust uitgesloten
-- van auto-matchen: onzekere facetten worden nooit een stille swap.
CREATE TABLE IF NOT EXISTS catalog.product_facets (
  chain_id        text NOT NULL,
  sku_id          text NOT NULL,
  category        text,
  brand_tier      text CHECK (brand_tier IN ('a_merk', 'private_label', 'value_line')),
  variant         text,
  flavor          text,
  form            text
                  CHECK (form IN ('vers', 'blik', 'pot', 'diepvries', 'gedroogd', 'houdbaar', 'bewerkt', 'non-food')),
  dietary         text[] NOT NULL DEFAULT '{}',
  type            text,
  pack_value      numeric,
  pack_unit       text,
  confidence      numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  verified        boolean NOT NULL DEFAULT false,
  disagreements   text[] NOT NULL DEFAULT '{}',
  matcher_version text NOT NULL,
  -- hervatbaarheid: sla over wanneer naam/merk/verpakking niet zijn veranderd
  name_hash       text NOT NULL,
  model           text NOT NULL,
  labeled_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id)
);

-- Alleen geverifieerde facetten doen mee aan retrieval/clustering.
CREATE INDEX IF NOT EXISTS idx_product_facets_category ON catalog.product_facets (category) WHERE verified;
CREATE INDEX IF NOT EXISTS idx_product_facets_verified ON catalog.product_facets (verified);

GRANT SELECT ON catalog.product_facets TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.product_facets TO prakkie_ingest;
