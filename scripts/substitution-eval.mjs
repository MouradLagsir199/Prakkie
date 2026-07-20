// Substitutie-eval, EAN-only regime (owner 2026-07-14): verankerde substitutie
// bestaat alleen nog als exact dezelfde EAN/GTIN bij de doelketen. Deze eval
// meet dus geen "logische gelijkenis" meer maar dékking: voor elke staple ×
// elke keten als anker — heeft het anker een EAN, en bij hoeveel doelketens
// levert die een exacte treffer op? Huismerken hebben per definitie een eigen
// EAN en missen dan eerlijk (de user kiest zelf uit de shortlist).
//
// Usage: node scripts/substitution-eval.mjs [--env dev] [--verbose]
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const env = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : 'dev';
const verbose = process.argv.includes('--verbose');
const CHAINS = ['ah', 'jumbo', 'plus', 'dirk', 'spar', 'aldi'];
const STAPLES = [
  'stokbrood', 'sperziebonen', 'volle melk', 'halfvolle melk', 'roomboter', 'jonge kaas',
  'eieren', 'bruin brood', 'wit brood', 'appel', 'ui', 'aardappel', 'kipfilet', 'gehakt',
  'tomaat', 'komkommer', 'yoghurt', 'kwark', 'penne', 'rijst',
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// al gezette env (bv. PG_PASSWORD uit ~/.prakkie-pg-pass) gaat vóór az — az
// kan in sommige shells hangen (zie memory az-cli-hangs-in-session)
const az = (...a) => execFileSync('az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
process.env.PG_HOST ||= az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
process.env.PG_USER = 'prakkieadmin';
process.env.PG_PASSWORD ||= az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
process.env.JWT_SIGNING_KEY = 'unused-for-eval';

const outDir = mkdtempSync(join(tmpdir(), 'prakkie-subst-'));
execSync(
  `npx esbuild "${join(repoRoot, 'services/functions-api/src/lib/match.ts')}" --bundle --platform=node --format=cjs --outfile="${join(outDir, 'match.js')}" --external:pg-native`,
  { stdio: 'pipe', cwd: repoRoot }
);
const { matchItem } = await import(pathToFileURL(join(outDir, 'match.js')).href).then((m) => m.default ?? m);

const pgMod = await import('pg');
const client = new pgMod.default.Client({
  host: process.env.PG_HOST, database: 'prakkie', user: 'prakkieadmin', password: process.env.PG_PASSWORD,
  ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000,
});
await client.connect();

let checks = 0;
let hits = 0;
let anchorsWithoutEan = 0;
for (const staple of STAPLES) {
  const anchors = await matchItem(staple, CHAINS, null, client);
  for (const anchorChain of CHAINS) {
    const anchorBest = anchors[anchorChain]?.best;
    if (!anchorBest) continue;
    const ar = await client.query(
      `SELECT p.name, p.ean FROM catalog.products p WHERE p.chain_id = $1 AND p.sku_id = $2`,
      [anchorBest.chain_id, anchorBest.sku_id]
    );
    const anchor = ar.rows[0];
    if (!anchor) continue;
    if (!anchor.ean) {
      anchorsWithoutEan++;
      if (verbose) console.log(`  geen EAN ${staple}: [${anchorChain}] "${anchor.name}"`);
      continue;
    }
    const targets = CHAINS.filter((c) => c !== anchorChain);
    for (const target of targets) {
      checks++;
      // exact dezelfde vorm als de EAN-tier in pricing.ts (0032-index)
      const r = await client.query(
        `SELECT p.name FROM catalog.products p
         WHERE p.chain_id = $1
           AND NULLIF(ltrim(p.ean, '0'), '') = NULLIF(ltrim($2, '0'), '')
           AND p.available
         ORDER BY p.price_cents ASC LIMIT 1`,
        [target, anchor.ean]
      );
      if (r.rows[0]) {
        hits++;
        if (verbose) console.log(`  ok ${staple}: [${anchorChain}] "${anchor.name}" → [${target}] "${r.rows[0].name}" (EAN ${anchor.ean})`);
      } else if (verbose) {
        console.log(`  geen match ${staple}: [${anchorChain}] "${anchor.name}" → [${target}] (EAN ${anchor.ean} onbekend daar)`);
      }
    }
  }
}

const pct = checks ? ((100 * hits) / checks).toFixed(1) : '0.0';
console.log(`EAN-substitutie: ${hits}/${checks} treffers (${pct}%), ankers zonder EAN: ${anchorsWithoutEan}`);
console.log('NB: huismerken missen per definitie cross-chain — dit getal is dekking, geen kwaliteit.');
await client.end();
