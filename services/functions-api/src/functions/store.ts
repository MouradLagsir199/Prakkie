import { app } from '@azure/functions';
import { parsePackQuantityQuery } from '@prakkie/shared';
import { HttpError, handler, json, requireAuth } from '../lib/http';
import { query, withTransaction } from '../lib/db';
import {
  buildStorePrefixTsQueries,
  hasMoreStoreProducts,
  parseStorePage,
} from '../lib/store-search-query';

/**
 * Boodschappen-ontdek (plan/12, owner-redesign 2026-07-12): de winkel-registry
 * als API — praktisch, geen 3D/strip meer.
 * - /v1/store/discover        — categorieën mét foto + aanbevolen bonusproducten
 * - /v1/store/department/{id} — subcategorieën van één categorie mét aggregaten
 * - /v1/store/category/{id}/products — subcategorie-inhoud cross-chain
 * Aggregaten komen uit store_category_stats (nachtelijk ververst, zie
 * runStoreStatsRefresh onderaan) — nooit live count(*) over 86k producten.
 * Curatie: scripts/store-categories.curated.csv → seed-store-categories.mjs.
 */

async function resolveChains(param: string | null): Promise<string[]> {
  const requested = (param ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const enabled = await query<{ id: string }>(`SELECT id FROM catalog.chains WHERE enabled`);
  const enabledIds = new Set(enabled.rows.map((r) => r.id));
  const target = (requested.length ? requested : [...enabledIds]).filter((c) => enabledIds.has(c));
  if (!target.length) throw new HttpError(400, 'no_chains', 'No enabled chains requested');
  return target;
}

/** De Boodschappen-home in één call: alle categorieën mét representatieve
 *  productfoto (uit het eerste paneel met beeld), plus "Aanbevolen voor jou" —
 *  basisproducten die nú in de bonus zijn bij de ketens van de user, per
 *  product geaggregeerd tot vanaf-prijs + aantal aanbiedingen. */
app.http('store-discover', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/store/discover',
  handler: handler(async (req) => {
    await requireAuth(req);
    const chains = await resolveChains(req.query.get('chains'));
    const limit = Math.min(Number(req.query.get('limit') ?? 12), 30);

    const cats = await query(
      `SELECT d.id, d.slug, d.name_nl, d.theme, d.sort,
              count(DISTINCT c.id)::int AS panel_count,
              COALESCE(sum(s.product_count), 0)::int AS product_count,
              COALESCE(sum(s.promo_count), 0)::int AS promo_count,
              COALESCE(
                (SELECT c2.image_url FROM catalog.store_categories c2
                 WHERE c2.department_id = d.id AND c2.enabled AND c2.image_url IS NOT NULL
                 ORDER BY (SELECT COALESCE(sum(s2.product_count), 0)
                           FROM catalog.store_category_stats s2
                           WHERE s2.category_id = c2.id AND s2.chain_id = ANY($1)) DESC,
                          c2.sort, c2.id
                 LIMIT 1),
                -- Glutenvrij is een dwarsdoorsnede van meerdere schapgroepen
                -- en heeft daarom bewust geen gewone panelen. Geef de tegel
                -- wel een echte, actuele catalogusfoto in plaats van null.
                (SELECT p.image_url
                 FROM catalog.products p
                 WHERE d.slug = 'glutenvrij'
                   AND p.available
                   AND p.chain_id = ANY($1)
                   AND NULLIF(p.image_url, '') IS NOT NULL
                   AND public.fold_text(p.name)
                       ~ '(^|[^a-z0-9])glutenvrij([^a-z0-9]|$)'
                 ORDER BY (public.fold_text(p.name)
                           ~ '(^|[^a-z0-9])(brood|broodjes)([^a-z0-9]|$)') DESC,
                          (public.fold_text(p.name)
                           ~ '(^|[^a-z0-9])(meel|pasta)([^a-z0-9]|$)') DESC,
                          COALESCE(p.promo_price_cents, p.price_cents),
                          p.chain_id, p.sku_id
                 LIMIT 1)
              ) AS image_url
       FROM catalog.store_departments d
       LEFT JOIN catalog.store_categories c ON c.department_id = d.id AND c.enabled
       LEFT JOIN catalog.store_category_stats s ON s.category_id = c.id AND s.chain_id = ANY($1)
       GROUP BY d.id ORDER BY d.sort`,
      [chains]
    );

    // DISTINCT ON i.p.v. window-DISTINCT (dat kan Postgres niet): eerst alle
    // lopende bonus-aanbiedingen op basisproducten, dan per head_term het
    // aggregaat + de goedkoopste aanbieding als representant (foto verplicht).
    const recs = await query(
      `WITH promo AS (
         SELECT i.head_term, p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
                p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit, p.image_url
         FROM catalog.product_intent i
         JOIN catalog.products p ON p.chain_id = i.chain_id AND p.sku_id = i.sku_id
         WHERE i.is_base AND p.available AND p.chain_id = ANY($1)
           AND p.promo_price_cents IS NOT NULL AND p.promo_price_cents < p.price_cents
           AND (p.promo_valid_to IS NULL OR p.promo_valid_to > now())
           AND p.image_url IS NOT NULL
       ), agg AS (
         SELECT head_term, count(*)::int AS offer_count, count(DISTINCT chain_id)::int AS chain_count,
                min(COALESCE(promo_price_cents, price_cents))::int AS min_price_cents,
                (array_agg(chain_id ORDER BY COALESCE(promo_price_cents, price_cents)))[1] AS min_chain
         FROM promo GROUP BY head_term
       ), best AS (
         -- het "gezicht" van de kaart: liefst een product dat de term ín zijn
         -- naam draagt (herkenbaar), daarbinnen de goedkoopste — de vanaf-prijs
         -- en het keten-logo komen los daarvan uit het aggregaat (min_chain)
         SELECT DISTINCT ON (head_term) *
         FROM promo ORDER BY head_term, (name ILIKE '%' || head_term || '%') DESC,
                             COALESCE(promo_price_cents, price_cents) ASC
       )
       SELECT b.head_term, a.min_chain AS chain, b.chain_id AS rep_chain, b.sku_id, b.name, b.brand,
              b.price_cents, b.promo_price_cents, b.pack_size_value, b.pack_size_unit,
              b.unit_price_cents_per_std, b.std_unit, b.image_url,
              a.offer_count, a.chain_count, a.min_price_cents
       FROM best b JOIN agg a USING (head_term)
       ORDER BY a.chain_count DESC, a.offer_count DESC, a.min_price_cents ASC
       LIMIT $2`,
      [chains, limit]
    );

    const stale = await query<{ refreshed_at: string | null }>(
      `SELECT min(refreshed_at)::text AS refreshed_at FROM catalog.store_category_stats`
    );
    return json(200, {
      categories: cats.rows,
      // No filler products: this lane is empty when the selected stores have
      // no verifiable lower current promo price.
      aanbevolen: recs.rows,
      refreshed_at: stale.rows[0]?.refreshed_at ?? null,
    });
  }),
});

app.http('store-department', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/store/department/{id}',
  handler: handler(async (req) => {
    await requireAuth(req);
    const idParam = req.params.id ?? '';
    const chains = await resolveChains(req.query.get('chains'));
    const byNumeric = /^\d+$/.test(idParam);
    const dept = await query(
      `SELECT id, slug, name_nl, theme, sort FROM catalog.store_departments
       WHERE ${byNumeric ? 'id = $1::smallint' : 'slug = $1'}`,
      [byNumeric ? Number(idParam) : idParam]
    );
    if (!dept.rows[0]) throw new HttpError(404, 'unknown_department', `No department '${idParam}'`);
    const panels = await query(
      `SELECT c.id, c.slug, c.name_nl, c.fixture_type, c.sort, c.image_url,
              COALESCE(sum(s.product_count), 0)::int AS product_count,
              min(s.min_price_cents)::int AS min_price_cents,
              count(s.chain_id) FILTER (WHERE s.product_count > 0)::int AS chain_count,
              COALESCE(sum(s.promo_count), 0)::int AS promo_count
       FROM catalog.store_categories c
       LEFT JOIN catalog.store_category_stats s ON s.category_id = c.id AND s.chain_id = ANY($2)
       WHERE c.department_id = $1 AND c.enabled
       GROUP BY c.id ORDER BY c.sort, c.id`,
      [dept.rows[0].id, chains]
    );
    const stale = await query<{ refreshed_at: string | null }>(
      `SELECT min(refreshed_at)::text AS refreshed_at FROM catalog.store_category_stats`
    );
    return json(200, { department: dept.rows[0], panels: panels.rows, refreshed_at: stale.rows[0]?.refreshed_at ?? null });
  }),
});

/** Bepaal het ene gecureerde winkelschap waarin de gebruiker een handmatig
 * alternatief mag zoeken. Een bestaand bronproduct wint altijd; anders wordt
 * dezelfde veilige, woordgrensbewuste categoriefunctie als de ingest gebruikt. */
app.http('store-resolve-category', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/store/resolve-category',
  handler: handler(async (req) => {
    await requireAuth(req);
    const sourceChain = (req.query.get('source_chain') ?? '').trim().toLowerCase();
    const sourceSku = (req.query.get('source_sku') ?? '').trim();
    const term = (req.query.get('term') ?? '').trim().slice(0, 240);
    const aisleRaw = req.query.get('aisle');
    const aisle = aisleRaw == null || aisleRaw === '' ? null : Number(aisleRaw);
    if (aisle !== null && (!Number.isInteger(aisle) || aisle < 1 || aisle > 32767)) {
      throw new HttpError(400, 'invalid_aisle', 'aisle must be a positive integer');
    }

    let categoryId: number | null = null;
    if (sourceChain && sourceSku) {
      const exact = await query<{ category_id: number }>(
        `SELECT m.category_id
         FROM catalog.store_product_categories m
         JOIN catalog.store_categories c ON c.id = m.category_id AND c.enabled
         WHERE m.chain_id = $1 AND m.sku_id = $2
         LIMIT 1`,
        [sourceChain, sourceSku]
      );
      categoryId = exact.rows[0]?.category_id ?? null;
    }
    if (categoryId === null && term && aisle !== null) {
      const picked = await query<{ category_id: number }>(
        `SELECT category_id FROM catalog.pick_store_category($1, $2::smallint)`,
        [term, aisle]
      );
      categoryId = picked.rows[0]?.category_id ?? null;
    }
    if (categoryId === null) {
      throw new HttpError(404, 'category_not_found', 'Geen veilige productcategorie gevonden');
    }

    const category = await query<{ id: number; slug: string; name_nl: string; department_id: number }>(
      `SELECT id, slug, name_nl, department_id
       FROM catalog.store_categories WHERE id = $1 AND enabled`,
      [categoryId]
    );
    if (!category.rows[0]) throw new HttpError(404, 'category_not_found', 'Productcategorie niet gevonden');
    return json(200, { category: category.rows[0] });
  }),
});

/** Paneel-inhoud, CrossChainOption-vormig (chain + rank) zodat de bestaande
 *  productlijst-component ze 1-op-1 rendert. rank = positie binnen de eigen
 *  keten ná sortering — de client-banden gebruiken dat al zo. */
// kolomnamen zijn ongeprefixt: ze zijn eenduidig in de join én bestaan zo in
// de CTE, dus dezelfde string werkt in de rank-window en de eind-ORDER BY
const PANEL_SORTS: Record<string, string> = {
  aanbevolen: `is_base DESC, (promo_price_cents IS NOT NULL) DESC,
               unit_price_cents_per_std ASC NULLS LAST, COALESCE(promo_price_cents, price_cents) ASC`,
  prijs: `COALESCE(promo_price_cents, price_cents) ASC`,
  eenheidsprijs: `unit_price_cents_per_std ASC NULLS LAST, COALESCE(promo_price_cents, price_cents) ASC`,
  bonus: `(promo_price_cents IS NOT NULL) DESC, COALESCE(promo_price_cents, price_cents) ASC`,
};

/** Exact package-size gate shared by normal catalog search and the manual
 * alternative browser. Values are compared in grams, millilitres or items;
 * `500 g` and `0.5 kg` are therefore identical, while `500 ml` is not. */
function packFilterSql(
  unitParam: string,
  valueParam: string,
  productAlias = 'p'
): string {
  const unit = `lower(COALESCE(${productAlias}.pack_size_unit, ''))`;
  const value = `${productAlias}.pack_size_value`;
  return `AND (${unitParam}::text IS NULL OR (CASE
    WHEN ${unit} IN ('kg', 'kilogram', 'kilo') THEN 'g'
    WHEN ${unit} IN ('g', 'gr', 'gram') THEN 'g'
    WHEN ${unit} IN ('l', 'liter', 'litre', 'ml', 'milliliter', 'cl', 'dl') THEN 'ml'
    WHEN ${unit} IN ('st', 'stuk', 'stuks') THEN 'st'
    ELSE NULL
  END = ${unitParam}::text
  AND abs((CASE
    WHEN ${unit} IN ('kg', 'kilogram', 'kilo', 'l', 'liter', 'litre') THEN ${value} * 1000
    WHEN ${unit} = 'dl' THEN ${value} * 100
    WHEN ${unit} = 'cl' THEN ${value} * 10
    ELSE ${value}
  END) - ${valueParam}::numeric) < 0.001))`;
}

app.http('store-category-products', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/store/category/{id}/products',
  handler: handler(async (req) => {
    await requireAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'invalid_category', 'category id must be numeric');
    const chains = await resolveChains(req.query.get('chains'));
    const rawQuery = (req.query.get('q') ?? '').trim();
    const packQuery = parsePackQuantityQuery(rawQuery);
    const q = packQuery.text;
    const search = buildStorePrefixTsQueries(q);
    const requestedSort = req.query.get('sort') ?? 'aanbevolen';
    const sortKey = Object.hasOwn(PANEL_SORTS, requestedSort) ? requestedSort : 'aanbevolen';
    const sort = PANEL_SORTS[sortKey];
    // Bij Aanbevolen is tekstuele relevantie leidend. Zodra de gebruiker een
    // expliciete sortering kiest, moet die visueel strikt kloppen; relevantie
    // beslist dan alleen nog tussen producten met dezelfde prijs/eenheidsprijs.
    const searchSort = sortKey === 'aanbevolen'
      ? `all_tokens DESC, matched_tokens DESC, relevance DESC, ${sort}`
      : `all_tokens DESC, matched_tokens DESC, ${sort}, relevance DESC`;
    const { limit, offset } = parseStorePage(
      req.query.get('limit'), req.query.get('offset'), { limit: 150, maxLimit: 300 }
    );

    const cat = await query<{ id: number; name_nl: string; department_id: number }>(
      `SELECT id, name_nl, department_id FROM catalog.store_categories WHERE id = $1 AND enabled`, [id]
    );
    if (!cat.rows[0]) throw new HttpError(404, 'unknown_category', `No store category ${id}`);

    if (rawQuery && !search && !packQuery.quantity) {
      return json(200, {
        category: cat.rows[0], products: [], total: 0, offset,
        has_more: false, search_coverage: 'none',
        search_scope: req.query.get('scope') === 'department' ? 'department' : 'category',
      });
    }

    const departmentScope = (!!search || !!packQuery.quantity) && req.query.get('scope') === 'department';

    if (search) {
      // Zoek over losse woordprefixen, niet over één aaneengesloten frase.
      // Eerst wint de hoogste token-dekking (alle woorden indien mogelijk).
      // Als de catalogus geen combinatie kent — bv. "bruin volko" — blijven
      // de beste deelmatches zichtbaar in plaats van een lege lijst.
      const scopeColumn = departmentScope ? 'c.department_id' : 'c.id';
      const scopeId = departmentScope ? cat.rows[0].department_id : id;
      const searched = await query(
        `WITH base AS (
           SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
                  p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
                  p.image_url, p.promo, i.head_term, COALESCE(i.is_base, false) AS is_base,
                  m.assignment_source, c.name_nl AS category_name, c.slug AS category_slug,
                  setweight(to_tsvector('simple', public.fold_text(COALESCE(p.name, ''))), 'A') ||
                  setweight(to_tsvector('simple', public.fold_text(COALESCE(p.brand, ''))), 'B') ||
                  setweight(to_tsvector('simple', public.fold_text(COALESCE(i.head_term, ''))), 'B') ||
                  setweight(to_tsvector('simple', public.fold_text(COALESCE(c.name_nl, ''))), 'C')
                    AS search_document
           FROM catalog.store_categories c
           JOIN catalog.store_product_categories m ON m.category_id = c.id
           JOIN catalog.products p
             ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
           LEFT JOIN catalog.product_intent i
             ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
           WHERE ${scopeColumn} = $1 AND p.chain_id = ANY($2)
             ${packFilterSql('$8', '$9')}
         ), scored AS (
           SELECT base.*,
                  search_document @@ to_tsquery('simple', $4) AS all_tokens,
                  ts_rank_cd(search_document, to_tsquery('simple', $5), 32) AS relevance,
                  (SELECT count(*)::int
                   FROM unnest($3::text[]) AS wanted(token)
                   WHERE search_document @@ to_tsquery('simple', wanted.token || ':*')) AS matched_tokens
           FROM base
           WHERE search_document @@ to_tsquery('simple', $5)
         ), best AS (
           SELECT scored.*, max(matched_tokens) OVER () AS best_matched_tokens
           FROM scored
         ), hits AS (
           SELECT chain_id, sku_id, name, brand, price_cents, promo_price_cents,
                  pack_size_value, pack_size_unit, unit_price_cents_per_std, std_unit,
                  image_url, promo, head_term, is_base, assignment_source,
                  category_name, category_slug, matched_tokens, all_tokens, relevance,
                  (matched_tokens < cardinality($3::text[])) AS partial_match,
                  (row_number() OVER (
                    PARTITION BY chain_id
                    ORDER BY ${searchSort}, sku_id
                  ) - 1)::int AS rank
           FROM best
           WHERE matched_tokens = best_matched_tokens
         )
         SELECT meta.total, page.*
         FROM (SELECT count(*)::int AS total FROM hits) meta
         LEFT JOIN LATERAL (
           SELECT * FROM hits
           ORDER BY ${searchSort}, chain_id, sku_id
           LIMIT $6 OFFSET $7
         ) page ON true`,
        [
          scopeId, chains, search.tokens, search.all, search.any, limit, offset,
          packQuery.quantity?.unit ?? null, packQuery.quantity?.value ?? null,
        ]
      );

      const total = (searched.rows[0] as { total?: number } | undefined)?.total ?? 0;
      const products = (searched.rows as Array<{
        total?: number;
        chain_id?: string | null;
        sku_id?: string | null;
        matched_tokens?: number;
        all_tokens?: boolean;
        relevance?: number;
      }>)
        .filter((row) => !!row.sku_id && !!row.chain_id)
        .map(({ total: _total, all_tokens: _all, relevance: _rank, ...row }) => ({
          ...row,
          chain: row.chain_id,
        }));
      const bestMatched = products[0]?.matched_tokens ?? 0;
      const searchCoverage = total === 0
        ? 'none'
        : bestMatched >= search.tokens.length ? 'exact' : 'partial';

      return json(200, {
        category: cat.rows[0],
        products,
        total,
        offset,
        has_more: hasMoreStoreProducts({ limit, offset }, products.length, total),
        search_coverage: searchCoverage,
        search_scope: departmentScope ? 'department' : 'category',
      });
    }

    const scopeColumn = departmentScope ? 'c.department_id' : 'c.id';
    const scopeId = departmentScope ? cat.rows[0].department_id : id;
    const r = await query(
      `WITH hits AS (
         SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
                p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
                p.image_url, p.promo, i.head_term, COALESCE(i.is_base, false) AS is_base,
                m.assignment_source,
                count(*) OVER ()::int AS total,
                (row_number() OVER (PARTITION BY p.chain_id ORDER BY ${sort}, p.sku_id) - 1)::int AS rank
         FROM catalog.store_categories c
         JOIN catalog.store_product_categories m ON m.category_id = c.id
         JOIN catalog.products p
           ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
         LEFT JOIN catalog.product_intent i
           ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
         WHERE ${scopeColumn} = $1 AND p.chain_id = ANY($2)
           AND ($3 = '' OR p.name ILIKE '%' || $3 || '%'
                OR COALESCE(i.head_term, '') ILIKE '%' || $3 || '%')
           ${packFilterSql('$6', '$7')}
       )
       SELECT * FROM hits ORDER BY ${sort}, chain_id, sku_id LIMIT $4 OFFSET $5`,
      [
        scopeId, chains, q, limit, offset,
        packQuery.quantity?.unit ?? null, packQuery.quantity?.value ?? null,
      ]
    );
    let total = (r.rows[0] as { total?: number } | undefined)?.total ?? 0;
    // Een window-count heeft geen rij wanneer de offset voorbij het einde ligt.
    // Alleen voor dat zeldzame randgeval doen we een losse count, zodat het API-
    // contract niet ineens total=0 rapporteert voor een bestaande categorie.
    if (!r.rows.length && offset > 0) {
      const counted = await query<{ total: number }>(
        `SELECT count(*)::int AS total
         FROM catalog.store_product_categories m
         JOIN catalog.products p
           ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
         LEFT JOIN catalog.product_intent i
           ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
         JOIN catalog.store_categories c ON c.id = m.category_id AND c.enabled
         WHERE ${scopeColumn} = $1 AND p.chain_id = ANY($2)
           AND ($3 = '' OR p.name ILIKE '%' || $3 || '%'
                OR COALESCE(i.head_term, '') ILIKE '%' || $3 || '%')
           ${packFilterSql('$4', '$5')}`,
        [
          scopeId, chains, q,
          packQuery.quantity?.unit ?? null, packQuery.quantity?.value ?? null,
        ]
      );
      total = counted.rows[0]?.total ?? 0;
    }
    const products = (r.rows as ({ chain_id: string; total?: number })[]).map(({ total: _t, ...row }) => ({ ...row, chain: row.chain_id }));
    return json(200, {
      category: cat.rows[0],
      products,
      total,
      offset,
      has_more: hasMoreStoreProducts({ limit, offset }, products.length, total),
      ...(packQuery.quantity
        ? {
            search_coverage: total > 0 ? 'exact' : 'none',
            search_scope: departmentScope ? 'department' : 'category',
          }
        : {}),
    });
  }),
});

/** Vrij zoeken door de hele winkel. Dit is bewust cataloguszoeken — geen
 * ingrediëntmatcher — zodat samengestelde productnamen als sinaasappeljam niet
 * worden teruggebracht tot "sinaasappel" en vervolgens sap opleveren. */
app.http('store-search', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/store/search',
  handler: handler(async (req) => {
    await requireAuth(req);
    const chains = await resolveChains(req.query.get('chains'));
    const rawQuery = (req.query.get('q') ?? '').trim();
    const packQuery = parsePackQuantityQuery(rawQuery);
    const q = packQuery.text;
    const search = buildStorePrefixTsQueries(q);
    const aisleParam = req.query.get('aisle');
    const aisle = aisleParam == null || aisleParam === '' ? null : Number(aisleParam);
    if (aisle !== null && (!Number.isInteger(aisle) || aisle < 1 || aisle > 32767)) {
      throw new HttpError(400, 'invalid_aisle', 'aisle must be a positive integer');
    }
    const { limit, offset } = parseStorePage(
      req.query.get('limit'), req.query.get('offset'), { limit: 60, maxLimit: 300 }
    );
    if ((!q && !packQuery.quantity) || (q && !search)) {
      return json(200, {
        products: [], total: 0, offset, has_more: false, search_coverage: 'none',
      });
    }

    const requestedSort = req.query.get('sort') ?? 'aanbevolen';
    const sortKey = Object.hasOwn(PANEL_SORTS, requestedSort) ? requestedSort : 'aanbevolen';
    const sort = PANEL_SORTS[sortKey];
    const searchSort = sortKey === 'aanbevolen'
      ? `all_tokens DESC, matched_tokens DESC, relevance DESC, ${sort}`
      : `all_tokens DESC, matched_tokens DESC, ${sort}, relevance DESC`;

    if (!search && packQuery.quantity) {
      const exactPack = await query(
        `WITH hits AS (
           SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
                  p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
                  p.image_url, p.promo, i.head_term, COALESCE(i.is_base, false) AS is_base,
                  m.assignment_source, c.name_nl AS category_name, c.slug AS category_slug,
                  d.name_nl AS department_name, d.slug AS department_slug,
                  count(*) OVER ()::int AS total,
                  (row_number() OVER (PARTITION BY p.chain_id ORDER BY ${sort}, p.sku_id) - 1)::int AS rank
           FROM catalog.store_product_categories m
           JOIN catalog.products p
             ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
           JOIN catalog.store_categories c ON c.id = m.category_id AND c.enabled
           JOIN catalog.store_departments d ON d.id = c.department_id
           LEFT JOIN catalog.product_intent i
             ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
           WHERE p.chain_id = ANY($1)
             AND ($2::smallint IS NULL OR i.aisle_group_id = $2)
             ${packFilterSql('$3', '$4')}
         )
         SELECT * FROM hits ORDER BY ${sort}, chain_id, sku_id LIMIT $5 OFFSET $6`,
        [
          chains, aisle, packQuery.quantity.unit, packQuery.quantity.value,
          limit, offset,
        ]
      );
      const total = (exactPack.rows[0] as { total?: number } | undefined)?.total ?? 0;
      const products = (exactPack.rows as Array<{ chain_id: string; total?: number }>)
        .map(({ total: _total, ...row }) => ({ ...row, chain: row.chain_id }));
      return json(200, {
        products,
        total,
        offset,
        has_more: hasMoreStoreProducts({ limit, offset }, products.length, total),
        search_coverage: total > 0 ? 'exact' : 'none',
        search_scope: aisle === null ? 'catalog' : 'category',
      });
    }

    // The quantity-only branch above handled the only case without text.
    if (!search) throw new HttpError(400, 'invalid_search', 'Geen geldige zoekterm');
    const compactQuery = search.tokens.join('');

    const searched = await query(
      `WITH base AS (
         SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
                p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
                p.image_url, p.promo, i.head_term, COALESCE(i.is_base, false) AS is_base,
                m.assignment_source, c.name_nl AS category_name, c.slug AS category_slug,
                d.name_nl AS department_name, d.slug AS department_slug,
                setweight(to_tsvector('simple', public.fold_text(COALESCE(p.name, ''))), 'A') ||
                setweight(to_tsvector('simple', public.fold_text(COALESCE(p.brand, ''))), 'B') ||
                setweight(to_tsvector('simple', public.fold_text(COALESCE(i.head_term, ''))), 'B') ||
                setweight(to_tsvector('simple', public.fold_text(COALESCE(c.name_nl, ''))), 'C') ||
                setweight(to_tsvector('simple', public.fold_text(COALESCE(d.name_nl, ''))), 'D')
                  AS search_document,
                regexp_replace(public.fold_text(COALESCE(p.name, '')), '[^a-z0-9]', '', 'g') AS compact_name,
                regexp_replace(public.fold_text(COALESCE(i.head_term, '')), '[^a-z0-9]', '', 'g') AS compact_head
         FROM catalog.store_product_categories m
         JOIN catalog.products p
           ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
         JOIN catalog.store_categories c ON c.id = m.category_id AND c.enabled
         JOIN catalog.store_departments d ON d.id = c.department_id
         LEFT JOIN catalog.product_intent i
           ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
         WHERE p.chain_id = ANY($1)
           AND ($8::smallint IS NULL OR i.aisle_group_id = $8)
           ${packFilterSql('$9', '$10')}
       ), prefix_hits AS (
       SELECT base.*,
                (
                  search_document @@ to_tsquery('simple', $3)
                  OR compact_name LIKE '%' || $5 || '%'
                  OR compact_head LIKE '%' || $5 || '%'
                ) AS all_tokens,
                ts_rank_cd(search_document, to_tsquery('simple', $4), 32) AS relevance,
                ((SELECT count(*)::int
                 FROM unnest($2::text[]) AS wanted(token)
                 WHERE search_document @@ to_tsquery('simple', wanted.token || ':*'))
                 + CASE
                     WHEN compact_name LIKE '%' || $5 || '%' OR compact_head LIKE '%' || $5 || '%'
                     THEN cardinality($2::text[])
                     ELSE 0
                   END
                )::int AS matched_tokens,
                false AS fuzzy_match
         FROM base
         WHERE search_document @@ to_tsquery('simple', $4)
            OR compact_name LIKE '%' || $5 || '%'
            OR compact_head LIKE '%' || $5 || '%'
       ), fuzzy_hits AS (
         SELECT base.*, false AS all_tokens,
                greatest(similarity(compact_name, $5), similarity(compact_head, $5)) AS relevance,
                0::int AS matched_tokens, true AS fuzzy_match
         FROM base
         WHERE NOT EXISTS (SELECT 1 FROM prefix_hits)
           AND greatest(similarity(compact_name, $5), similarity(compact_head, $5)) >= 0.30
       ), scored AS (
         SELECT * FROM prefix_hits
         UNION ALL
         SELECT * FROM fuzzy_hits
       ), best AS (
         SELECT scored.*, max(matched_tokens) OVER () AS best_matched_tokens
         FROM scored
       ), hits AS (
         SELECT chain_id, sku_id, name, brand, price_cents, promo_price_cents,
                pack_size_value, pack_size_unit, unit_price_cents_per_std, std_unit,
                image_url, promo, head_term, is_base, assignment_source,
                category_name, category_slug, department_name, department_slug,
                matched_tokens, all_tokens, relevance, fuzzy_match,
                (fuzzy_match OR matched_tokens < cardinality($2::text[])) AS partial_match,
                (row_number() OVER (
                  PARTITION BY chain_id ORDER BY ${searchSort}, sku_id
                ) - 1)::int AS rank
         FROM best
         WHERE matched_tokens = best_matched_tokens
       )
       SELECT meta.total, page.*
       FROM (SELECT count(*)::int AS total FROM hits) meta
       LEFT JOIN LATERAL (
         SELECT * FROM hits ORDER BY ${searchSort}, chain_id, sku_id
         LIMIT $6 OFFSET $7
       ) page ON true`,
      [
        chains, search.tokens, search.all, search.any, compactQuery, limit, offset, aisle,
        packQuery.quantity?.unit ?? null, packQuery.quantity?.value ?? null,
      ]
    );

    const total = (searched.rows[0] as { total?: number } | undefined)?.total ?? 0;
    const products = (searched.rows as Array<{
      total?: number;
      chain_id?: string | null;
      sku_id?: string | null;
      matched_tokens?: number;
      all_tokens?: boolean;
      relevance?: number;
      fuzzy_match?: boolean;
    }>)
      .filter((row) => !!row.sku_id && !!row.chain_id)
      .map(({ total: _total, all_tokens: _all, relevance: _rank, fuzzy_match, ...row }) => ({
        ...row,
        fuzzy_match,
        chain: row.chain_id,
      }));
    const best = products[0];
    const coverage = total === 0
      ? 'none'
      : best?.fuzzy_match
        ? 'fuzzy'
        : (best?.matched_tokens ?? 0) >= search.tokens.length ? 'exact' : 'partial';

    return json(200, {
      products,
      total,
      offset,
      has_more: hasMoreStoreProducts({ limit, offset }, products.length, total),
      search_coverage: coverage,
      search_scope: aisle === null ? 'catalog' : 'category',
    });
  }),
});

/** Eén compacte productsnapshot voor lokale, instant search in de app. Dit is
 * bewust geen matcher: de client filtert daarna in-memory over alle actuele
 * producten en prijzen van de gekozen ketens. */
app.http('store-catalog-snapshot', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/store/catalog-snapshot',
  handler: handler(async (req) => {
    await requireAuth(req);
    const chains = await resolveChains(req.query.get('chains'));
    const rows = await query(
      `SELECT DISTINCT ON (p.chain_id, p.sku_id)
              p.chain_id AS chain, p.sku_id, p.name, p.brand,
              p.price_cents::int, p.promo_price_cents::int,
              p.pack_size_value, p.pack_size_unit,
              p.unit_price_cents_per_std::int, p.std_unit,
              p.image_url, p.promo,
              i.head_term, COALESCE(i.is_base, false) AS is_base,
              c.name_nl AS category_name, d.slug AS department_slug
       FROM catalog.store_product_categories m
       JOIN catalog.products p
         ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
       JOIN catalog.store_categories c ON c.id = m.category_id AND c.enabled
       JOIN catalog.store_departments d ON d.id = c.department_id
       LEFT JOIN catalog.product_intent i
         ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
       WHERE p.chain_id = ANY($1)
       ORDER BY p.chain_id, p.sku_id,
                COALESCE(i.is_base, false) DESC,
                c.sort, c.id`,
      [chains]
    );
    const products = rows.rows.map((row) => [
      row.chain,
      row.sku_id,
      row.name,
      row.brand,
      row.price_cents,
      row.promo_price_cents,
      row.pack_size_value,
      row.pack_size_unit,
      row.unit_price_cents_per_std,
      row.std_unit,
      row.image_url,
      row.promo,
      row.head_term,
      row.is_base,
      row.category_name,
      row.department_slug,
    ]);
    return {
      status: 200,
      jsonBody: {
        chains,
        compact: true,
        count: products.length,
        products,
      },
      headers: { 'cache-control': 'private, max-age=900' },
    };
  }),
});

/** Stats + paneel-thumbnails verversen — bron van waarheid voor de kopie in
 *  scripts/seed-store-categories.mjs (die draait hetzelfde direct na een seed). */
export async function runStoreStatsRefresh(): Promise<{ categories: number; stats_rows: number }> {
  return withTransaction(async (client) => {
    // Rebuild the explicit one-product -> one-subcategory registry first. New
    // crawl rows already get a trigger assignment; this also reflects later
    // category curation and repairs anything imported before the trigger.
    await client.query('SELECT catalog.refresh_store_product_categories()');
    await client.query('DELETE FROM catalog.store_category_stats');
    const ins = await client.query(
      `INSERT INTO catalog.store_category_stats (category_id, chain_id, product_count, min_price_cents, promo_count, refreshed_at)
       SELECT m.category_id, p.chain_id, count(*),
              min(COALESCE(p.promo_price_cents, p.price_cents)),
              count(*) FILTER (WHERE p.promo_price_cents IS NOT NULL
                                 AND p.promo_price_cents < p.price_cents
                                 AND (p.promo_valid_to IS NULL OR p.promo_valid_to > now())),
              now()
       FROM catalog.store_product_categories m
       JOIN catalog.products p ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id AND p.available
       JOIN catalog.store_categories c ON c.id = m.category_id AND c.enabled
       GROUP BY m.category_id, p.chain_id`
    );
    const upd = await client.query(
      `UPDATE catalog.store_categories c SET image_url = (
         SELECT p.image_url
         FROM catalog.store_product_categories m
         JOIN catalog.products p ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id
         LEFT JOIN catalog.product_intent i ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
         WHERE m.category_id = c.id
           AND p.available
           AND NULLIF(p.image_url, '') IS NOT NULL
           AND p.image_url !~ '_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}_[0-9a-f-]{36}'
         ORDER BY (COALESCE(i.head_term, '') = ANY(c.head_terms)) DESC,
                  EXISTS (
                    SELECT 1
                    FROM unnest(c.head_terms) AS term
                    WHERE to_tsvector('simple', p.name) @@ plainto_tsquery('simple', term)
                  ) DESC,
                  i.is_base DESC NULLS LAST,
                  COALESCE(p.promo_price_cents, p.price_cents), p.chain_id, p.sku_id
         LIMIT 1), updated_at = now()
       WHERE c.enabled`
    );
    return { categories: upd.rowCount ?? 0, stats_rows: ins.rowCount ?? 0 };
  });
}

// na de nachtelijke ingest/price-precompute (04:15) — schappen vers bij ontbijt
app.timer('store-stats-nightly', {
  schedule: '0 45 4 * * *',
  handler: async (_t, ctx) => {
    const result = await runStoreStatsRefresh();
    ctx.log(`store-stats: ${JSON.stringify(result)}`);
  },
});

app.http('store-stats-run', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'ops/store-stats',
  handler: async () => ({ status: 200, jsonBody: await runStoreStatsRefresh() }),
});
