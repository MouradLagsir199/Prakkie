// EAN-verrijking (owner-plan 2026-07-14):
//   Open Food Facts parquet → blob-cache (stprakkie<env>) → NL-filter +
//   kolomprojectie (DuckDB) → offline naam/merk/verpakking-match voor
//   catalogusregels zonder EAN (Aldi, PLUS, ontbrekende AH) → PostgreSQL.
// Draait als geplande Container Apps Job; lokaal: node src/run.mjs met PG_*
// env vars (en optioneel OFF_LOCAL_PARQUET om blob/HF over te slaan).
import pg from 'pg';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { stageParquetInBlob } from './blob-stage.mjs';
import { extractNlProducts } from './off-parquet.mjs';
import {
  buildOffIndex,
  containedCandidates,
  containedMatch,
  matchProduct,
} from './match-off.mjs';

const env = (name, fallback = undefined) => process.env[name] ?? fallback;

const DEFAULT_OFF_URL =
  'https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet';

async function pgPassword() {
  const direct = env('PG_PASSWORD');
  if (direct) return direct;
  const vault = env('KEY_VAULT_NAME');
  if (!vault) throw new Error('PG_PASSWORD of KEY_VAULT_NAME is vereist');
  const client = new SecretClient(`https://${vault}.vault.azure.net`, new DefaultAzureCredential());
  const secret = await client.getSecret(env('PG_SECRET_NAME', 'PG-INGEST-PASSWORD'));
  return secret.value;
}

async function main() {
  const chains = env('ENRICH_CHAINS', 'aldi,plus,ah').split(',').map((c) => c.trim()).filter(Boolean);
  const dryRun = env('DRY_RUN', '') === '1';

  // 1. parquet-bron bepalen: lokaal pad > blob-cache > rechtstreeks HF
  let parquetSource = env('OFF_LOCAL_PARQUET');
  if (!parquetSource) {
    const account = env('STORAGE_ACCOUNT');
    const sourceUrl = env('OFF_PARQUET_URL', DEFAULT_OFF_URL);
    parquetSource = account
      ? await stageParquetInBlob({
          accountName: account,
          sourceUrl,
          maxAgeDays: Number(env('OFF_MAX_AGE_DAYS', '20')),
        })
      : sourceUrl;
  }

  // 2. NL-subset + benodigde kolommen
  console.log('OFF-parquet lezen (NL-filter + kolomprojectie)…');
  const offRows = await extractNlProducts(parquetSource);
  console.log(`OFF NL-producten: ${offRows.length}`);
  const index = buildOffIndex(offRows);
  console.log(`Geïndexeerd (geldige EAN + naam): ${index.size}`);

  // 3. doelproducten: alles zonder EAN in de opgegeven ketens
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
    const targets = (
      await pool.query(
        `SELECT chain_id, sku_id, name, brand, pack_size_value, pack_size_unit
         FROM catalog.products
         WHERE ean IS NULL AND chain_id = ANY($1)`,
        [chains]
      )
    ).rows;
    console.log(`Catalogusregels zonder EAN in [${chains.join(', ')}]: ${targets.length}`);

    // 4. matchen — cascade exact → tokens → insluiting (zie match-off.mjs)
    const matches = [];
    const perMethod = { off_exact: 0, off_tokens: 0, off_contained: 0 };
    for (const product of targets) {
      let hit = matchProduct(product, index);
      if (!hit) hit = containedMatch(product, containedCandidates(product, index));
      if (!hit) continue;
      perMethod[hit.method]++;
      matches.push({
        chain_id: product.chain_id,
        sku_id: product.sku_id,
        ean: hit.ean,
        method: hit.method,
        score: hit.score,
        off_name: hit.off.name ?? null,
        off_brand: hit.off.brands ?? null,
      });
    }
    console.log(
      `Matches: ${matches.length} (exact ${perMethod.off_exact}, tokens ${perMethod.off_tokens}, insluiting ${perMethod.off_contained})`
    );

    // 5. wegschrijven — products.ean alleen vullen waar nog NULL; provenance upsert
    if (dryRun) {
      console.log('DRY_RUN=1 — niets weggeschreven. Voorbeeld:', JSON.stringify(matches.slice(0, 10), null, 2));
      return;
    }
    let updated = 0;
    for (let i = 0; i < matches.length; i += 5000) {
      const batch = matches.slice(i, i + 5000);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await client.query(
          `UPDATE catalog.products p
           SET ean = u.ean, updated_at = now()
           FROM unnest($1::text[], $2::text[], $3::text[]) AS u(chain_id, sku_id, ean)
           WHERE p.chain_id = u.chain_id AND p.sku_id = u.sku_id AND p.ean IS NULL`,
          [batch.map((m) => m.chain_id), batch.map((m) => m.sku_id), batch.map((m) => m.ean)]
        );
        await client.query(
          `INSERT INTO catalog.ean_enrichment (chain_id, sku_id, ean, method, score, off_product_name, off_brand, matched_at)
           SELECT * , now() FROM unnest(
             $1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::text[]
           ) AS u(chain_id, sku_id, ean, method, score, off_product_name, off_brand)
           ON CONFLICT (chain_id, sku_id) DO UPDATE SET
             ean = EXCLUDED.ean, method = EXCLUDED.method, score = EXCLUDED.score,
             off_product_name = EXCLUDED.off_product_name, off_brand = EXCLUDED.off_brand,
             matched_at = now()`,
          [
            batch.map((m) => m.chain_id),
            batch.map((m) => m.sku_id),
            batch.map((m) => m.ean),
            batch.map((m) => m.method),
            batch.map((m) => m.score),
            batch.map((m) => m.off_name),
            batch.map((m) => m.off_brand),
          ]
        );
        await client.query('COMMIT');
        updated += res.rowCount ?? 0;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    const coverage = await pool.query(
      `SELECT chain_id, count(*) AS total, count(ean) AS with_ean
       FROM catalog.products GROUP BY chain_id ORDER BY chain_id`
    );
    console.log(`products.ean gevuld: ${updated} rijen. Dekking per keten:`);
    for (const row of coverage.rows) {
      console.log(`  ${row.chain_id}: ${row.with_ean}/${row.total} (${Math.round((row.with_ean / row.total) * 100)}%)`);
    }
  } finally {
    await pool.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('ean-enrichment mislukt:', err);
    process.exit(1);
  }
);
