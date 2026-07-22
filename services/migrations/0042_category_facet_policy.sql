-- 0042 — Per-categorie facetbeleid (matching v2, docs/09 §3/Fase 2; owner 2026-07-21).
--
-- Welke facetten zijn HARD (kunnen niet weg-gerankt worden; een verschil → geen
-- EQUIVALENT) en welke ZACHT (alleen rangschikking) per fijnmazige categorie.
-- LLM-gedraft, mens-gecontroleerd voor de topcategorieën; onbekende categorieën
-- vallen terug op het conservatieve in-code beleid (categorie + form hard).
-- Dit is de mens-bewerkbare bron van waarheid; facets.mjs draagt dezelfde
-- startwaarden als code-fallback zodat de offline pipeline zonder DB werkt.
CREATE TABLE IF NOT EXISTS catalog.category_facet_policy (
  category     text PRIMARY KEY,
  hard_facets  text[] NOT NULL,
  soft_facets  text[] NOT NULL DEFAULT '{}',
  source       text NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'llm', 'human')),
  reviewed_by  text,
  reviewed_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON catalog.category_facet_policy TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.category_facet_policy TO prakkie_ingest;

-- Startbeleid — gelijk aan de code-fallback in facets.mjs (bron: Fase 0-golden).
INSERT INTO catalog.category_facet_policy (category, hard_facets, soft_facets, source, reviewed_by, reviewed_at)
VALUES
  ('frisdrank',   ARRAY['category','variant','flavor'], ARRAY['brand_tier','form','pack'],  'human', 'owner', now()),
  ('zuivel-melk', ARRAY['category','type','dietary'],   ARRAY['brand_tier','pack'],         'human', 'owner', now()),
  ('groente',     ARRAY['category','form','type'],      ARRAY['brand_tier','pack','dietary'],'human', 'owner', now()),
  ('suiker',      ARRAY['category','type'],             ARRAY['brand_tier','form','pack'],  'human', 'owner', now())
ON CONFLICT (category) DO NOTHING;
