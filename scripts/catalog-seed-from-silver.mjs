// One-time dev seed from the owner's Supermarket_Scrapers silver dump (WS2).
//   node scripts/catalog-seed-from-silver.mjs --dump "../Supermarket_Scrapers/Output/catalog_seed_pg16.sql" [--env dev]
//
// Streams the pg_dump COPY blocks and loads:
//   catalog.silver_products → catalog.products   (87k rows, 6 chains; content_hash
//     prefixed "seed:" so the first real scraper run rewrites every row)
//   catalog.name_canonical  → catalog.name_canonical (79k AI-canonicalised names)
// Rows without a price are skipped (useless for comparison).
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import pg from 'pg';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const dumpPath = resolve(arg('dump', '../Supermarket_Scrapers/Output/catalog_seed_pg16.sql'));
const env = arg('env', 'dev');

const az = (...a) => execFileSync('az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const host = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
const password = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
const client = new pg.Client({ host, database: 'prakkie', user: 'prakkieadmin', password, ssl: { rejectUnauthorized: true } });
await client.connect();

// pg_dump text-format COPY unescape (subset: the escapes pg_dump actually emits)
function unescapeField(f) {
  if (f === '\\N') return null;
  return f.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\' })[c] ?? c);
}

const BATCH = 2000;
let products = [];
let canonicals = [];
let productCount = 0;
let canonicalCount = 0;
let skippedNoPrice = 0;
const seenSku = new Set();

async function flushProducts() {
  if (!products.length) return;
  const cols = products;
  await client.query(
    `INSERT INTO catalog.products (chain_id, sku_id, ean, name, price_cents, unit_price_cents_per_std, std_unit, image_url, available, category_path, content_hash)
     SELECT u.chain_id, u.sku_id, u.ean, u.name, u.price_cents, u.unit_price, u.std_unit, u.image_url, true, '{}', u.content_hash
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::text[], $8::text[], $9::text[])
       AS u(chain_id, sku_id, ean, name, price_cents, unit_price, std_unit, image_url, content_hash)
     ON CONFLICT (chain_id, sku_id) DO UPDATE SET
       ean = EXCLUDED.ean, name = EXCLUDED.name, price_cents = EXCLUDED.price_cents,
       unit_price_cents_per_std = EXCLUDED.unit_price_cents_per_std, std_unit = EXCLUDED.std_unit,
       image_url = EXCLUDED.image_url, content_hash = EXCLUDED.content_hash, updated_at = now(), last_seen_at = now()`,
    [
      cols.map((p) => p.chain), cols.map((p) => p.sku), cols.map((p) => p.ean), cols.map((p) => p.name),
      cols.map((p) => p.priceCents), cols.map((p) => p.unitPrice), cols.map((p) => p.stdUnit),
      cols.map((p) => p.image), cols.map((p) => p.hash),
    ]
  );
  productCount += products.length;
  products = [];
}

async function flushCanonicals() {
  if (!canonicals.length) return;
  const c = canonicals;
  await client.query(
    `INSERT INTO catalog.name_canonical (name_search, canonical_key, display_name, category, is_organic, unit_type, confidence, source, model, tagged_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::numeric[], $8::text[], $9::text[], $10::timestamptz[])
     ON CONFLICT (name_search) DO UPDATE SET canonical_key = EXCLUDED.canonical_key, display_name = EXCLUDED.display_name`,
    [
      c.map((r) => r[0]), c.map((r) => r[1]), c.map((r) => r[2]), c.map((r) => r[3]),
      c.map((r) => r[4] === 't'), c.map((r) => r[5]), c.map((r) => r[6]), c.map((r) => r[7]),
      c.map((r) => r[8]), c.map((r) => r[9]),
    ]
  );
  canonicalCount += canonicals.length;
  canonicals = [];
}

// silver base_price is "price per base unit" (euros) with unit kg/l/piece variants
function stdUnitOf(u) {
  if (!u) return null;
  const t = u.toLowerCase();
  if (t.includes('kg') || t.includes('kilo')) return 'kg';
  if (t === 'l' || t.includes('liter')) return 'l';
  if (t.includes('stuk') || t.includes('piece') || t.includes('st')) return 'stuks';
  return null;
}

let section = null; // 'silver' | 'canonical' | null
const rl = createInterface({ input: createReadStream(dumpPath, 'utf8') });
for await (const line of rl) {
  if (line.startsWith('COPY catalog.silver_products')) { section = 'silver'; continue; }
  if (line.startsWith('COPY catalog.name_canonical')) { section = 'canonical'; continue; }
  if (line === '\\.') { section = null; continue; }
  if (!section) continue;

  const f = line.split('\t').map(unescapeField);
  if (section === 'canonical') {
    if (f.length < 10 || !f[0] || !f[1]) continue; // stray/blank dump lines
    canonicals.push(f);
    if (canonicals.length >= BATCH) await flushCanonicals();
    continue;
  }
  // silver: id, bronze_product_id, store, external_id, name, ean, price, image_url,
  //         first_seen, last_seen, created, updated, base_price, base_price_unit
  const [, , store, externalId, name, ean, price, imageUrl, , , , , basePrice, basePriceUnit] = f;
  if (!store || !externalId || !name || price == null) { skippedNoPrice++; continue; }
  const key = `${store}:${externalId}`;
  if (seenSku.has(key)) continue;
  seenSku.add(key);
  const priceCents = Math.round(parseFloat(price) * 100);
  if (!Number.isFinite(priceCents) || priceCents <= 0) { skippedNoPrice++; continue; }
  const stdUnit = stdUnitOf(basePriceUnit);
  products.push({
    chain: store,
    sku: externalId,
    ean: ean || null,
    name,
    priceCents,
    unitPrice: stdUnit && basePrice != null ? Math.round(parseFloat(basePrice) * 100) : null,
    stdUnit,
    image: imageUrl || null,
    hash: 'seed:' + createHash('sha256').update(`${name}|${ean}|${price}|${imageUrl}`).digest('hex').slice(0, 32),
  });
  if (products.length >= BATCH) await flushProducts();
}
await flushProducts();
await flushCanonicals();

const counts = await client.query(
  `SELECT chain_id, count(*)::int AS n FROM catalog.products GROUP BY chain_id ORDER BY chain_id`
);
console.log(`Seeded ${productCount} products (${skippedNoPrice} skipped w/o price), ${canonicalCount} canonical names.`);
console.table(counts.rows);
await client.end();
