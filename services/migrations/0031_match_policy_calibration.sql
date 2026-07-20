-- 0031 — policy-aware cross-chain matching.
-- Thresholds are versioned data, not magic UI constants. measured_precision is
-- deliberately NULL until a representative labelled evaluation has run; the
-- conservative seed values control risk without pretending to be probabilities.

ALTER TABLE catalog.product_embeddings ADD COLUMN IF NOT EXISTS input_hash text;

CREATE TABLE IF NOT EXISTS catalog.match_policy_calibration (
  matcher_version    text NOT NULL,
  policy             text NOT NULL CHECK (policy IN ('precise', 'practical', 'value')),
  source             text NOT NULL CHECK (source IN ('ean', 'correction', 'lexicon', 'trgm', 'semantic', 'image')),
  min_score          numeric(5,4) NOT NULL CHECK (min_score BETWEEN 0 AND 1),
  measured_precision numeric(5,4) CHECK (measured_precision BETWEEN 0 AND 1),
  sample_size        integer NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  enabled            boolean NOT NULL DEFAULT true,
  calibrated_at      timestamptz,
  PRIMARY KEY (matcher_version, policy, source)
);

INSERT INTO catalog.match_policy_calibration
  (matcher_version, policy, source, min_score)
VALUES
  ('policy-v1','precise','ean',0.9800), ('policy-v1','precise','correction',0.9800),
  ('policy-v1','precise','lexicon',0.9200), ('policy-v1','precise','trgm',0.8800),
  ('policy-v1','precise','semantic',0.9000), ('policy-v1','precise','image',0.9200),
  ('policy-v1','practical','ean',0.9800), ('policy-v1','practical','correction',0.9500),
  ('policy-v1','practical','lexicon',0.8400), ('policy-v1','practical','trgm',0.7800),
  ('policy-v1','practical','semantic',0.8200), ('policy-v1','practical','image',0.8400),
  ('policy-v1','value','ean',0.9800), ('policy-v1','value','correction',0.9500),
  ('policy-v1','value','lexicon',0.7800), ('policy-v1','value','trgm',0.7000),
  ('policy-v1','value','semantic',0.7600), ('policy-v1','value','image',0.8000)
ON CONFLICT (matcher_version, policy, source) DO NOTHING;

-- Auditable acceptance/correction events supply future calibration labels.
CREATE TABLE IF NOT EXISTS app.match_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  list_id         uuid REFERENCES app.lists(id) ON DELETE SET NULL,
  item_id         uuid REFERENCES app.list_items(id) ON DELETE SET NULL,
  chain_id        text NOT NULL REFERENCES catalog.chains(id),
  anchor_chain_id text REFERENCES catalog.chains(id),
  anchor_sku_id   text,
  candidate_sku_id text NOT NULL,
  policy          text NOT NULL CHECK (policy IN ('precise', 'practical', 'value')),
  action          text NOT NULL CHECK (action IN ('bulk_accepted', 'user_confirmed', 'rejected')),
  reliability     numeric(5,4) CHECK (reliability BETWEEN 0 AND 1),
  reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  matcher_version text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_match_events_calibration
  ON app.match_events (matcher_version, policy, chain_id, action, created_at);

GRANT SELECT ON catalog.match_policy_calibration TO prakkie_app;
GRANT SELECT, INSERT ON app.match_events TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.match_policy_calibration TO prakkie_ingest;
GRANT SELECT ON app.match_events TO prakkie_ingest;
