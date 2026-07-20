import { app } from '@azure/functions';
import { HttpError, handler, json, requireAuth } from '../lib/http';
import { query } from '../lib/db';

/**
 * Catalogus-bladeren voor "product toevoegen" (owner 2026-07-08): eerst een
 * categorie kiezen, dán zoeken binnen die categorie — zo raakt "perzik" niet
 * verward met perzikyoghurt. Dit is bewust een domme catalogus-zoeker (trgm +
 * ILIKE binnen één schap), géén matcher: de user bladert en kiest zelf.
 */

/** categorie-thumbnail: het meest voorkomende head_term in het schap is het
 *  archetype ("melk" voor zuivel) — daarvan de productfoto; valt terug op een
 *  willekeurig basisproduct-met-foto als het archetype geen foto heeft. */
const AISLES_SQL = `
WITH top_head AS (
  SELECT DISTINCT ON (i.aisle_group_id) i.aisle_group_id, i.head_term
  FROM catalog.product_intent i
  WHERE i.aisle_group_id IS NOT NULL
  GROUP BY i.aisle_group_id, i.head_term
  ORDER BY i.aisle_group_id, count(*) DESC
)
SELECT a.id, a.slug, a.name_nl, img.image_url
FROM catalog.aisle_taxonomy a
LEFT JOIN top_head th ON th.aisle_group_id = a.id
LEFT JOIN LATERAL (
  SELECT p.image_url
  FROM catalog.product_intent i
  JOIN catalog.products p ON p.chain_id = i.chain_id AND p.sku_id = i.sku_id
  WHERE i.aisle_group_id = a.id AND p.available AND p.image_url IS NOT NULL
  ORDER BY (i.head_term = th.head_term) DESC, i.is_base DESC, p.chain_id, p.sku_id
  LIMIT 1
) img ON true
ORDER BY a.default_sort`;

app.http('catalog-aisles', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/catalog/aisles',
  handler: handler(async (req) => {
    await requireAuth(req);
    const r = await query<{ id: number; slug: string; name_nl: string; image_url: string | null }>(AISLES_SQL);
    return json(200, { aisles: r.rows });
  }),
});

// products.aisle_group_id is (nog) leeg — chain_category_map is nooit gevuld en
// de silver-seed had geen category_path. Het AI-intent-label (0025) is het
// structurele schap-label en wint; products.aisle_group_id alleen als fallback.
// p.promo gaat mee zodat de bladeraar de oranje bonus-flag met de mechanic
// ("2e halve prijs") kan tonen — bonusproducten staan al bovenaan (ORDER BY)
const SEARCH_SQL = `
SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
       p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
       p.image_url, p.promo
FROM catalog.products p
LEFT JOIN catalog.product_intent i ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
WHERE p.chain_id = ANY($1) AND p.available
  AND COALESCE(i.aisle_group_id, p.aisle_group_id) = $2
  AND ($3 = '' OR p.name ILIKE '%' || $3 || '%' OR i.head_term ILIKE '%' || $3 || '%' OR $3 <% p.name)
ORDER BY (p.promo_price_cents IS NOT NULL) DESC,
         COALESCE(p.promo_price_cents, p.price_cents) ASC
LIMIT $4`;

app.http('catalog-search', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/catalog/search',
  handler: handler(async (req) => {
    await requireAuth(req);
    const aisle = Number(req.query.get('aisle'));
    if (!Number.isInteger(aisle)) throw new HttpError(400, 'missing_aisle', 'aisle query parameter is required');
    const q = (req.query.get('q') ?? '').trim();
    const chains = (req.query.get('chains') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const enabled = await query<{ id: string }>(`SELECT id FROM catalog.chains WHERE enabled`);
    const enabledIds = new Set(enabled.rows.map((r) => r.id));
    const target = (chains.length ? chains : [...enabledIds]).filter((c) => enabledIds.has(c));
    if (!target.length) throw new HttpError(400, 'no_chains', 'No enabled chains requested');

    const r = await query(SEARCH_SQL, [target, aisle, q, 60]);
    // CrossChainOption-vorm: chain-veld erbij zodat de app-rijen 1-op-1 passen
    const products = (r.rows as { chain_id: string }[]).map((row) => ({ ...row, chain: row.chain_id }));
    return json(200, { products });
  }),
});
