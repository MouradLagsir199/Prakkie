-- EAN-13 and GTIN-14 may identify the same trade item with a leading zero.
-- Keep the exact cross-chain tier indexed on that normalised representation.
CREATE INDEX IF NOT EXISTS idx_products_ean_normalised
  ON catalog.products (chain_id, NULLIF(ltrim(ean, '0'), '')) WHERE ean IS NOT NULL;
