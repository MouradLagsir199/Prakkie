// Facet-backfill (matching v2, docs/09 Fase 1). Leest catalogusproducten +
// hun schap-signalen (product_intent.form), extraheert facetten via de LLM
// (facet-extract.mjs), verifieert ze (facets.mjs) en schrijft catalog.product_facets.
//
// Hervatbaar via name_hash: een ongewijzigd product wordt overgeslagen.
// Env: PG_* (zie run.mjs), OPENAI_API_KEY of KEY_VAULT_NAME, FACET_LIMIT,
// FACET_CHAINS, FACET_NAME_LIKE, FACET_CONCURRENCY, DRY_RUN=1.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { extractFacets, resolveApiKey } from './facet-extract.mjs';
import { verifyFacets, FACET_MATCHER_VERSION } from './facets.mjs';

const env = (name, fallback = undefined) => process.env[name] ?? fallback;
const MODEL = env('FACET_MODEL', 'gpt-4o-mini');

/** Stabiele hash van de matching-relevante velden — hervat-sleutel. */
export function nameHash(p) {
  return createHash('sha1')
    .update(`${p.name ?? ''}|${p.brand ?? ''}|${p.pack_size_value ?? ''}|${p.pack_size_unit ?? ''}`)
    .digest('hex');
}

/** product + verifyFacets-resultaat → DB-rij. */
export function toRow(p, verified) {
  const f = verified.facets;
  return {
    chain_id: p.chain_id, sku_id: p.sku_id,
    category: f.category ?? null,
    brand_tier: f.brand_tier ?? null,
    variant: f.variant ?? null,
    flavor: f.flavor ?? null,
    form: f.form ?? null,
    dietary: f.dietary ?? [],
    type: f.type ?? null,
    pack_value: f.pack?.value ?? null,
    pack_unit: f.pack?.unit ?? null,
    confidence: verified.confidence,
    verified: verified.verified,
    disagreements: verified.disagreements ?? [],
    matcher_version: FACET_MATCHER_VERSION,
    name_hash: nameHash(p),
    model: MODEL,
  };
}

/** Bounded-concurrency map — houdt de OpenAI-aanroepen in toom. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function pgPassword() {
  const direct = env('PG_PASSWORD');
  if (direct) return direct;
  const vault = env('KEY_VAULT_NAME');
  if (!vault) throw new Error('PG_PASSWORD of KEY_VAULT_NAME is vereist');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const { SecretClient } = await import('@azure/keyvault-secrets');
  const client = new SecretClient(`https://${vault}.vault.azure.net`, new DefaultAzureCredential());
  return (await client.getSecret(env('PG_SECRET_NAME', 'PG-INGEST-PASSWORD'))).value;
}

async function main() {
  const dryRun = env('DRY_RUN', '') === '1';
  const limit = Number(env('FACET_LIMIT', '200'));
  const concurrency = Number(env('FACET_CONCURRENCY', '5'));
  const chains = env('FACET_CHAINS', '')?.split(',').map((c) => c.trim()).filter(Boolean);
  const nameLike = env('FACET_NAME_LIKE', '');
  const apiKey = await resolveApiKey();

  const pool = new pg.Pool({
    host: env('PG_HOST'),
    database: env('PG_DATABASE', 'prakkie'),
    user: env('PG_USER', 'prakkie_ingest'),
    password: await pgPassword(),
    port: Number(env('PG_PORT', '5432')),
    ssl: env('PG_SSL', 'require') === 'disable' ? undefined : { rejectUnauthorized: false },
    max: 4,
  });
  try {
    // Kandidaten: producten zonder facetrij voor de huidige matcher-versie
    // (hervatbaar — bumpt de versie, dan draait alles opnieuw). LEFT JOIN
    // product_intent levert het schap-form-signaal.
    const params = [FACET_MATCHER_VERSION];
    const conds = ['(pf.chain_id IS NULL OR pf.matcher_version <> $1)'];
    if (chains?.length) { params.push(chains); conds.push(`p.chain_id = ANY($${params.length})`); }
    if (nameLike) { params.push(`%${nameLike}%`); conds.push(`p.name ILIKE $${params.length}`); }
    params.push(limit);
    const sql = `
      SELECT p.chain_id, p.sku_id, p.name, p.brand, p.pack_size_value, p.pack_size_unit,
             p.category_path, p.ean, pi.form AS intent_form
      FROM catalog.products p
      LEFT JOIN catalog.product_intent pi ON pi.chain_id = p.chain_id AND pi.sku_id = p.sku_id
      LEFT JOIN catalog.product_facets pf ON pf.chain_id = p.chain_id AND pf.sku_id = p.sku_id
      WHERE ${conds.join(' AND ')}
      ORDER BY p.chain_id, p.sku_id
      LIMIT $${params.length}`;
    const targets = (await pool.query(sql, params)).rows;
    console.log(`Kandidaten: ${targets.length} (limit ${limit}${chains?.length ? `, ketens ${chains.join(',')}` : ''})`);

    let done = 0;
    const rows = (await mapPool(targets, concurrency, async (p) => {
      const raw = {
        name: p.name, brand: p.brand,
        pack_size_value: p.pack_size_value, pack_size_unit: p.pack_size_unit,
        category_path: p.category_path ?? [], intent_form: p.intent_form ?? null,
      };
      try {
        const facets = await extractFacets(raw, { apiKey });
        const row = toRow(p, verifyFacets(facets, raw));
        process.stdout.write(`  ${++done}/${targets.length}\r`);
        return row;
      } catch (err) {
        console.warn(`\n  overslaan ${p.chain_id}/${p.sku_id}: ${err.message}`);
        return null;
      }
    })).filter(Boolean);
    process.stdout.write('\n');

    const verifiedCount = rows.filter((r) => r.verified).length;
    console.log(`Geëxtraheerd: ${rows.length}  ·  geverifieerd: ${verifiedCount}  ·  uitgesloten: ${rows.length - verifiedCount}`);

    if (dryRun) {
      console.log('DRY_RUN=1 — niets weggeschreven. Voorbeeld:', JSON.stringify(rows.slice(0, 5), null, 2));
      return;
    }

    const cols = [
      'chain_id', 'sku_id', 'category', 'brand_tier', 'variant', 'flavor', 'form', 'dietary', 'type',
      'pack_value', 'pack_unit', 'confidence', 'verified', 'disagreements', 'matcher_version', 'name_hash', 'model',
    ];
    const updateSet = cols
      .filter((c) => c !== 'chain_id' && c !== 'sku_id')
      .map((c) => `${c}=EXCLUDED.${c}`)
      .concat('labeled_at=now()')
      .join(', ');
    // Rij-per-rij VALUES i.p.v. unnest: node-pg codeert een JS-array netjes als
    // Postgres text[] (dietary/disagreements), wat unnest van een 2D-array niet kan.
    for (let i = 0; i < rows.length; i += 250) {
      const b = rows.slice(i, i + 250);
      const values = [];
      const tuples = b.map((r) => {
        const base = values.length;
        values.push(
          r.chain_id, r.sku_id, r.category, r.brand_tier, r.variant, r.flavor, r.form, r.dietary, r.type,
          r.pack_value, r.pack_unit, r.confidence, r.verified, r.disagreements, r.matcher_version, r.name_hash, r.model
        );
        return `(${cols.map((_, ci) => `$${base + ci + 1}`).join(',')})`;
      });
      await pool.query(
        `INSERT INTO catalog.product_facets (${cols.join(', ')})
         VALUES ${tuples.join(', ')}
         ON CONFLICT (chain_id, sku_id) DO UPDATE SET ${updateSet}`,
        values
      );
    }
    console.log(`catalog.product_facets bijgewerkt: ${rows.length} rijen.`);
  } finally {
    await pool.end();
  }
}

// Alleen draaien als direct aangeroepen (niet bij import in tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('facet-run.mjs')) {
  main().then(() => process.exit(0), (err) => { console.error('facet-run mislukt:', err); process.exit(1); });
}
