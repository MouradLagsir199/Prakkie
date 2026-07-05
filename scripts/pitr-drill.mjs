// PITR restore drill (plan/05 WS1 acceptance: "PITR drill to −1 h succeeds").
// Usage: node scripts/pitr-drill.mjs --env dev [--phase marker|restore|verify|cleanup|all]
//
// Phases (all = marker → restore → verify → cleanup):
//   marker   insert public.pitr_drill row 'after-restore-point' on the SOURCE server —
//            it must NOT exist in a copy restored to a point ≥ 1 h before now
//   restore  az postgres flexible-server restore to now−1h as <server>-drill (~10–20 min)
//   verify   connect to the drill server as admin: schema_migrations complete, seed data
//            present, marker row absent (when it was inserted after the restore point)
//   cleanup  delete the drill server (avoids double B1ms cost)
//
// Run as the deploying identity (az login); admin password comes from Key Vault.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const env = arg('env', 'dev');
const phase = arg('phase', 'all');
if (!['dev', 'prod'].includes(env)) throw new Error(`Unknown env '${env}'`);

const rg = `prakkie-${env}`;
const vault = `kv-prakkie-${env}`;
const az = (...a) => execFileSync('az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();

const sourceName = az('postgres', 'flexible-server', 'list', '-g', rg, '--query', '[0].name', '-o', 'tsv');
if (!sourceName) throw new Error(`No PG flexible server in ${rg}`);
const drillName = `${sourceName}-drill`;
const adminPassword = az('keyvault', 'secret', 'show', '--vault-name', vault, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');

async function connect(host) {
  const client = new pg.Client({
    host,
    database: 'prakkie',
    user: 'prakkieadmin',
    password: adminPassword,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  return client;
}
const hostOf = (name) =>
  az('postgres', 'flexible-server', 'show', '-g', rg, '-n', name, '--query', 'fullyQualifiedDomainName', '-o', 'tsv');

const run = (p) => phase === 'all' || phase === p;
let restoreTime; // ISO; set in restore phase, passed to verify via drill-server tag

if (run('marker')) {
  const client = await connect(hostOf(sourceName));
  await client.query('CREATE TABLE IF NOT EXISTS public.pitr_drill (marker text PRIMARY KEY, inserted_at timestamptz NOT NULL DEFAULT now())');
  await client.query(`INSERT INTO public.pitr_drill (marker) VALUES ('after-restore-point')
                      ON CONFLICT (marker) DO UPDATE SET inserted_at = now()`);
  const { rows } = await client.query("SELECT inserted_at FROM public.pitr_drill WHERE marker = 'after-restore-point'");
  console.log(`[marker] inserted on ${sourceName} at ${rows[0].inserted_at.toISOString()}`);
  await client.end();
}

if (run('restore')) {
  restoreTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const earliest = az('postgres', 'flexible-server', 'show', '-g', rg, '-n', sourceName, '--query', 'backup.earliestRestoreDate', '-o', 'tsv');
  if (new Date(restoreTime) < new Date(earliest)) {
    throw new Error(`now−1h (${restoreTime}) precedes earliest restore point (${earliest}) — retry later`);
  }
  console.log(`[restore] restoring ${sourceName} @ ${restoreTime} → ${drillName} (takes ~10–20 min)…`);
  az('postgres', 'flexible-server', 'restore', '-g', rg, '-n', drillName,
    '--source-server', sourceName, '--restore-time', restoreTime, '--tags', `pitr-restore-time=${restoreTime}`);
  console.log('[restore] done');
}

if (run('verify')) {
  restoreTime ??= az('postgres', 'flexible-server', 'show', '-g', rg, '-n', drillName, '--query', 'tags."pitr-restore-time"', '-o', 'tsv') || null;
  // restored servers copy no firewall rules — open the runner's IP
  const myIp = az('rest', '--method', 'get', '--url', 'https://api.ipify.org', '--skip-authorization-header', '--output', 'tsv');
  az('postgres', 'flexible-server', 'firewall-rule', 'create', '-g', rg, '-n', drillName,
    '--rule-name', 'drill-runner', '--start-ip-address', myIp, '--end-ip-address', myIp);

  const client = await connect(hostOf(drillName));
  const migrations = (await client.query('SELECT filename FROM public.schema_migrations ORDER BY filename')).rows.map((r) => r.filename);
  const counts = (await client.query(
    `SELECT (SELECT count(*)::int FROM catalog.chains) chains,
            (SELECT count(*)::int FROM catalog.aisle_taxonomy) aisles`)).rows[0];
  const drillTable = await client.query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'pitr_drill'`);
  let markerAt = null;
  if (drillTable.rowCount) {
    const m = await client.query(`SELECT inserted_at FROM public.pitr_drill WHERE marker = 'after-restore-point'`);
    markerAt = m.rowCount ? m.rows[0].inserted_at : null;
  }
  await client.end();

  console.log(`[verify] restore point: ${restoreTime ?? 'unknown'}`);
  console.log(`[verify] migrations on drill copy: ${migrations.length} (${migrations.join(', ')})`);
  console.log(`[verify] seed counts: chains=${counts.chains} aisles=${counts.aisles}`);
  console.log(`[verify] 'after-restore-point' marker present: ${markerAt ? markerAt.toISOString() : 'no'}`);
  // marker was inserted after the restore point, so it must be absent from the copy
  const pass = migrations.length >= 6 && counts.chains >= 10 && counts.aisles >= 20 && !markerAt;
  console.log(pass ? '[verify] PITR DRILL PASSED' : '[verify] PITR DRILL FAILED');
  if (!pass) process.exitCode = 1;
}

if (run('cleanup')) {
  console.log(`[cleanup] deleting ${drillName}…`);
  az('postgres', 'flexible-server', 'delete', '-g', rg, '-n', drillName, '--yes');
  console.log('[cleanup] done');
}
