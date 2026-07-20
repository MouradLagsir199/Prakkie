// Sluitende controle voor de virtuele winkel.
// Faalt zodra één gescrapet product geen enabled subcategorie heeft of de
// category_stats niet exact tot het actuele assortiment optellen.
// Usage: node scripts/audit-store-category-coverage.mjs [--env dev]
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const env = arg('--env', 'dev');
const az = (...args) => execFileSync('az', args, {
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).trim();
const host = az(
  'postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`,
  '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv'
);
const password = az(
  'keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`,
  '--name', 'PG-APP-PASSWORD', '--query', 'value', '-o', 'tsv'
);
const client = new pg.Client({
  host,
  port: 5432,
  database: 'prakkie',
  user: 'prakkie_app',
  password,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15_000,
});

await client.connect();
try {
  const coverage = await client.query(`
    SELECT p.chain_id,
           count(*)::int AS scraped,
           count(*) FILTER (WHERE m.category_id IS NOT NULL AND c.enabled)::int AS categorized,
           count(*) FILTER (WHERE p.available)::int AS available,
           count(*) FILTER (WHERE p.available AND m.category_id IS NOT NULL AND c.enabled)::int AS available_categorized,
           count(*) FILTER (WHERE m.assignment_source = 'missing_intent')::int AS awaiting_intent
    FROM catalog.products p
    LEFT JOIN catalog.store_product_categories m
      ON m.chain_id = p.chain_id AND m.sku_id = p.sku_id
    LEFT JOIN catalog.store_categories c ON c.id = m.category_id
    GROUP BY p.chain_id ORDER BY p.chain_id
  `);
  const statsMismatch = await client.query(`
    WITH expected AS (
      SELECT m.category_id, p.chain_id, count(*)::int AS product_count,
             min(COALESCE(p.promo_price_cents, p.price_cents))::int AS min_price_cents,
             count(*) FILTER (WHERE p.promo_price_cents IS NOT NULL
               AND (p.promo_valid_to IS NULL OR p.promo_valid_to > now()))::int AS promo_count
      FROM catalog.store_product_categories m
      JOIN catalog.products p
        ON p.chain_id = m.chain_id AND p.sku_id = m.sku_id
      WHERE p.available
      GROUP BY m.category_id, p.chain_id
    ), actual AS (
      SELECT category_id, chain_id, product_count, min_price_cents, promo_count
      FROM catalog.store_category_stats
    )
    SELECT COALESCE(e.category_id, a.category_id) AS category_id,
           COALESCE(e.chain_id, a.chain_id) AS chain_id,
           e.product_count AS expected_products, a.product_count AS actual_products,
           e.min_price_cents AS expected_min_price, a.min_price_cents AS actual_min_price,
           e.promo_count AS expected_promos, a.promo_count AS actual_promos
    FROM expected e
    FULL JOIN actual a USING (category_id, chain_id)
    WHERE e.category_id IS NULL OR a.category_id IS NULL
       OR (e.product_count, e.min_price_cents, e.promo_count)
          IS DISTINCT FROM (a.product_count, a.min_price_cents, a.promo_count)
    ORDER BY 2, 1
  `);
  const aisleMismatch = await client.query(`
    SELECT count(*)::int AS mismatches
    FROM catalog.products p
    JOIN catalog.store_product_categories m
      ON m.chain_id = p.chain_id AND m.sku_id = p.sku_id
    JOIN catalog.store_categories c ON c.id = m.category_id
    LEFT JOIN catalog.product_intent i
      ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
    WHERE NOT (COALESCE(i.aisle_group_id, p.aisle_group_id, 20::smallint)
               = ANY(c.aisle_group_ids))
  `);
  const sourceMismatch = await client.query(`
    SELECT count(*)::int AS mismatches
    FROM catalog.products p
    JOIN catalog.store_product_categories m
      ON m.chain_id = p.chain_id AND m.sku_id = p.sku_id
    JOIN catalog.store_categories c ON c.id = m.category_id
    LEFT JOIN catalog.product_intent i
      ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
    WHERE ((m.assignment_source = 'missing_intent') IS DISTINCT FROM (i.sku_id IS NULL))
       OR (c.is_fallback IS DISTINCT FROM
           (m.assignment_source IN ('fallback', 'missing_intent')))
  `);
  // Verifieer iedere gecureerde membership opnieuw tegen zijn categorie-termen.
  // Dit is bewust categoriebreed: een nieuwe "cola"-in-"chocola"-variant mag
  // niet kunnen ontsnappen doordat alleen één bekende SKU getest wordt.
  const unsafeCurated = await client.query(`
    SELECT count(*)::int AS mismatches
    FROM catalog.products p
    JOIN catalog.store_product_categories m
      ON m.chain_id = p.chain_id AND m.sku_id = p.sku_id
    JOIN catalog.store_categories c ON c.id = m.category_id
    LEFT JOIN catalog.product_intent i
      ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
    WHERE NOT c.is_fallback
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(c.head_terms || c.keywords) AS term
        CROSS JOIN LATERAL (
          SELECT public.fold_text(COALESCE(i.head_term, '')) AS head_fold,
                 public.fold_text(term) AS term_fold,
                 regexp_replace(public.fold_text(COALESCE(i.head_term, '')), '[^a-z0-9]', '', 'g') AS head_compact,
                 regexp_replace(public.fold_text(term), '[^a-z0-9]', '', 'g') AS term_compact,
                 trim(regexp_replace(public.fold_text(COALESCE(i.head_term, '')), '[^a-z0-9]+', ' ', 'g')) AS head_words,
                 trim(regexp_replace(public.fold_text(term), '[^a-z0-9]+', ' ', 'g')) AS term_words
        ) folded
        WHERE (m.assignment_source = 'exact' AND folded.head_fold = folded.term_fold)
           OR (m.assignment_source = 'compact' AND folded.head_compact <> ''
               AND folded.head_compact = folded.term_compact)
           OR (m.assignment_source = 'contains' AND folded.term_words <> ''
               AND strpos(' ' || folded.head_words || ' ', ' ' || folded.term_words || ' ') > 0)
      )
  `);
  const deprecatedContainment = await client.query(`
    SELECT count(*)::int AS assignments
    FROM catalog.store_product_categories
    WHERE assignment_source = 'contained_by'
  `);
  const fallbackMismatch = await client.query(`
    SELECT g.aisle_group_id, count(c.id)::int AS fallback_count
    FROM generate_series(1, 20) AS g(aisle_group_id)
    LEFT JOIN catalog.store_categories c
      ON c.enabled AND c.is_fallback
     AND g.aisle_group_id::smallint = ANY(c.aisle_group_ids)
    GROUP BY g.aisle_group_id
    HAVING count(c.id) <> 1
    ORDER BY g.aisle_group_id
  `);
  const sample = await client.query(`
    SELECT p.sku_id, p.name, c.slug AS subcategory, d.slug AS department,
           m.assignment_source
    FROM catalog.products p
    JOIN catalog.store_product_categories m
      ON m.chain_id = p.chain_id AND m.sku_id = p.sku_id
    JOIN catalog.store_categories c ON c.id = m.category_id
    JOIN catalog.store_departments d ON d.id = c.department_id
    LEFT JOIN catalog.product_intent i
      ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
    WHERE p.chain_id = 'jumbo'
      AND p.sku_id = '705295ZK'
  `);
  const falseFriend = await client.query(`
    SELECT c.slug AS subcategory, m.assignment_source
    FROM catalog.products p
    JOIN catalog.store_product_categories m
      ON m.chain_id = p.chain_id AND m.sku_id = p.sku_id
    JOIN catalog.store_categories c ON c.id = m.category_id
    WHERE p.chain_id = 'jumbo' AND p.sku_id = '525212DS'
  `);

  console.table(coverage.rows);
  if (statsMismatch.rowCount) console.table(statsMismatch.rows);
  console.table(sample.rows);
  console.table(falseFriend.rows);

  const missing = coverage.rows.filter((row) =>
    row.scraped !== row.categorized || row.available !== row.available_categorized
  );
  const staleStats = statsMismatch.rowCount ?? 0;
  const wrongAisles = aisleMismatch.rows[0]?.mismatches ?? 0;
  const wrongSources = sourceMismatch.rows[0]?.mismatches ?? 0;
  const wrongFallbacks = fallbackMismatch.rowCount ?? 0;
  const unsafeAssignments = unsafeCurated.rows[0]?.mismatches ?? 0;
  const oldSubstringAssignments = deprecatedContainment.rows[0]?.assignments ?? 0;
  const wrongSample = sample.rows.filter((row) =>
    row.subcategory !== 'volkoren-brood' || row.department !== 'bakkerij'
  );
  const wrongFalseFriend = falseFriend.rows.filter((row) => row.subcategory === 'cola');
  if (!sample.rowCount || missing.length || staleStats || wrongAisles
      || wrongSources || wrongFallbacks || unsafeAssignments
      || oldSubstringAssignments || wrongSample.length
      || !falseFriend.rowCount || wrongFalseFriend.length) {
    throw new Error([
      !sample.rowCount ? 'Jumbo fijn volkoren ontbreekt in de controle' : null,
      missing.length ? `${missing.length} ketens hebben categorisatiegaten` : null,
      staleStats ? `${staleStats} categorie/keten-combinaties hebben onjuiste stats` : null,
      wrongAisles ? `${wrongAisles} producten staan buiten hun schapgroep` : null,
      wrongSources ? `${wrongSources} producten hebben een onjuiste toewijzingsbron` : null,
      wrongFallbacks ? `${wrongFallbacks} schapgroepen hebben niet precies één restcategorie` : null,
      unsafeAssignments ? `${unsafeAssignments} gecureerde memberships slagen niet voor veilige termgrenzen` : null,
      oldSubstringAssignments ? `${oldSubstringAssignments} oude contained_by-memberships zijn nog actief` : null,
      wrongSample.length ? `${wrongSample.length} Jumbo-volkorenproducten staan verkeerd` : null,
      !falseFriend.rowCount ? 'Milky Way Hot Chocolate ontbreekt in de controle' : null,
      wrongFalseFriend.length ? 'Milky Way Hot Chocolate staat nog onder cola' : null,
    ].filter(Boolean).join('; '));
  }
  console.log('PASS: alle subcategorieën zijn gecontroleerd; 100% dekking en geen onveilige substring-memberships.');
} finally {
  await client.end();
}
