-- 0025 — AI-productintent (owner 2026-07-08): het structurele label dat alle
-- matching-gekkigheid moet beëindigen (kaastengel-als-roomboter, blik-sperzie-
-- bonen bovenaan, stokbrood→toast-substituties). Per product, door een LLM
-- gelabeld (scripts/label-product-intent.mjs, hervatbaar via name_hash):
--   head_term  — de kale NL kern ("volle melk", "sperziebonen", "croissant")
--   form       — vers | blik | pot | diepvries | gedroogd | houdbaar | bewerkt | non-food
--   is_base    — basisingrediënt (in recepten) vs samengesteld/kant-en-klaar
--   aisle_group_id — de 20-groepen-taxonomie (was 0% gevuld op products)
-- De matcher gebruikt head_term voor is_primary en anker-substituties; form
-- demoteert conserven bij vers-zoekopdrachten.

CREATE TABLE IF NOT EXISTS catalog.product_intent (
  chain_id       text NOT NULL,
  sku_id         text NOT NULL,
  head_term      text NOT NULL,
  form           text NOT NULL DEFAULT 'vers'
                 CHECK (form IN ('vers', 'blik', 'pot', 'diepvries', 'gedroogd', 'houdbaar', 'bewerkt', 'non-food')),
  is_base        boolean NOT NULL DEFAULT true,
  aisle_group_id smallint REFERENCES catalog.aisle_taxonomy(id),
  name_hash      text NOT NULL,
  model          text NOT NULL,
  labeled_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id)
);
CREATE INDEX IF NOT EXISTS idx_product_intent_head ON catalog.product_intent (head_term);

GRANT SELECT ON catalog.product_intent TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.product_intent TO prakkie_ingest;
