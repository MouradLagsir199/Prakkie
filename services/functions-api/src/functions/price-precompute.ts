import { app } from '@azure/functions';
import { normaliseIngredient, normaliseUnit, reconcilePackSize } from '@prakkie/matching';
import { query } from '../lib/db';
import { matchItem, type MatchCandidate } from '../lib/match';

/**
 * Nightly price-per-portion precompute (WS7 badge pipeline + F1 library
 * badges). User-agnostic (no corrections): fractional ingredient cost per
 * chain / servings. Honest: recipes whose ingredients mostly don't match get
 * missing_count, not a made-up number.
 */

interface Ing { raw_text?: string; item_normalised?: string | null; quantity?: number | null; unit?: string | null }

async function pricePerPortion(
  ingredients: Ing[],
  servings: number,
  chains: string[]
): Promise<Record<string, { cents: number; missing: number; hasBonus: boolean }>> {
  const out: Record<string, { cents: number; missing: number; hasBonus: boolean }> = {};
  for (const c of chains) out[c] = { cents: 0, missing: 0, hasBonus: false };
  for (const ing of ingredients) {
    const norm = normaliseIngredient(ing.raw_text ?? ing.item_normalised ?? '');
    const item = ing.item_normalised || norm.item;
    if (!item) continue;
    const matches = await matchItem(item, chains, null);
    for (const chain of chains) {
      const best = matches[chain]?.best;
      const slot = out[chain]!;
      if (!best) {
        slot.missing++;
        continue;
      }
      slot.cents += fractionalCents(best, ing.quantity ?? norm.quantity, ing.unit ?? norm.unit);
      if (best.promo) slot.hasBonus = true;
    }
  }
  for (const chain of chains) out[chain]!.cents = Math.round(out[chain]!.cents / Math.max(1, servings));
  return out;
}

function fractionalCents(p: MatchCandidate, quantity: number | null, unit: string | null): number {
  const price = p.promo_price_cents ?? p.price_cents;
  if (quantity == null || !unit) return Number(price) * 0.5; // unknown amount: half a pack heuristic
  const canon = normaliseUnit(unit, quantity);
  const packMap: Record<string, { f: number; u: string }> = {
    g: { f: 1, u: 'g' }, kg: { f: 1000, u: 'g' }, ml: { f: 1, u: 'ml' }, l: { f: 1000, u: 'ml' }, stuks: { f: 1, u: 'st' },
  };
  const pk = p.pack_size_unit ? packMap[p.pack_size_unit] : undefined;
  if (!canon || !pk || p.pack_size_value == null || canon.unit !== pk.u) return Number(price) * 0.5;
  return reconcilePackSize({
    neededValue: canon.value,
    packValue: Number(p.pack_size_value) * pk.f,
    packPriceCents: Number(price),
  }).fractionalCostCents;
}

export async function runPricePrecompute(limit = 30): Promise<{ crawled: number; library: number }> {
  const chains = (await query<{ id: string }>(`SELECT id FROM catalog.chains WHERE enabled AND full_assortment`)).rows.map((r) => r.id);
  let crawled = 0;
  const rows = await query<{ id: string; recipe: { ingredients: Ing[]; servings_base?: number } }>(
    `SELECT cr.id, cr.recipe FROM discovery.crawled_recipes cr
     WHERE cr.dead_at IS NULL AND NOT EXISTS (
       SELECT 1 FROM discovery.recipe_prices rp WHERE rp.crawled_recipe_id = cr.id AND rp.computed_at > now() - interval '7 days')
     ORDER BY cr.first_seen_at DESC LIMIT $1`,
    [limit]
  );
  for (const row of rows.rows) {
    const priced = await pricePerPortion(row.recipe.ingredients ?? [], row.recipe.servings_base ?? 2, chains);
    for (const [chain, v] of Object.entries(priced)) {
      await query(
        `INSERT INTO discovery.recipe_prices (crawled_recipe_id, chain_id, price_per_portion_cents, missing_count, deal_overlap_count, computed_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (crawled_recipe_id, chain_id) DO UPDATE SET
           price_per_portion_cents = EXCLUDED.price_per_portion_cents, missing_count = EXCLUDED.missing_count,
           deal_overlap_count = EXCLUDED.deal_overlap_count, computed_at = now()`,
        [row.id, chain, v.missing > 2 ? null : v.cents, v.missing, v.hasBonus ? 1 : 0]
      );
    }
    crawled++;
  }

  // F1: library card badges via recipes.price_cache (cheapest complete chain)
  let library = 0;
  const recipes = await query<{ id: string; ingredients: Ing[]; servings_base: number }>(
    `SELECT id, ingredients, servings_base FROM app.recipes
     WHERE deleted_at IS NULL AND (price_cache IS NULL OR (price_cache->>'computed_at')::timestamptz < now() - interval '24 hours')
     ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  for (const r of recipes.rows) {
    const priced = await pricePerPortion(r.ingredients ?? [], r.servings_base ?? 2, chains);
    const complete = Object.values(priced).filter((v) => v.missing === 0);
    const cheapest = complete.sort((a, b) => a.cents - b.cents)[0] ?? null;
    await query(`UPDATE app.recipes SET price_cache = $2 WHERE id = $1`, [
      r.id,
      JSON.stringify({
        per_portion_cents: cheapest?.cents ?? null,
        has_bonus: Object.values(priced).some((v) => v.hasBonus),
        computed_at: new Date().toISOString(),
      }),
    ]);
    library++;
  }
  return { crawled, library };
}

app.timer('price-precompute-nightly', {
  schedule: '0 15 4 * * *',
  handler: async (_t, ctx) => {
    const result = await runPricePrecompute(100);
    ctx.log(`price-precompute: ${JSON.stringify(result)}`);
  },
});

app.http('price-precompute-run', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'ops/price-precompute',
  handler: async (req) => {
    const body = (await req.json().catch(() => ({}))) as { limit?: number };
    return { status: 200, jsonBody: await runPricePrecompute(body.limit ?? 30) };
  },
});
