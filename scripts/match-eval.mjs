// Match eval (WS2 acceptance: ≥90% top-1 on the labelled set).
//   node scripts/match-eval.mjs [--env dev] [--chains ah,jumbo,plus,dirk,spar,aldi] [--verbose]
// Labels: scripts/match-eval-set.csv — item, expect (regex the top-1 product
// name must match), forbid (regex it must NOT match). A row is scored per
// chain that returns any candidate; chains with zero candidates for an item
// count as a miss only when the item is a staple (all rows here are staples).
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const env = arg('env', 'dev');
const chains = arg('chains', 'ah,jumbo,plus,dirk,spar,aldi').split(',');
const verbose = process.argv.includes('--verbose');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const az = (...a) => execFileSync('az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
process.env.PG_HOST = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
process.env.PG_USER = 'prakkieadmin';
process.env.PG_PASSWORD = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
process.env.JWT_SIGNING_KEY = 'unused-for-eval';

const outDir = mkdtempSync(join(tmpdir(), 'prakkie-eval-'));
execSync(
  `npx esbuild "${join(repoRoot, 'services/functions-api/src/lib/match.ts')}" --bundle --platform=node --format=cjs --outfile="${join(outDir, 'match.js')}" --external:pg-native`,
  { cwd: repoRoot, stdio: 'pipe' }
);
const { createRequire } = await import("node:module");const { matchItem } = createRequire(import.meta.url)(join(outDir, "match.js"));

const rows = readFileSync(join(repoRoot, 'scripts/match-eval-set.csv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [item, expect, forbid] = line.split(',');
    return { item: item.trim(), expect: new RegExp(expect, 'i'), forbid: forbid?.trim() ? new RegExp(forbid, 'i') : null };
  });

let scored = 0;
let hits = 0;
const failures = [];
for (const row of rows) {
  const matches = await matchItem(row.item, chains, null);
  for (const chain of chains) {
    const best = matches[chain]?.best;
    if (!best) {
      scored++;
      failures.push(`${row.item} @ ${chain}: NO MATCH`);
      continue;
    }
    scored++;
    const ok = row.expect.test(best.name) && !(row.forbid && row.forbid.test(best.name));
    if (ok) hits++;
    else failures.push(`${row.item} @ ${chain}: got "${best.name}" (${best.source} ${best.confidence.toFixed(2)})`);
  }
}

const pct = ((hits / scored) * 100).toFixed(1);
console.log(`top-1 accuracy: ${hits}/${scored} = ${pct}%  (target ≥90%)`);
if (verbose || pct < 90) {
  console.log(`\n${failures.length} misses:`);
  for (const f of failures.slice(0, verbose ? failures.length : 40)) console.log('  ' + f);
}
process.exit(pct >= 90 ? 0 : 1);
