// AI resolver eval — measures "loose retrieval + OpenAI selection" against the
// SAME labelled set as scripts/match-eval.mjs, so the top-1 number is directly
// comparable to the current fuzzy matcher's baseline (93.7%).
//   node scripts/ai-match-eval.mjs [--env dev] [--chains ah,jumbo,...] [--model gpt-5-mini] [--limit N] [--verbose]
// Labels: scripts/match-eval-set.csv — item, expect (regex top-1 name must match),
// forbid (regex it must NOT match). A row is scored per chain. Prints three
// numbers: top-1 accuracy, recall ceiling (was the right product even retrieved?),
// and null rate (model declined / hallucinated an invalid sku).
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const env = arg('env', 'dev');
const chains = arg('chains', 'ah,jumbo,plus,dirk,spar,aldi').split(',');
const model = arg('model', undefined);
const limit = arg('limit', undefined) ? Number(arg('limit', undefined)) : null;
const verbose = process.argv.includes('--verbose');
const CONCURRENCY = 6;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const az = (...a) => execFileSync('az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();

// DB creds + OpenAI key straight from the dev Key Vault (same pattern as match-eval).
const pgHost = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
const pgPassword = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
process.env.PG_HOST = pgHost;
process.env.PG_USER = 'prakkieadmin';
process.env.PG_PASSWORD = pgPassword;
process.env.JWT_SIGNING_KEY = 'unused-for-eval';
process.env.OPENAI_API_KEY = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'OPENAI-API-KEY', '--query', 'value', '-o', 'tsv');
if (model) process.env.OPENAI_MODEL = model;

// Bundle ai-resolve.ts (pulls in match.ts/db.ts) and import resolveItem — same
// esbuild trick match-eval uses for match.ts.
const outDir = mkdtempSync(join(tmpdir(), 'prakkie-ai-eval-'));
execSync(
  `npx esbuild "${join(repoRoot, 'services/functions-api/src/lib/ai-resolve.ts')}" --bundle --platform=node --format=cjs --outfile="${join(outDir, 'ai-resolve.js')}" --external:pg-native`,
  { cwd: repoRoot, stdio: 'pipe' }
);
const { resolveItem } = createRequire(import.meta.url)(join(outDir, 'ai-resolve.js'));

// Read-only pg pool (a single Client can't run concurrent queries cleanly);
// passed explicitly into resolveItem as its Queryable.
const client = new pg.Pool({
  host: pgHost, port: 5432, database: 'prakkie', user: 'prakkieadmin',
  password: pgPassword, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000,
  max: CONCURRENCY,
});

let rows = readFileSync(join(repoRoot, 'scripts/match-eval-set.csv'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [item, expect, forbid] = line.split(',');
    return {
      item: item.trim(),
      expect: new RegExp(expect.trim(), 'i'),
      forbid: forbid?.trim() ? new RegExp(forbid.trim(), 'i') : null,
    };
  });
if (limit) rows = rows.slice(0, limit);

const passes = (name, row) => row.expect.test(name) && !(row.forbid && row.forbid.test(name));

async function mapPool(items, poolSize, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, worker));
  return results;
}

let done = 0;
const perRow = await mapPool(rows, CONCURRENCY, async (row) => {
  let matches;
  try {
    matches = await resolveItem(row.item, chains, client, model ? { model } : {});
  } catch (err) {
    process.stderr.write(`  ! ${row.item}: ${err instanceof Error ? err.message : err}\n`);
    matches = null;
  }
  const perChain = chains.map((chain) => {
    const m = matches?.[chain];
    const best = m?.best ?? null;
    const shortlist = m?.shortlist ?? [];
    return {
      chain,
      isNull: !best,
      hit: !!best && passes(best.name, row),
      recall: shortlist.some((c) => passes(c.name, row)),
      name: best?.name ?? null,
      retrieved: shortlist.length,
    };
  });
  done++;
  if (done % 10 === 0) process.stderr.write(`  …${done}/${rows.length}\n`);
  return { row, perChain };
});

let scored = 0, hits = 0, recallHits = 0, nulls = 0;
const failures = [];
for (const { row, perChain } of perRow) {
  for (const c of perChain) {
    scored++;
    if (c.hit) hits++;
    if (c.recall) recallHits++;
    if (c.isNull) nulls++;
    if (!c.hit) {
      const why = c.isNull
        ? c.recall ? 'PICKED NULL (right product WAS retrieved)' : c.retrieved === 0 ? 'no candidates retrieved' : 'picked null'
        : c.recall ? `got "${c.name}" (right product was in candidates)` : `got "${c.name}"`;
      failures.push(`${row.item} @ ${c.chain}: ${why}`);
    }
  }
}

const pct = (n) => ((n / scored) * 100).toFixed(1);
console.log(`\nmodel: ${model ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini'}   items: ${rows.length}   chains: ${chains.join(',')}`);
console.log(`top-1 accuracy:  ${hits}/${scored} = ${pct(hits)}%   (current matcher baseline ≈ 93.7%)`);
console.log(`recall ceiling:  ${recallHits}/${scored} = ${pct(recallHits)}%   (max top-1 possible given retrieval)`);
console.log(`null / no-pick:  ${nulls}/${scored} = ${pct(nulls)}%`);
if (verbose || hits / scored < 0.9) {
  console.log(`\n${failures.length} misses:`);
  for (const f of failures.slice(0, verbose ? failures.length : 40)) console.log('  ' + f);
}

await client.end();
process.exit(hits / scored >= 0.9 ? 0 : 1);
