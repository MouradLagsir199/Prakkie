// Local catalog ingest (WS2 dev loop): bronze JSONL file → catalog.products on dev.
//   node scripts/catalog-ingest.mjs --chain ah --file ../Supermarket_Scrapers/Output/ah_bronze.jsonl [--no-sweep] [--env dev]
//   --bootstrap-disabled is an explicit local-admin escape hatch for the first
//   inspected import of a new chain. The hosted ingest endpoint cannot use it.
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
const bootstrapDisabled = process.argv.includes('--bootstrap-disabled');
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
  `npx esbuild "${entry}" "${connectorsEntry}" --bundle --platform=node --format=cjs --outdir="${outDir}" --external:pg-native`,
  { cwd: repoRoot, stdio: 'inherit' }
);

// Met meerdere entrypoints bewaart esbuild hun relatieve lib/connectors-map.
// De oude vlakke paden maakten de lokale ingest op Windows onbruikbaar.
const { ingestChain } = await import(pathToFileURL(join(outDir, 'lib', 'ingest.js')).href);
const { connectorFor } = await import(pathToFileURL(join(outDir, 'connectors', 'index.js')).href);

const connector = connectorFor(chain);
if (!connector) throw new Error(`No connector for chain '${chain}'`);

// Open de stream pas wanneer ingestChain daadwerkelijk begint te itereren.
// Een readline-interface start meteen met lezen; tijdens de Azure/PG-connect
// kon een klein bestand daardoor al volledig voorbij zijn vóór de consumer
// zijn `for await` bereikte, waarna die eindeloos op een volgende regel wachtte.
async function* readLinesLazily(path) {
  const lines = createInterface({ input: createReadStream(path, 'utf8') });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
  }
}
const lines = readLinesLazily(resolve(file));
console.log(`Ingesting ${file} → catalog.products [${chain}] (sweep=${sweep}, bootstrapDisabled=${bootstrapDisabled})…`);
const result = await ingestChain(connector, chain, lines, {
  sweep,
  allowDisabledBootstrap: bootstrapDisabled,
});
console.log(JSON.stringify(result, null, 2));
process.exit(0);
