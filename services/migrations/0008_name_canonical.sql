-- 0008 — catalog.name_canonical (owner's AI-canonicalised product names, WS2).
-- Built offline with batch GPT tagging over the scraped catalogs (~79k names);
-- the matcher uses canonical_key as a cross-chain bridge: two SKUs with the
-- same canonical_key are the same underlying product ("gezeefde tomaten"
-- at AH = "passata" at Jumbo). Seeded by scripts/catalog-seed-from-silver.mjs.

CREATE TABLE IF NOT EXISTS catalog.name_canonical (
  name_search   text PRIMARY KEY,          -- fold_text(store-prefixed product name)
  canonical_key text NOT NULL,
  display_name  text NOT NULL,
  category      text,
  is_organic    boolean NOT NULL DEFAULT false,
  unit_type     text,                      -- weight | volume | piece
  confidence    numeric(3, 2),
  source        text,                      -- ai_batch | manual
  model         text,
  tagged_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_name_canonical_key ON catalog.name_canonical (canonical_key);

-- accent-fold helper the owner's canonical pipeline keys on (search side)
CREATE OR REPLACE FUNCTION public.fold_text(txt text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT translate(
    lower(coalesce(txt, '')),
    'áàâäãåéèêëíìîïóòôöõúùûüýÿçñ',
    'aaaaaaeeeeiiiiooooouuuuyycn'
  );
$$;
