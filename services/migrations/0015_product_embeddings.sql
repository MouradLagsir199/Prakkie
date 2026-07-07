-- 0015 — expliciete grants op catalog.product_embeddings (de tekst-embedding-
-- tabel uit 0002, vector(512), nog ongevuld). NB: deze migratie wilde
-- oorspronkelijk een beeld-embedding-tabel maken, maar die naam bestond al —
-- de échte beeld-tabel (Florence 1024-dim) is 0016_product_image_embeddings.

GRANT SELECT ON catalog.product_embeddings TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.product_embeddings TO prakkie_ingest;
