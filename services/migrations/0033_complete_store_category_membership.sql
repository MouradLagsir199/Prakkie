-- 0033 — sluitende winkelcategorisatie.
--
-- De oorspronkelijke virtuele winkel koppelde producten alleen wanneer het
-- AI-label exact gelijk was aan een gecureerde head_term. Daardoor verdween
-- ruim 60% van het actuele assortiment uit de bladeraar; bijvoorbeeld
-- "fijn volkorenbrood" matchte niet met "volkoren brood".
--
-- Iedere catalogusregel krijgt vanaf nu exact één expliciete subcategorie:
--   exact/compact/veilige containment -> gecureerd paneel
--   geen veilige match               -> restpaneel van dezelfde schapgroep
--   nog geen product_intent           -> Overige producten
-- Triggers houden nieuwe crawlproducten en nieuwe intent-labels direct bij.

ALTER TABLE catalog.store_categories
  ADD COLUMN IF NOT EXISTS is_fallback boolean NOT NULL DEFAULT false;

WITH fallbacks(slug, name_nl, department_slug, fixture_type, sort, aisle_group_id) AS (
  VALUES
    ('overig-groente-fruit',       'Overige groente & fruit',       'groente-aardappelen',   'produce',  901,  1),
    ('overige-zuivel-eieren',      'Overige zuivel & eieren',       'zuivel-eieren',         'fridge',   902,  2),
    ('overig-vlees-vis',           'Overig vlees & vis',            'vlees',                 'fridge',   903,  3),
    ('overig-vega-plantaardig',    'Overig vega & plantaardig',     'vega',                  'fridge',   904,  4),
    ('overige-kaas-vleeswaren',    'Overige kaas & vleeswaren',     'vleeswaren',            'fridge',   905,  5),
    ('overig-brood-banket',        'Overig brood & banket',         'bakkerij',              'bakery',   906,  6),
    ('overig-ontbijt-beleg',       'Overig ontbijt & beleg',        'ontbijt-beleg',         'shelf',    907,  7),
    ('overig-pasta-rijst-wereld',  'Overige pasta, rijst & wereld', 'pasta-rijst-wereld',    'shelf',    908,  8),
    ('overig-conserven-soepen',    'Overige conserven & soepen',    'soepen-sauzen-kruiden', 'shelf',    909,  9),
    ('overig-kruiden-sauzen-olie', 'Overige kruiden, sauzen & olie','soepen-sauzen-kruiden', 'shelf',    910, 10),
    ('overige-bakproducten',       'Overige bakproducten',          'koek-snoep-chocolade',  'shelf',    911, 11),
    ('overig-snoep-koek',          'Overig snoep & koek',           'koek-snoep-chocolade',  'shelf',    912, 12),
    ('overig-chips-noten',         'Overige chips & noten',         'borrel-chips-snacks',   'shelf',    913, 13),
    ('overig-diepvries',           'Overige diepvriesproducten',    'diepvries',             'freezer',  914, 14),
    ('overige-dranken-sappen',     'Overige dranken & sappen',      'frisdrank-water',       'shelf',    915, 15),
    ('overig-koffie-thee',         'Overige koffie & thee',         'koffie-thee',           'shelf',    916, 16),
    ('overig-bier-wijn',           'Overig bier & wijn',            'bier-wijn',             'shelf',    917, 17),
    ('overige-drogisterij',        'Overige drogisterij',           'drogisterij',           'shelf',    918, 18),
    ('overig-huishouden',          'Overig huishouden',             'huishouden',            'shelf',    919, 19),
    ('overige-producten',          'Overige producten',             'huishouden',            'shelf',    920, 20)
)
INSERT INTO catalog.store_categories
  (slug, name_nl, department_id, fixture_type, sort, aisle_group_ids,
   head_terms, keywords, enabled, is_fallback, updated_at)
SELECT f.slug, f.name_nl, d.id, f.fixture_type, f.sort,
       ARRAY[f.aisle_group_id]::smallint[],
       ARRAY['__fallback_' || f.aisle_group_id::text], ARRAY[]::text[],
       true, true, now()
FROM fallbacks f
JOIN catalog.store_departments d ON d.slug = f.department_slug
ON CONFLICT (slug) DO UPDATE SET
  name_nl = EXCLUDED.name_nl,
  department_id = EXCLUDED.department_id,
  fixture_type = EXCLUDED.fixture_type,
  sort = EXCLUDED.sort,
  aisle_group_ids = EXCLUDED.aisle_group_ids,
  head_terms = EXCLUDED.head_terms,
  keywords = EXCLUDED.keywords,
  enabled = true,
  is_fallback = true,
  updated_at = now();

CREATE TABLE IF NOT EXISTS catalog.store_product_categories (
  chain_id          text NOT NULL,
  sku_id            text NOT NULL,
  category_id       integer NOT NULL REFERENCES catalog.store_categories(id) ON DELETE CASCADE,
  assignment_source text NOT NULL CHECK (assignment_source IN
    ('exact', 'compact', 'contains', 'contained_by', 'fallback', 'missing_intent')),
  assignment_score  real NOT NULL DEFAULT 0,
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, sku_id),
  FOREIGN KEY (chain_id, sku_id) REFERENCES catalog.products(chain_id, sku_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_store_product_categories_category
  ON catalog.store_product_categories(category_id, chain_id);
CREATE INDEX IF NOT EXISTS idx_product_intent_store_lookup
  ON catalog.product_intent(aisle_group_id, head_term, chain_id, sku_id);

-- Pick één veilige categorie voor een intent. Korte substrings (zoals "ui"
-- in "fruit") tellen bewust niet; onzekere fuzzy gelijkenis gaat naar het
-- transparante restpaneel in plaats van een verkeerde productgroep.
CREATE OR REPLACE FUNCTION catalog.pick_store_category(p_head text, p_aisle smallint)
RETURNS TABLE(category_id integer, assignment_source text, assignment_score real)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, catalog
AS $$
  WITH prepared AS (
    SELECT c.id AS category_id, c.sort, term,
           public.fold_text(COALESCE(p_head, '')) AS head_fold,
           public.fold_text(term) AS term_fold,
           regexp_replace(public.fold_text(COALESCE(p_head, '')), '[^a-z0-9]', '', 'g') AS head_compact,
           regexp_replace(public.fold_text(term), '[^a-z0-9]', '', 'g') AS term_compact
    FROM catalog.store_categories c
    CROSS JOIN LATERAL unnest(c.head_terms || c.keywords) AS term
    WHERE c.enabled AND NOT c.is_fallback AND p_aisle = ANY(c.aisle_group_ids)
  ), scored AS (
    SELECT category_id, sort, term,
      CASE
        WHEN head_fold <> '' AND head_fold = term_fold THEN 'exact'
        WHEN head_compact <> '' AND head_compact = term_compact THEN 'compact'
        WHEN length(term_compact) >= 4 AND head_compact LIKE '%' || term_compact || '%' THEN 'contains'
        WHEN length(head_compact) >= 6
         AND length(head_compact)::numeric / NULLIF(length(term_compact), 0) >= 0.65
         AND term_compact LIKE '%' || head_compact || '%' THEN 'contained_by'
        ELSE NULL
      END AS source,
      CASE
        WHEN head_fold <> '' AND head_fold = term_fold THEN 1.0
        WHEN head_compact <> '' AND head_compact = term_compact THEN 0.99
        WHEN length(term_compact) >= 4 AND head_compact LIKE '%' || term_compact || '%'
          THEN 0.86 + least(length(term_compact) / 100.0, 0.09)
        WHEN length(head_compact) >= 6
         AND length(head_compact)::numeric / NULLIF(length(term_compact), 0) >= 0.65
         AND term_compact LIKE '%' || head_compact || '%'
          THEN 0.84 + least(length(head_compact) / 100.0, 0.08)
        ELSE 0
      END::real AS score
    FROM prepared
  ), candidates AS (
    SELECT category_id, source AS assignment_source, score AS assignment_score,
           0 AS fallback_rank, length(term) AS specificity, sort
    FROM scored WHERE source IS NOT NULL
    UNION ALL
    SELECT c.id, 'fallback', 0::real, 1, 0, c.sort
    FROM catalog.store_categories c
    WHERE c.enabled AND c.is_fallback AND p_aisle = ANY(c.aisle_group_ids)
  )
  SELECT category_id, assignment_source, assignment_score
  FROM candidates
  ORDER BY fallback_rank, assignment_score DESC, specificity DESC, sort, category_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION catalog.assign_store_product_category(p_chain_id text, p_sku_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, catalog
AS $$
BEGIN
  INSERT INTO catalog.store_product_categories
    (chain_id, sku_id, category_id, assignment_source, assignment_score, assigned_at)
  SELECT p.chain_id, p.sku_id, picked.category_id,
         CASE WHEN i.sku_id IS NULL THEN 'missing_intent' ELSE picked.assignment_source END,
         CASE WHEN i.sku_id IS NULL THEN 0 ELSE picked.assignment_score END,
         now()
  FROM catalog.products p
  LEFT JOIN catalog.product_intent i ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
  CROSS JOIN LATERAL catalog.pick_store_category(
    i.head_term,
    COALESCE(i.aisle_group_id, p.aisle_group_id, 20::smallint)
  ) picked
  WHERE p.chain_id = p_chain_id AND p.sku_id = p_sku_id
  ON CONFLICT (chain_id, sku_id) DO UPDATE SET
    category_id = EXCLUDED.category_id,
    assignment_source = EXCLUDED.assignment_source,
    assignment_score = EXCLUDED.assignment_score,
    assigned_at = now();
END
$$;

CREATE OR REPLACE FUNCTION catalog.refresh_store_product_categories()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, catalog
AS $$
DECLARE affected integer;
BEGIN
  WITH product_keys AS (
    SELECT p.chain_id, p.sku_id, i.head_term,
           COALESCE(i.aisle_group_id, p.aisle_group_id, 20::smallint) AS aisle_group_id,
           (i.sku_id IS NULL) AS missing_intent
    FROM catalog.products p
    LEFT JOIN catalog.product_intent i ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
  ), distinct_intents AS (
    SELECT DISTINCT head_term, aisle_group_id FROM product_keys
  ), assignments AS (
    SELECT d.head_term, d.aisle_group_id, picked.category_id,
           picked.assignment_source, picked.assignment_score
    FROM distinct_intents d
    CROSS JOIN LATERAL catalog.pick_store_category(d.head_term, d.aisle_group_id) picked
  )
  INSERT INTO catalog.store_product_categories AS current
    (chain_id, sku_id, category_id, assignment_source, assignment_score, assigned_at)
  SELECT p.chain_id, p.sku_id, a.category_id,
         CASE WHEN p.missing_intent THEN 'missing_intent' ELSE a.assignment_source END,
         CASE WHEN p.missing_intent THEN 0 ELSE a.assignment_score END,
         now()
  FROM product_keys p
  JOIN assignments a
    ON a.aisle_group_id = p.aisle_group_id
   AND a.head_term IS NOT DISTINCT FROM p.head_term
  ON CONFLICT (chain_id, sku_id) DO UPDATE SET
    category_id = EXCLUDED.category_id,
    assignment_source = EXCLUDED.assignment_source,
    assignment_score = EXCLUDED.assignment_score,
    assigned_at = now()
  WHERE (current.category_id, current.assignment_source, current.assignment_score)
        IS DISTINCT FROM
        (EXCLUDED.category_id, EXCLUDED.assignment_source, EXCLUDED.assignment_score);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

CREATE OR REPLACE FUNCTION catalog.store_product_category_from_product_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, catalog
AS $$
BEGIN
  PERFORM catalog.assign_store_product_category(NEW.chain_id, NEW.sku_id);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION catalog.store_product_category_from_intent_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM catalog.assign_store_product_category(OLD.chain_id, OLD.sku_id);
    RETURN OLD;
  END IF;
  PERFORM catalog.assign_store_product_category(NEW.chain_id, NEW.sku_id);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_store_category_product_insert ON catalog.products;
CREATE TRIGGER trg_store_category_product_insert
AFTER INSERT ON catalog.products
FOR EACH ROW EXECUTE FUNCTION catalog.store_product_category_from_product_trigger();

DROP TRIGGER IF EXISTS trg_store_category_product_aisle ON catalog.products;
CREATE TRIGGER trg_store_category_product_aisle
AFTER UPDATE OF aisle_group_id ON catalog.products
FOR EACH ROW
WHEN (OLD.aisle_group_id IS DISTINCT FROM NEW.aisle_group_id)
EXECUTE FUNCTION catalog.store_product_category_from_product_trigger();

DROP TRIGGER IF EXISTS trg_store_category_intent ON catalog.product_intent;
CREATE TRIGGER trg_store_category_intent
AFTER INSERT OR UPDATE OF head_term, aisle_group_id ON catalog.product_intent
FOR EACH ROW EXECUTE FUNCTION catalog.store_product_category_from_intent_trigger();

DROP TRIGGER IF EXISTS trg_store_category_intent_delete ON catalog.product_intent;
CREATE TRIGGER trg_store_category_intent_delete
AFTER DELETE ON catalog.product_intent
FOR EACH ROW EXECUTE FUNCTION catalog.store_product_category_from_intent_trigger();

SELECT catalog.refresh_store_product_categories();

-- Registry is immediately consistent after the migration; the nightly job
-- repeats this same projection for newly curated panels.
DELETE FROM catalog.store_category_stats;
INSERT INTO catalog.store_category_stats
  (category_id, chain_id, product_count, min_price_cents, promo_count, refreshed_at)
SELECT m.category_id, p.chain_id, count(*),
       min(COALESCE(p.promo_price_cents, p.price_cents)),
       count(*) FILTER (WHERE p.promo_price_cents IS NOT NULL
         AND (p.promo_valid_to IS NULL OR p.promo_valid_to > now())),
       now()
FROM catalog.store_product_categories m
JOIN catalog.products p ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
GROUP BY m.category_id, p.chain_id;

UPDATE catalog.store_categories c SET image_url = (
  SELECT p.image_url
  FROM catalog.store_product_categories m
  JOIN catalog.products p ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id
  LEFT JOIN catalog.product_intent i ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
  WHERE m.category_id = c.id AND p.available AND p.image_url IS NOT NULL
  ORDER BY i.is_base DESC NULLS LAST,
           COALESCE(p.promo_price_cents, p.price_cents), p.chain_id, p.sku_id
  LIMIT 1
)
WHERE c.enabled;

GRANT SELECT ON catalog.store_product_categories TO prakkie_app, prakkie_ingest;
REVOKE ALL ON FUNCTION catalog.assign_store_product_category(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.refresh_store_product_categories() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.store_product_category_from_product_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION catalog.store_product_category_from_intent_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.pick_store_category(text, smallint) TO prakkie_app, prakkie_ingest;
GRANT EXECUTE ON FUNCTION catalog.assign_store_product_category(text, text) TO prakkie_app, prakkie_ingest;
GRANT EXECUTE ON FUNCTION catalog.refresh_store_product_categories() TO prakkie_app, prakkie_ingest;
