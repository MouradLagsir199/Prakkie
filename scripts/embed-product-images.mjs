// Backfill catalog.product_image_embeddings met Azure AI Vision multimodal
// embeddings (Florence 1024-dim) per productfoto — de beeld-brug voor
// cross-chain matching (0015). Hervatbaar: slaat producten over die al een
// embedding hebben voor de huidige image_url (md5-hash); her-embed dus alleen
// bij een nieuwe foto. Kosten: ~$0.10 per 1.000 foto's.
//
// Usage: node scripts/embed-product-images.mjs [--env dev] [--chain aldi,dirk]
//        [--limit 500] [--concurrency 6] [--dry]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const env = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : 'dev';
const dry = process.argv.includes('--dry');
const onlyChains = process.argv.includes('--chain')
  ? process.argv[process.argv.indexOf('--chain') + 1].split(',').map((s) => s.trim())
  : null;
const limit = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : null;
const concurrency = process.argv.includes('--concurrency')
  ? Number(process.argv[process.argv.indexOf('--concurrency') + 1])
  : 6; // S1 = 10 TPS; hou marge voor de rest van het systeem

const az = (...args) => execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const kv = (name) => az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', name, '--query', 'value', '-o', 'tsv');

const endpoint = kv('VISION-ENDPOINT');
const visionKey = kv('VISION-API-KEY');
const host = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
const password = kv('PG-ADMIN-PASSWORD');
const client = new pg.Client({ host, port: 5432, database: 'prakkie', user: 'prakkieadmin', password, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
await client.connect();

const md5 = (s) => createHash('md5').update(s).digest('hex');

const { rows: todo } = await client.query(
  `SELECT p.chain_id, p.sku_id, p.image_url
   FROM catalog.products p
   LEFT JOIN catalog.product_image_embeddings e
     ON e.chain_id = p.chain_id AND e.sku_id = p.sku_id
    AND e.image_url_hash = md5(p.image_url)
   WHERE p.available AND p.image_url IS NOT NULL AND e.chain_id IS NULL
     ${onlyChains ? `AND p.chain_id = ANY($1)` : ''}
   ORDER BY p.chain_id, p.sku_id
   ${limit ? `LIMIT ${limit}` : ''}`,
  onlyChains ? [onlyChains] : []
);
console.log(`${todo.length} foto's te embedden (env ${env}${dry ? ', dry-run' : ''}, concurrency ${concurrency})`);
if (dry || todo.length === 0) {
  await client.end();
  process.exit(0);
}

async function vectorize(url, attempt = 0) {
  const res = await fetch(
    `${endpoint}computervision/retrieval:vectorizeImage?api-version=2024-02-01&model-version=2023-04-15`,
    {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': visionKey, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }
  );
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`vision ${res.status} na 5 pogingen`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return vectorize(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).vector;
}

let done = 0;
let failed = 0;
let cursor = 0;
const started = Date.now();

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= todo.length) return;
    const p = todo[i];
    try {
      const vector = await vectorize(p.image_url);
      await client.query(
        `INSERT INTO catalog.product_image_embeddings (chain_id, sku_id, embedding, image_url_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chain_id, sku_id)
         DO UPDATE SET embedding = EXCLUDED.embedding, image_url_hash = EXCLUDED.image_url_hash, embedded_at = now()`,
        [p.chain_id, p.sku_id, `[${vector.join(',')}]`, md5(p.image_url)]
      );
      done++;
    } catch (err) {
      failed++;
      if (failed <= 10) console.log(`  FAIL ${p.chain_id}:${p.sku_id} — ${err.message}`);
    }
    if ((done + failed) % 500 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      const etaMin = Math.round((todo.length - done - failed) / Math.max(rate, 0.1) / 60);
      console.log(`  ${done + failed}/${todo.length} (${failed} mislukt, ${rate.toFixed(1)}/s, ~${etaMin} min te gaan)`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`klaar: ${done} embeddings geschreven, ${failed} mislukt, ${Math.round((Date.now() - started) / 60000)} min`);
await client.end();
process.exit(failed > done ? 1 : 0);
