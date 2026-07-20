import { app } from '@azure/functions';
import { normaliseIngredient } from '@prakkie/matching';
import { matchesPackQuantity, parsePackQuantityQuery } from '@prakkie/shared';
import { HttpError, handler, json, requireAuth } from '../lib/http';
import { matchItem, resolveLexicon, type MatchCandidate } from '../lib/match';
import { query } from '../lib/db';

const PIN_FETCH_SQL = `
  SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents, p.promo,
         p.unit_price_cents_per_std, p.std_unit, p.pack_size_value, p.pack_size_unit,
         p.image_url, p.product_url, p.aisle_group_id
  FROM catalog.products p
  WHERE p.chain_id = $1 AND p.sku_id = $2`;

/**
 * Garandeer dat een al-gekozen product (bv. via de AI-resolver, die een ruimer
 * kandidatenbereik gebruikt dan deze fuzzy matcher) altijd in de shortlist zit
 * — anders krijgt de picker-sheet niets om als "gekozen" te markeren, terwijl
 * de keuze wél echt is opgeslagen (owner-bug 2026-07-08, "Jumbo bruin brood
 * toont geen vinkje"). Ontbreekt hij, dan wordt hij er direct bij gehaald en
 * vooraan gezet — bovenaan, met de échte productnaam.
 */
async function ensurePinned(
  matches: Record<string, { best: MatchCandidate | null; shortlist: MatchCandidate[] }>,
  pinned: { chain: string; sku: string }[]
): Promise<void> {
  for (const { chain, sku } of pinned) {
    const chainMatch = matches[chain];
    if (!chainMatch) continue;
    const already = chainMatch.shortlist.find((c) => c.sku_id === sku);
    if (already) {
      // al aanwezig — alleen vooraan zetten
      chainMatch.shortlist = [already, ...chainMatch.shortlist.filter((c) => c.sku_id !== sku)];
      continue;
    }
    const r = await query<Omit<MatchCandidate, 'confidence' | 'source' | 'is_primary'>>(PIN_FETCH_SQL, [chain, sku]);
    const row = r.rows[0];
    if (!row) continue; // product bestaat niet meer (uit assortiment) — niets te tonen
    const pinnedCandidate: MatchCandidate = { ...row, confidence: 1, source: 'correction', is_primary: true };
    chainMatch.shortlist = [pinnedCandidate, ...chainMatch.shortlist];
  }
}

/**
 * GET /v1/match?item=<raw or normalised>&chains=ah,jumbo&pinned=ah:12345,jumbo:678ZK
 * The match-fix / shortlist entrance (E5): returns best + shortlist per chain.
 * `pinned` (optional): chain:sku pairs already chosen for this item — always
 * included in that chain's shortlist, at the front, with the real product data.
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
    const pinned = (req.query.get('pinned') ?? '')
      .split(',')
      .map((pair) => {
        const i = pair.indexOf(':');
        return i > 0 ? { chain: pair.slice(0, i).trim(), sku: pair.slice(i + 1).trim() } : null;
      })
      .filter((p): p is { chain: string; sku: string } => !!p && target.includes(p.chain) && !!p.sku);

    // lexicon-resolved term + default aisle, so quick-added items normalise and
    // group exactly like generated lines do (UX-audit L1). matchItem still gets
    // the raw normalised item — user corrections are keyed on it.
    const norm = normaliseIngredient(rawItem);
    const { term, aisleGroupId } = await resolveLexicon(norm.item);
    const matches = await matchItem(norm.item, target, claims.userId);
    if (pinned.length) await ensurePinned(matches, pinned);
    const requestedPack = parsePackQuantityQuery(rawItem).quantity;
    if (requestedPack) {
      for (const match of Object.values(matches)) {
        match.shortlist = match.shortlist.filter((candidate) =>
          matchesPackQuantity(candidate, requestedPack)
        );
        match.best = match.shortlist[0] ?? null;
      }
    }
    return json(200, { item: term, aisle_group_id: aisleGroupId, quantity: norm.quantity, unit: norm.unit, matches });
  }),
});
