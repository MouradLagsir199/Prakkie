// Backfill text embeddings for semantic product retrieval.
// Usage: node scripts/embed-product-text.mjs --env dev [--limit 5000]
// OPENAI_API_KEY / PG_* may be supplied; otherwise dev credentials are read
// from Azure CLI + Key Vault without ever printing secrets.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const env = arg('env', 'dev');
const limit = Number(arg('limit', '100000'));
const batchSize = Math.min(512, Number(arg('batch', '512')));
const model = arg('model', 'text-embedding-3-small');
const dimensions = 512;
const az = (...args) => execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();

process.env.PG_HOST ||= az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
process.env.PG_USER ||= 'prakkieadmin';
process.env.PG_PASSWORD ||= az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
process.env.OPENAI_API_KEY ||= az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'OPENAI-API-KEY', '--query', 'value', '-o', 'tsv');

const client = new pg.Client({
  host: process.env.PG_HOST, database: 'prakkie', user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15_000,
});

async function embed(inputs) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, dimensions, input: inputs }),
      });
      if (!response.ok) throw new Error(`OpenAI embeddings ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json();
      return body.data.sort((a, b) => a.index - b.index).map((row) => `[${row.embedding.join(',')}]`);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('embedding retries exhausted');
}

async function embedBatch(inputs) {
  const chunks = [];
  for (let i = 0; i < inputs.length; i += 64) chunks.push(inputs.slice(i, i + 64));
  return (await Promise.all(chunks.map((chunk) => embed(chunk)))).flat();
}

async function productBackfill() {
  let processed = 0;
  while (processed < limit) {
    const batch = (await client.query(
      `WITH source AS (
         SELECT p.chain_id, p.sku_id,
                concat_ws(' | ', 'product', pi.head_term, nc.display_name, p.name, p.brand,
                          array_to_string(p.category_path, ' > ')) AS input
         FROM catalog.products p
         LEFT JOIN catalog.product_intent pi ON pi.chain_id = p.chain_id AND pi.sku_id = p.sku_id
         LEFT JOIN catalog.name_canonical nc ON nc.name_search = public.fold_text(p.name)
         WHERE p.available
       )
       SELECT s.chain_id, s.sku_id, s.input, md5(s.input) AS input_hash
       FROM source s
       LEFT JOIN catalog.product_embeddings e ON e.chain_id = s.chain_id AND e.sku_id = s.sku_id
       WHERE e.sku_id IS NULL OR e.model <> $1 OR e.input_hash IS DISTINCT FROM md5(s.input)
       ORDER BY s.chain_id, s.sku_id LIMIT $2`,
      [model, Math.min(batchSize, limit - processed)]
    )).rows;
    if (!batch.length) break;
    const vectors = await embedBatch(batch.map((row) => row.input));
    await client.query(
      `INSERT INTO catalog.product_embeddings (chain_id, sku_id, embedding, model, input_hash, updated_at)
       SELECT x.chain_id, x.sku_id, x.embedding::vector, $5, x.input_hash, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(chain_id, sku_id, embedding, input_hash)
       ON CONFLICT (chain_id, sku_id) DO UPDATE SET
         embedding = EXCLUDED.embedding, model = EXCLUDED.model,
         input_hash = EXCLUDED.input_hash, updated_at = now()`,
      [batch.map((row) => row.chain_id), batch.map((row) => row.sku_id), vectors, batch.map((row) => row.input_hash), model]
    );
    processed += batch.length;
    console.log(`products ${processed}`);
  }
}

async function lexiconBackfill() {
  const rows = (await client.query(
    `SELECT id, concat_ws(' | ', 'ingredient', item_normalised, array_to_string(aliases, ' ')) AS input
     FROM catalog.ingredient_lexicon WHERE embedding IS NULL ORDER BY item_normalised`
  )).rows;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const vectors = await embedBatch(batch.map((row) => row.input));
    await client.query(
      `UPDATE catalog.ingredient_lexicon l SET embedding = x.embedding::vector
       FROM unnest($1::uuid[], $2::text[]) AS x(id, embedding) WHERE l.id = x.id`,
      [batch.map((row) => row.id), vectors]
    );
    console.log(`lexicon ${Math.min(offset + batch.length, rows.length)}/${rows.length}`);
  }
}

await client.connect();
try {
  await productBackfill();
  await lexiconBackfill();
  const status = (await client.query(
    `SELECT
       (SELECT count(*)::int FROM catalog.products WHERE available) AS available_products,
       (SELECT count(*)::int FROM catalog.product_embeddings) AS product_embeddings,
       (SELECT count(*)::int FROM catalog.ingredient_lexicon) AS lexicon_items,
       (SELECT count(*)::int FROM catalog.ingredient_lexicon WHERE embedding IS NOT NULL) AS lexicon_embeddings`
  )).rows[0];
  console.log(`status products ${status.product_embeddings}/${status.available_products}, lexicon ${status.lexicon_embeddings}/${status.lexicon_items}`);
} finally {
  await client.end();
}
