// End-to-end refresh for the five newly implemented supermarket catalogs:
// scrape a complete bronze JSONL first, then ingest it with the shared delta /
// price-history / availability-sweep pipeline. A failed chain is isolated and
// never prevents the remaining chains from refreshing.
//
// Usage:
//   node scripts/refresh-supermarket-catalogs.mjs --env dev
//   node scripts/refresh-supermarket-catalogs.mjs --chains dekamarkt,vomar
//
// Picnic is account-bound. Supply PICNIC_AUTH_KEY (preferred), or
// PICNIC_EMAIL + PICNIC_PASSWORD, and enable its catalog.chains kill-switch
// after the first successful authenticated snapshot has been inspected.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const env = arg('env', 'dev');
const supported = ['dekamarkt', 'vomar', 'hoogvliet', 'picnic', 'ekoplaza'];
const picnicConfigured = !!(
  process.env.PICNIC_AUTH_KEY?.trim() ||
  (process.env.PICNIC_EMAIL?.trim() && process.env.PICNIC_PASSWORD?.trim())
);
const defaultChains = supported.filter((chain) => chain !== 'picnic' || picnicConfigured);
const chains = arg('chains', defaultChains.join(','))
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const unknown = chains.filter((chain) => !supported.includes(chain));
if (unknown.length) throw new Error(`Onbekende nieuwe catalogusketen(s): ${unknown.join(', ')}`);

const root = resolve(import.meta.dirname, '..');
const python = process.env.PYTHON_BIN?.trim() || 'python';
const results = [];

if (!picnicConfigured && !process.argv.includes('--chains')) {
  console.log('Picnic overgeslagen: zet PICNIC_AUTH_KEY voor de accountgebonden catalogus.');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} stopte met code ${result.status}`);
}

for (const chain of chains) {
  const started = Date.now();
  try {
    console.log(`\n=== ${chain}: volledige scrape ===`);
    run(python, ['-m', `scrapers.${chain}`]);
    console.log(`\n=== ${chain}: catalogus-ingest (${env}) ===`);
    run(process.execPath, [
      'scripts/catalog-ingest.mjs',
      '--chain', chain,
      '--file', `Output/${chain}_bronze.jsonl`,
      '--env', env,
    ]);
    results.push({ chain, ok: true, minutes: Math.round((Date.now() - started) / 600) / 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${chain} MISLUKT: ${message}`);
    results.push({ chain, ok: false, error: message });
  }
}

console.table(results);
if (results.some((result) => !result.ok)) process.exitCode = 1;
