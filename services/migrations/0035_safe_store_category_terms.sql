-- 0035 — veilige subcategorie-termen: woorden/frasen, geen letterreeksen.
--
-- 0033 maakte compacte substringmatches mogelijk om samengestelde Nederlandse
-- productnamen op te vangen. Dat liet ook toevallige letterreeksen door:
-- "cola" in "chocola(demelk)", "rosé" in "prosecco", "appel" in
-- "aardappel". Een onzekere term hoort in het transparante restschap, nooit in
-- een inhoudelijk verkeerde subcategorie.
--
-- Vanaf nu zijn alleen veilig verifieerbare matches gecureerd:
--   exact    — exact dezelfde gevouwen tekst
--   compact  — exact gelijk na alleen spaties/leestekens verwijderen
--   contains — de volledige term staat als één of meer hele woorden in de kop
-- Alles overige gaat naar het fallbackschap van dezelfde aisle_group.

-- Behoud de bestaande expliciete volkoren-regressie zonder opnieuw een vrije
-- substringregel te openen; dit is een gecureerde catalogusterm.
UPDATE catalog.store_categories
SET head_terms = array_append(head_terms, 'fijn volkorenbrood'), updated_at = now()
WHERE slug = 'volkoren-brood' AND NOT ('fijn volkorenbrood' = ANY(head_terms));

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
           regexp_replace(public.fold_text(term), '[^a-z0-9]', '', 'g') AS term_compact,
           trim(regexp_replace(public.fold_text(COALESCE(p_head, '')), '[^a-z0-9]+', ' ', 'g')) AS head_words,
           trim(regexp_replace(public.fold_text(term), '[^a-z0-9]+', ' ', 'g')) AS term_words
    FROM catalog.store_categories c
    CROSS JOIN LATERAL unnest(c.head_terms || c.keywords) AS term
    WHERE c.enabled AND NOT c.is_fallback AND p_aisle = ANY(c.aisle_group_ids)
  ), scored AS (
    SELECT category_id, sort, term,
      CASE
        WHEN head_fold <> '' AND head_fold = term_fold THEN 'exact'
        WHEN head_compact <> '' AND head_compact = term_compact THEN 'compact'
        WHEN term_words <> ''
         AND strpos(' ' || head_words || ' ', ' ' || term_words || ' ') > 0 THEN 'contains'
        ELSE NULL
      END AS source,
      CASE
        WHEN head_fold <> '' AND head_fold = term_fold THEN 1.0
        WHEN head_compact <> '' AND head_compact = term_compact THEN 0.99
        WHEN term_words <> ''
         AND strpos(' ' || head_words || ' ', ' ' || term_words || ' ') > 0
          THEN 0.90 + least(length(term_compact) / 100.0, 0.08)
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

-- Herclassificeer de volledige catalogus, niet alleen het gemelde voorbeeld.
SELECT catalog.refresh_store_product_categories();

-- Membershipwijzigingen moeten onmiddellijk in aantallen, prijzen en tegels
-- terugkomen; anders blijft de UI tot de nachtjob oude schappen tonen.
DELETE FROM catalog.store_category_stats;
INSERT INTO catalog.store_category_stats
  (category_id, chain_id, product_count, min_price_cents, promo_count, refreshed_at)
SELECT m.category_id, p.chain_id, count(*),
       min(COALESCE(p.promo_price_cents, p.price_cents)),
       count(*) FILTER (WHERE p.promo_price_cents IS NOT NULL
         AND (p.promo_valid_to IS NULL OR p.promo_valid_to > now())),
       now()
FROM catalog.store_product_categories m
JOIN catalog.products p
  ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
JOIN catalog.store_categories c ON c.id = m.category_id AND c.enabled
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
), updated_at = now()
WHERE c.enabled;
