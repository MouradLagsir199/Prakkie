-- 0026 — index voor de categorie-bladeraar (catalog.ts): products.aisle_group_id
-- is leeg (chain_category_map nooit gevuld), dus /v1/catalog/search en de
-- categorie-thumbnails in /v1/catalog/aisles filteren op product_intent.
CREATE INDEX IF NOT EXISTS idx_product_intent_aisle ON catalog.product_intent (aisle_group_id);
