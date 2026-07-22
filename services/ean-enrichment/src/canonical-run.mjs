// Canonical-graph builder (matching v2, docs/09 Fase 3). Leest geverifieerde
// catalog.product_facets + het per-categorie beleid (catalog.category_facet_policy,
// met code-fallback), clustert tot canonieke knopen (canonical-graph.mjs) en
// schrijft catalog.canonical_product + catalog.canonical_member.
//
// Env: PG_* (zie run.mjs), FACET_CATEGORY (optioneel filter), CANON_LIMIT, DRY_RUN=1.
import pg from 'pg';
import { mergeCategoryPolicies, FACET_MATCHER_VERSION } from './facets.mjs';
import { buildCanonicalNodes } from './canonical-graph.mjs';

const env = (n, d) => process.env[n] ?? d;

async function pgPassword() {
  if (env('PG_PASSWORD')) return env('PG_PASSWORD');
  const vault = env('KEY_VAULT_NAME');
  if (!vault) throw new Error('PG_PASSWORD of KEY_VAULT_NAME is vereist');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const { SecretClient } = await import('@azure/keyvault-secrets');
  const client = new SecretClient(`https://${vault}.vault.azure.net`, new DefaultAzureCredential());
  return (await client.getSecret(env('PG_SECRET_NAME', 'PG-INGEST-PASSWORD'))).value;
}

async function main() {
  const dryRun = env('DRY_RUN', '') === '1';
  const category = env('FACET_CATEGORY', '');
  const limit = Number(env('CANON_LIMIT', '5000'));
  const pool = new pg.Pool({
    host: env('PG_HOST'), database: env('PG_DATABASE', 'prakkie'),
    user: env('PG_USER', 'prakkie_ingest'), password: await pgPassword(),
    port: Number(env('PG_PORT', '5432')),
    ssl: env('PG_SSL', 'require') === 'disable' ? undefined : { rejectUnauthorized: false }, max: 4,
  });
  try {
    // Beleid uit DB over de code-fallback.
    const policyRows = (await pool.query(
      'SELECT category, hard_facets, soft_facets FROM catalog.category_facet_policy'
    )).rows;
    const policies = mergeCategoryPolicies(policyRows);

    const params = [];
    let where = 'verified';
    if (category) { params.push(category); where += ` AND category = $${params.length}`; }
    params.push(limit);
    const facets = (await pool.query(
      `SELECT chain_id, sku_id, category, variant, flavor, form, type, dietary, confidence, verified
       FROM catalog.product_facets
       WHERE ${where}
       ORDER BY category, sku_id
       LIMIT $${params.length}`,
      params
    )).rows;

    const nodes = buildCanonicalNodes(facets, policies);
    const multiChain = nodes.filter((n) => new Set(n.members.map((m) => m.chain_id)).size > 1);
    console.log(`Geverifieerde facetrijen: ${facets.length}`);
    console.log(`Canonieke knopen: ${nodes.length}  ·  met leden uit >1 keten: ${multiChain.length}`);

    if (dryRun) {
      const sample = multiChain.slice(0, 5).map((n) => ({ label: n.label, members: n.members.length, key: n.facet_key }));
      console.log('DRY_RUN=1 — niets weggeschreven. Voorbeeld cross-chain knopen:', JSON.stringify(sample, null, 2));
      return;
    }

    let members = 0;
    for (const node of nodes) {
      await pool.query(
        `INSERT INTO catalog.canonical_product (canonical_id, category, facet_key, label, member_count, matcher_version)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (canonical_id) DO UPDATE SET
           category=EXCLUDED.category, facet_key=EXCLUDED.facet_key, label=EXCLUDED.label,
           member_count=EXCLUDED.member_count, matcher_version=EXCLUDED.matcher_version, built_at=now()`,
        [node.canonical_id, node.category, node.facet_key, node.label, node.members.length, FACET_MATCHER_VERSION]
      );
      for (const m of node.members) {
        await pool.query(
          `INSERT INTO catalog.canonical_member (chain_id, sku_id, canonical_id, confidence, reasons)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (chain_id, sku_id) DO UPDATE SET
             canonical_id=EXCLUDED.canonical_id, confidence=EXCLUDED.confidence,
             reasons=EXCLUDED.reasons, built_at=now()`,
          [m.chain_id, m.sku_id, node.canonical_id, m.confidence, m.reasons]
        );
        members++;
      }
    }
    console.log(`Weggeschreven: ${nodes.length} knopen, ${members} leden.`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('canonical-run.mjs')) {
  main().then(() => process.exit(0), (err) => { console.error('canonical-run mislukt:', err); process.exit(1); });
}
