// Safe first-import pipeline for the account-bound Picnic catalog.
//
// 1. load PICNIC_AUTH_KEY from env or Key Vault (never print it)
// 2. scrape a complete bronze snapshot
// 3. validate the snapshot before touching PostgreSQL
// 4. ingest through the normal silver/delta pipeline while Picnic is disabled
// 5. label every available product and verify category coverage
// 6. optionally enable Picnic, but only when the mobile live-chain manifest is ready
//
// Usage:
//   node scripts/prepare-picnic-catalog.mjs --env dev
//   node scripts/prepare-picnic-catalog.mjs --env dev --enable

import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import pg from 'pg';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const env = arg('env', 'dev');
const minProducts = Number(arg('min-products', 1_000));
const enable = process.argv.includes('--enable');
if (!['dev', 'prod'].includes(env)) throw new Error(`Onbekende omgeving: ${env}`);
if (!Number.isInteger(minProducts) || minProducts < 1) throw new Error('--min-products moet positief zijn');

const root = resolve(import.meta.dirname, '..');
const bronze = resolve(root, 'Output', 'picnic_bronze.jsonl');
const az = (...args) => execFileSync('az', args, {
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).trim();
const secret = (name) => az(
  'keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`,
  '--name', name, '--query', 'value', '-o', 'tsv'
);

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} stopte met code ${result.status}`);
}

async function validateBronze(path) {
  const ids = new Set();
  let lines = 0;
  let valid = 0;
  const input = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    lines++;
    const envelope = JSON.parse(line);
    const unit = envelope?.raw?.selling_unit;
    const id = String(envelope?.external_id ?? '');
    if (
      envelope?.store === 'picnic' && id && unit && String(unit.id ?? '') === id &&
      typeof unit.name === 'string' && unit.name.trim() &&
      Number.isInteger(unit.display_price) && unit.display_price > 0
    ) {
      valid++;
      ids.add(id);
    }
  }
  if (lines < minProducts) throw new Error(`Picnic snapshot te klein: ${lines} < ${minProducts}`);
  if (valid !== lines) throw new Error(`Picnic snapshot bevat ${lines - valid} ongeldige regels`);
  if (ids.size !== lines) throw new Error(`Picnic snapshot bevat ${lines - ids.size} dubbele product-id's`);
  return { products: lines };
}

let authKey = process.env.PICNIC_AUTH_KEY?.trim();
if (!authKey) {
  try {
    authKey = secret('PICNIC-AUTH-KEY');
  } catch {
    throw new Error(
      `PICNIC-AUTH-KEY ontbreekt. Draai eerst ./scripts/bootstrap-picnic-auth.ps1 -Env ${env}`
    );
  }
}
if (!authKey) throw new Error('PICNIC-AUTH-KEY is leeg');

console.log('Picnic: volledige accountgebonden catalogus ophalen…');
run(process.env.PYTHON_BIN?.trim() || 'python', ['-m', 'scrapers.picnic'], {
  PICNIC_AUTH_KEY: authKey,
});
authKey = null;

const inspected = await validateBronze(bronze);
console.log(`Picnic: ${inspected.products} unieke, geprijsde bronregels gevalideerd.`);

run(process.execPath, [
  'scripts/catalog-ingest.mjs', '--chain', 'picnic', '--file', bronze,
  '--env', env, '--bootstrap-disabled',
]);

const openAiKey = process.env.OPENAI_API_KEY?.trim() || secret('OPENAI-API-KEY');
run(process.execPath, [
  'scripts/label-product-intent.mjs', '--env', env, '--chain', 'picnic',
  '--max-usd', '5', '--concurrency', '4',
], { OPENAI_API_KEY: openAiKey });

const host = az(
  'postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`,
  '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv'
);
const client = new pg.Client({
  host,
  port: 5432,
  database: 'prakkie',
  user: 'prakkieadmin',
  password: secret('PG-ADMIN-PASSWORD'),
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15_000,
});

await client.connect();
try {
  const { rows: [audit] } = await client.query(`
    SELECT count(*)::int AS products,
           count(*) FILTER (WHERE p.available)::int AS available,
           count(i.sku_id) FILTER (WHERE p.available)::int AS intents,
           count(m.sku_id) FILTER (WHERE p.available)::int AS categorized,
           bool_or(COALESCE((c.last_ingest_status->>'ok')::boolean, false)) AS ingest_ok
    FROM catalog.chains c
    LEFT JOIN catalog.products p ON p.chain_id = c.id
    LEFT JOIN catalog.product_intent i
      ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
    LEFT JOIN catalog.store_product_categories m
      ON m.chain_id = p.chain_id AND m.sku_id = p.sku_id
    WHERE c.id = 'picnic'
  `);
  if (
    Number(audit.products) < minProducts || Number(audit.available) < minProducts ||
    Number(audit.intents) !== Number(audit.available) ||
    Number(audit.categorized) !== Number(audit.available) || audit.ingest_ok !== true
  ) {
    throw new Error(`Picnic database-audit faalde: ${JSON.stringify(audit)}`);
  }
  console.log(`Picnic database-audit groen: ${JSON.stringify(audit)}`);

  if (enable) {
    const shared = readFileSync(resolve(root, 'packages/shared/src/chains.ts'), 'utf8');
    const liveBlock = shared.match(/LIVE_CHAIN_IDS[^=]*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    if (!/["']picnic["']/.test(liveBlock)) {
      throw new Error(
        'Picnic staat nog niet in LIVE_CHAIN_IDS; deploy eerst de mobiele manifestwijziging en herhaal met --enable.'
      );
    }
    await client.query(`UPDATE catalog.chains SET enabled = true WHERE id = 'picnic'`);
    console.log('Picnic kill-switch is ingeschakeld na succesvolle audit.');
  } else {
    console.log('Picnic blijft veilig verborgen. Voeg Picnic na UI-verificatie toe aan LIVE_CHAIN_IDS en herhaal met --enable.');
  }
} finally {
  await client.end();
}

if (enable) {
  const functionKey = az(
    'functionapp', 'keys', 'list', '-g', `prakkie-${env}`,
    '-n', `func-prakkie-api-${env}`, '--query', 'functionKeys.default', '-o', 'tsv'
  );
  const response = await fetch(
    `https://func-prakkie-api-${env}.azurewebsites.net/api/ops/store-stats?code=${encodeURIComponent(functionKey)}`,
    { method: 'POST' }
  );
  if (!response.ok) throw new Error(`Picnic store-stats refresh faalde: HTTP ${response.status}`);
  console.log(`Picnic store-stats vernieuwd: ${JSON.stringify(await response.json())}`);
}
