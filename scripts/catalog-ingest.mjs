// Local catalog ingest (WS2 dev loop): bronze JSONL file → catalog.products on dev.
//   node scripts/catalog-ingest.mjs --chain ah --file ../Supermarket_Scrapers/Output/ah_bronze.jsonl [--no-sweep] [--env dev]
// Bundles the functions-ingest pipeline with esbuild (same code that runs in
// Azure), connects as the PG admin via Key Vault, and streams the file through
// ingestChain. Partial files (scraper --limit runs) should pass --no-sweep.
import { execFileSync, execSync } from 'node:child_process';
import { createReadStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const chain = arg('chain');
const file = arg('file');
const env = arg('env', 'dev');
const sweep = !process.argv.includes('--no-sweep');
if (!chain || !file) {
  console.error('Usage: node scripts/catalog-ingest.mjs --chain <id> --file <bronze.jsonl> [--no-sweep]');
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const az = (...a) => execFileSync('az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();

console.log(`Resolving dev PG credentials…`);
process.env.PG_HOST = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
process.env.PG_USER = 'prakkieadmin';
process.env.PG_PASSWORD = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');

// bundle the real pipeline (entry: a tiny virtual module would be nicer, but a
// direct bundle of ingest.ts + connectors keeps this a one-liner)
const outDir = mkdtempSync(join(tmpdir(), 'prakkie-ingest-'));
const entry = join(repoRoot, 'services/functions-ingest/src/lib/ingest.ts');
const connectorsEntry = join(repoRoot, 'services/functions-ingest/src/connectors/index.ts');
execSync(
  `npx esbuild "${entry}" "${connectorsEntry}" --bundle --platform=node --format=esm --outdir="${outDir}" --external:pg`,
  { cwd: repoRoot, stdio: 'inherit' }
);

const { ingestChain } = await import(pathToFileURL(join(outDir, 'ingest.js')).href);
const { connectorFor } = await import(pathToFileURL(join(outDir, 'index.js')).href);

const connector = connectorFor(chain);
if (!connector) throw new Error(`No connector for chain '${chain}'`);

const lines = createInterface({ input: createReadStream(resolve(file), 'utf8') });
console.log(`Ingesting ${file} → catalog.products [${chain}] (sweep=${sweep})…`);
const result = await ingestChain(connector, chain, lines, { sweep });
console.log(JSON.stringify(result, null, 2));
process.exit(0);
