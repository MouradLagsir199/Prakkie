import { app } from '@azure/functions';
import { normaliseIngredient } from '@prakkie/matching';
import { HttpError, handler, json, requireAuth } from '../lib/http';
import { matchItem, resolveLexicon } from '../lib/match';
import { query } from '../lib/db';

/**
 * GET /v1/match?item=<raw or normalised>&chains=ah,jumbo
 * The match-fix / shortlist entrance (E5): returns best + shortlist per chain.
 */
app.http('match-item', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/match',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const rawItem = req.query.get('item');
    if (!rawItem) throw new HttpError(400, 'missing_item', 'item query parameter is required');
    const chains = (req.query.get('chains') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const enabled = await query<{ id: string }>(`SELECT id FROM catalog.chains WHERE enabled`);
    const enabledIds = new Set(enabled.rows.map((r) => r.id));
    const target = (chains.length ? chains : [...enabledIds]).filter((c) => enabledIds.has(c));
    if (!target.length) throw new HttpError(400, 'no_chains', 'No enabled chains requested');

    // lexicon-resolved term + default aisle, so quick-added items normalise and
    // group exactly like generated lines do (UX-audit L1). matchItem still gets
    // the raw normalised item — user corrections are keyed on it.
    const norm = normaliseIngredient(rawItem);
    const { term, aisleGroupId } = await resolveLexicon(norm.item);
    const matches = await matchItem(norm.item, target, claims.userId);
    return json(200, { item: term, aisle_group_id: aisleGroupId, quantity: norm.quantity, unit: norm.unit, matches });
  }),
});
