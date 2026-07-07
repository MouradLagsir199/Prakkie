-- 0016 — BEELD-embeddings voor cross-chain productmatching (owner 2026-07-07).
-- Zelfde product, andere winkelnaam ("Duo Penotti" bij AH = "Duopasta" bij
-- Aldi): de FOTO's lijken wél op elkaar. Azure AI Vision multimodal embeddings
-- (Florence, 1024-dim) per productfoto; de matcher gebruikt pgvector-ANN als
-- extra tier NA trgm — additief, nooit boven correcties/hints.
-- Gemeten ijkpunt: Duopasta↔Duo Penotti cosine 0.785; ongerelateerd ~0.57-0.63.
-- (Losse tabel naast catalog.product_embeddings uit 0002 — dat is de nog
-- ongevulde tékst-variant, vector(512).)

CREATE TABLE IF NOT EXISTS catalog.product_image_embeddings (
  chain_id       text NOT NULL,
  sku_id         text NOT NULL,
  embedding      vector(1024) NOT NULL,
  model          text NOT NULL DEFAULT 'azure-florence-2023-04-15',
  image_url_hash text,                 -- md5 van image_url: her-embed alleen bij nieuwe foto
  embedded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id),
  FOREIGN KEY (chain_id, sku_id) REFERENCES catalog.products (chain_id, sku_id) ON DELETE CASCADE
);

-- HNSW: ~86k vectoren, cosine; m/ef defaults volstaan ruim op deze schaal
CREATE INDEX IF NOT EXISTS idx_product_image_embeddings_hnsw
  ON catalog.product_image_embeddings USING hnsw (embedding vector_cosine_ops);

GRANT SELECT ON catalog.product_image_embeddings TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.product_image_embeddings TO prakkie_ingest;
