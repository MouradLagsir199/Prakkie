// Risk/coverage evaluation for "Alles bij X" acceptance policies.
// Unlike top-1 accuracy this reports precision only for automatically accepted
// substitutions plus coverage. Usage: node scripts/match-policy-eval.mjs --env dev
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const env = arg('env', 'dev');
const chains = arg('chains', 'ah,jumbo,plus,dirk,spar,aldi').split(',');
const maxItems = Number(arg('max-items', '100'));
const writeCalibration = process.argv.includes('--write-calibration');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const az = (...args) => execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
process.env.PG_HOST ||= az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
process.env.PG_USER ||= 'prakkieadmin';
process.env.PG_PASSWORD ||= az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
process.env.JWT_SIGNING_KEY = 'unused-for-eval';

const out = mkdtempSync(join(tmpdir(), 'prakkie-policy-eval-'));
execSync(
  `npx esbuild "${join(repoRoot, 'services/functions-api/src/lib/match.ts')}" "${join(repoRoot, 'services/functions-api/src/lib/match-policy.ts')}" --bundle --platform=node --format=cjs --outdir="${out}" --external:pg-native`,
  { cwd: repoRoot, stdio: 'pipe' }
);
const require = createRequire(import.meta.url);
const matcher = require(join(out, 'match.js'));
const policyLib = require(join(out, 'match-policy.js'));
const pgMod = await import('pg');
const client = new pgMod.default.Client({
  host: process.env.PG_HOST, database: 'prakkie', user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15_000,
});
await client.connect();

const labelled = readFileSync(join(repoRoot, 'scripts/match-eval-set.csv'), 'utf8').trim().split('\n').slice(1, maxItems + 1).map((line) => {
  const [item, expect, forbid] = line.split(',');
  return { item: item.trim(), expect: new RegExp(expect, 'i'), forbid: forbid?.trim() ? new RegExp(forbid, 'i') : null };
});
const stats = Object.fromEntries(['precise', 'practical', 'value'].map((policy) => [policy, { possible: 0, accepted: 0, correct: 0 }]));
const observations = [];

// EAN-only regime (owner 2026-07-14): mét anker accepteert assessCandidate
// alleen nog exacte EAN-identiteit — daar valt niets aan te kalibreren. Deze
// eval meet dus de ánkerloze ingrediënt→product-suggesties (de enige plek
// waar drempels nog beslissen), per keten.
for (const label of labelled) {
  const candidates = await matcher.matchItem(label.item, chains, null, client);
  for (const chain of chains) {
    const shortlist = candidates[chain]?.shortlist ?? [];
    const best = matcher.pickSaneBest(shortlist);
    for (const policy of ['precise', 'practical', 'value']) {
      stats[policy].possible++;
      if (!best) continue;
      const assessment = policyLib.assessCandidate(best, null, policy);
      const correct = label.expect.test(best.name) && !(label.forbid && label.forbid.test(best.name));
      observations.push({ policy, source: best.source, score: assessment.reliability, correct, eligible: assessment.hard_compatible });
      if (assessment.decision !== 'accepted') continue;
      stats[policy].accepted++;
      if (correct) stats[policy].correct++;
    }
  }
}

for (const [policy, s] of Object.entries(stats)) {
  const precision = s.accepted ? (100 * s.correct / s.accepted).toFixed(1) : 'n/a';
  const coverage = s.possible ? (100 * s.accepted / s.possible).toFixed(1) : '0.0';
  console.log(`${policy}: precision ${s.correct}/${s.accepted} (${precision}%), coverage ${s.accepted}/${s.possible} (${coverage}%)`);
}

if (writeCalibration) {
  const targets = { precise: 0.99, practical: 0.97, value: 0.95 };
  for (const policy of ['precise', 'practical', 'value']) {
    for (const source of ['lexicon', 'trgm', 'semantic']) {
      const group = observations.filter((o) => o.policy === policy && o.source === source && o.eligible)
        .sort((a, b) => b.score - a.score);
      let chosen = null;
      for (let count = 10; count <= group.length; count++) {
        const sample = group.slice(0, count);
        const precision = sample.filter((o) => o.correct).length / count;
        if (precision >= targets[policy]) chosen = { threshold: sample[count - 1].score, precision, count };
      }
      if (!chosen) {
        console.log(`calibration ${policy}/${source}: unchanged (no >=10 sample reaches target)`);
        continue;
      }
      await client.query(
        `UPDATE catalog.match_policy_calibration
         SET min_score = $3, measured_precision = $4, sample_size = $5, calibrated_at = now()
         WHERE matcher_version = $6 AND policy = $1 AND source = $2`,
        [policy, source, chosen.threshold, chosen.precision, chosen.count, policyLib.MATCHER_VERSION]
      );
      console.log(`calibration ${policy}/${source}: min=${chosen.threshold.toFixed(3)}, precision=${(100 * chosen.precision).toFixed(1)}%, n=${chosen.count}`);
    }
  }
}
await client.end();
