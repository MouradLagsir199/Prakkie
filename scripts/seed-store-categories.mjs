// Seed van de winkel-panelen (plan/12 fase 0): leest het gecureerde CSV
// (scripts/store-categories.curated.csv, uit generate-store-categories.mjs +
// owner-curatie) en upsert catalog.store_categories op slug. Panelen die uit
// het CSV verdwenen zijn worden verwijderd (stats cascaden mee). Draait daarna
// meteen de stats/thumbnail-refresh zodat de registry zonder deploy live
// bruikbaar en verifieerbaar is.
//
// De refresh-SQL hier is een kopie van runStoreStatsRefresh in
// services/functions-api/src/functions/store.ts — dáár is de bron van waarheid
// (nightly timer); dit script ververst alleen direct na een seed.
//
// Usage: node scripts/seed-store-categories.mjs [--env dev] [--csv scripts/store-categories.curated.csv] [--dry]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const arg = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const env = arg('--env', 'dev');
const csvPath = arg('--csv', 'scripts/store-categories.curated.csv');
const dry = process.argv.includes('--dry');

/** Kleine CSV-parser met quote-support (sample_names bevatten komma's). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((c) => c !== '')) rows.push(row); }
  return rows;
}

const [header, ...dataRows] = parseCsv(readFileSync(csvPath, 'utf8'));
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`kolom '${name}' ontbreekt in ${csvPath}`);
  return i;
};
const panels = dataRows.map((r) => ({
  slug: r[col('panel_slug')].trim(),
  name_nl: r[col('name_nl')].trim(),
  department_slug: r[col('department_slug')].trim(),
  fixture_type: r[col('fixture_type')].trim(),
  sort: Number(r[col('sort')]),
  aisle_group_ids: r[col('aisle_group_ids')].split(';').map((s) => Number(s.trim())).filter(Number.isInteger),
  head_terms: r[col('head_terms')].split(';').map((s) => s.trim()).filter(Boolean),
  keywords: header.includes('keywords')
    ? r[col('keywords')].split(';').map((s) => s.trim()).filter(Boolean)
    : [],
}));
const bad = panels.filter((p) => !p.slug || !p.head_terms.length || !p.aisle_group_ids.length);
if (bad.length) throw new Error(`ongeldige rijen (slug/head_terms/aisles leeg): ${bad.map((b) => b.slug || '?').join(', ')}`);
const dupes = panels.map((p) => p.slug).filter((s, i, a) => a.indexOf(s) !== i);
if (dupes.length) throw new Error(`dubbele panel_slugs in CSV: ${[...new Set(dupes)].join(', ')}`);

console.log(`${panels.length} panelen uit ${csvPath}`);
if (dry) {
  for (const p of panels.slice(0, 10)) console.log(` ${p.department_slug} · ${p.name_nl} (${p.head_terms.join('; ')})`);
  process.exit(0);
}

const az = (...args) => execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const host = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
const password = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
const client = new pg.Client({ host, port: 5432, database: 'prakkie', user: 'prakkieadmin', password, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
await client.connect();

try {
  await client.query('BEGIN');
  const depts = await client.query('SELECT id, slug FROM catalog.store_departments');
  const deptId = new Map(depts.rows.map((d) => [d.slug, d.id]));
  const missing = [...new Set(panels.map((p) => p.department_slug))].filter((s) => !deptId.has(s));
  if (missing.length) throw new Error(`onbekende afdelingen in CSV: ${missing.join(', ')} — eerst migratie 0029 draaien`);

  for (const p of panels) {
    await client.query(
      `INSERT INTO catalog.store_categories (slug, name_nl, department_id, fixture_type, sort, aisle_group_ids, head_terms, keywords, enabled, is_fallback, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, now())
       ON CONFLICT (slug) DO UPDATE SET
         name_nl = EXCLUDED.name_nl, department_id = EXCLUDED.department_id,
         fixture_type = EXCLUDED.fixture_type, sort = EXCLUDED.sort,
         aisle_group_ids = EXCLUDED.aisle_group_ids, head_terms = EXCLUDED.head_terms,
         keywords = EXCLUDED.keywords, enabled = true, is_fallback = false, updated_at = now()`,
      [p.slug, p.name_nl, deptId.get(p.department_slug), p.fixture_type, p.sort, p.aisle_group_ids, p.head_terms, p.keywords]
    );
  }
  const del = await client.query(
    `DELETE FROM catalog.store_categories
     WHERE NOT is_fallback AND NOT (slug = ANY($1)) RETURNING slug`,
    [panels.map((p) => p.slug)]
  );
  if (del.rowCount) console.log(`verwijderd (niet meer in CSV): ${del.rows.map((r) => r.slug).join(', ')}`);

  // Rebuild the sluitende one-product -> one-subcategory registry before its
  // stats. Fallback panels from migration 0033 deliberately survive a reseed.
  await client.query('SELECT catalog.refresh_store_product_categories()');

  // stats + thumbnails — kopie van runStoreStatsRefresh (store.ts)
  await client.query('DELETE FROM catalog.store_category_stats');
  await client.query(
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
  await client.query(
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
       LIMIT 1)
     WHERE c.enabled`
  );
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}

console.log('seed + stats-refresh klaar');
