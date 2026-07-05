import { app } from '@azure/functions';
import { query } from '../lib/db';

/**
 * WS9 E5 — nightly learning loop: aggregate per-user match corrections and
 * promote consensus picks into catalog.lexicon_products so everyone benefits.
 * Corrections already win instantly for their own user at match time; this is
 * the community tier. Non-regression guard: scripts/match-eval.mjs in CI.
 */
export async function runLearningLoop(): Promise<{ aggregated: number; promoted: number }> {
  const agg = await query(
    `INSERT INTO app.match_overrides_agg (chain_id, item_normalised, sku_id, votes, last_seen_at)
     SELECT chain_id, item_normalised, chosen_sku_id, count(*), max(updated_at)
     FROM app.match_corrections
     GROUP BY chain_id, item_normalised, chosen_sku_id
     ON CONFLICT (chain_id, item_normalised, sku_id)
     DO UPDATE SET votes = EXCLUDED.votes, last_seen_at = EXCLUDED.last_seen_at
     RETURNING 1`
  );
  // consensus (≥3 votes) becomes a rank-1 lexicon hint; existing curated hints move down
  const promoted = await query(
    `INSERT INTO catalog.lexicon_products (item_normalised, chain_id, sku_id, rank)
     SELECT DISTINCT ON (a.item_normalised, a.chain_id) a.item_normalised, a.chain_id, a.sku_id, 1
     FROM app.match_overrides_agg a
     JOIN catalog.products p ON p.chain_id = a.chain_id AND p.sku_id = a.sku_id AND p.available
     WHERE a.votes >= 3
     ORDER BY a.item_normalised, a.chain_id, a.votes DESC
     ON CONFLICT (item_normalised, chain_id) DO UPDATE SET sku_id = EXCLUDED.sku_id, rank = 1
     RETURNING 1`
  );
  return { aggregated: agg.rowCount ?? 0, promoted: promoted.rowCount ?? 0 };
}

app.timer('learning-loop-nightly', {
  schedule: '0 30 3 * * *',
  handler: async (_t, ctx) => {
    const result = await runLearningLoop();
    ctx.log(`learning-loop: ${JSON.stringify(result)}`);
  },
});

app.http('learning-loop-run', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'ops/learning-loop',
  handler: async () => ({ status: 200, jsonBody: await runLearningLoop() }),
});
