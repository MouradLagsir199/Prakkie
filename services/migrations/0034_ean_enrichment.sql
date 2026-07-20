-- 0034 — EAN als dé cross-chain productidentiteit (owner 2026-07-14).
--
-- Open Food Facts kent per EAN merk + naam + verpakking. Een geplande
-- Container Apps Job (services/ean-enrichment) matcht catalogusregels zónder
-- scraper-EAN (Aldi vrijwel altijd, PLUS vaak, AH incidenteel) offline aan de
-- OFF-parquet en vult catalog.products.ean. De provenance staat hier, zodat
-- een her-run of een betwiste match herleidbaar en terugdraaibaar is — de
-- runtime-matcher kijkt alléén naar products.ean.
CREATE TABLE IF NOT EXISTS catalog.ean_enrichment (
  chain_id         text NOT NULL REFERENCES catalog.chains(id),
  sku_id           text NOT NULL,
  ean              text NOT NULL,
  method           text NOT NULL CHECK (method IN ('off_exact', 'off_tokens', 'off_contained')),
  score            numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  off_product_name text,
  off_brand        text,
  matched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id)
);

GRANT SELECT ON catalog.ean_enrichment TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.ean_enrichment TO prakkie_ingest;

-- Cross-chain substitutie draait vanaf nu uitsluitend op exacte EAN-identiteit
-- (0032-index). De beeld-tier (0016) vervalt: tabel + kalibratierijen weg.
DROP TABLE IF EXISTS catalog.product_image_embeddings;
DELETE FROM catalog.match_policy_calibration WHERE source = 'image';

-- Nieuwe matcher-generatie: 'policy-v2-ean'. Drempels gelden alleen nog voor
-- ánkerloze ingrediënt→product-suggesties (mét anker is het EAN-of-niets);
-- zelfde conservatieve startwaarden als 0031, zonder beeld.
INSERT INTO catalog.match_policy_calibration
  (matcher_version, policy, source, min_score)
VALUES
  ('policy-v2-ean','precise','ean',0.9800), ('policy-v2-ean','precise','correction',0.9800),
  ('policy-v2-ean','precise','lexicon',0.9200), ('policy-v2-ean','precise','trgm',0.8800),
  ('policy-v2-ean','precise','semantic',0.9000),
  ('policy-v2-ean','practical','ean',0.9800), ('policy-v2-ean','practical','correction',0.9500),
  ('policy-v2-ean','practical','lexicon',0.8400), ('policy-v2-ean','practical','trgm',0.7800),
  ('policy-v2-ean','practical','semantic',0.8200),
  ('policy-v2-ean','value','ean',0.9800), ('policy-v2-ean','value','correction',0.9500),
  ('policy-v2-ean','value','lexicon',0.7800), ('policy-v2-ean','value','trgm',0.7000),
  ('policy-v2-ean','value','semantic',0.7600)
ON CONFLICT (matcher_version, policy, source) DO NOTHING;
