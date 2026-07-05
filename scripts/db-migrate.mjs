// Ordered SQL migration runner for services/migrations (plan/05 WS1).
// Usage: node scripts/db-migrate.mjs --env dev
//
// Connects as the PG admin (password from Key Vault, never printed), ensures the
// prakkie_app / prakkie_ingest roles exist with their Key Vault passwords, then
// applies each not-yet-applied services/migrations/*.sql in its own transaction,
// tracked in public.schema_migrations.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const env = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : 'dev';
if (!['dev', 'prod'].includes(env)) throw new Error(`Unknown env '${env}'`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'services', 'migrations');
const vaultName = `kv-prakkie-${env}`;

function az(...args) {
  return execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
}
function kvSecret(name) {
  return az('keyvault', 'secret', 'show', '--vault-name', vaultName, '--name', name, '--query', 'value', '-o', 'tsv');
}
// role passwords are alphanumeric-only (deploy.ps1 New-RandomSecret), but escape anyway
function sqlLiteral(v) {
  return `'${v.replace(/'/g, "''")}'`;
}

console.log(`Resolving PG host and secrets for [${env}]...`);
const host = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
if (!host) throw new Error(`No PG flexible server found in resource group prakkie-${env}`);
const adminPassword = kvSecret('PG-ADMIN-PASSWORD');
const appPassword = kvSecret('PG-APP-PASSWORD');
const ingestPassword = kvSecret('PG-INGEST-PASSWORD');

const client = new pg.Client({
  host,
  port: 5432,
  database: 'prakkie',
  user: 'prakkieadmin',
  password: adminPassword,
  ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
});

console.log(`Connecting to ${host}/prakkie as prakkieadmin...`);
await client.connect();

try {
  // roles first — 0006_grants.sql references them; ALTER keeps passwords in sync with KV
  for (const [role, password] of [
    ['prakkie_app', appPassword],
    ['prakkie_ingest', ingestPassword],
  ]) {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    await client.query(
      rowCount === 0
        ? `CREATE ROLE ${role} LOGIN PASSWORD ${sqlLiteral(password)}`
        : `ALTER ROLE ${role} LOGIN PASSWORD ${sqlLiteral(password)}`
    );
    console.log(`Role ${role} ${rowCount === 0 ? 'created' : 'ensured'}`);
  }

  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const applied = new Set(
    (await client.query('SELECT filename FROM public.schema_migrations')).rows.map((r) => r.filename)
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`> ${file}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  console.log('Migrations up to date.');
} finally {
  await client.end();
}
