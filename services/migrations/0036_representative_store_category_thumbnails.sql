-- Pick representative category thumbnails by product identity first, price last.
-- The old refresh picked the cheapest image, which could make broad panels like
-- "Kaas" show a misleading product such as a cheese bread snack.

UPDATE catalog.store_categories c SET image_url = (
  SELECT p.image_url
  FROM catalog.store_product_categories m
  JOIN catalog.products p ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id
  LEFT JOIN catalog.product_intent i ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
  WHERE m.category_id = c.id
    AND p.available
    AND NULLIF(p.image_url, '') IS NOT NULL
  ORDER BY (COALESCE(i.head_term, '') = ANY(c.head_terms)) DESC,
           EXISTS (
             SELECT 1
             FROM unnest(c.head_terms) AS term
             WHERE to_tsvector('simple', p.name) @@ plainto_tsquery('simple', term)
           ) DESC,
           i.is_base DESC NULLS LAST,
           COALESCE(p.promo_price_cents, p.price_cents),
           p.chain_id,
           p.sku_id
  LIMIT 1
), updated_at = now()
WHERE c.enabled;
