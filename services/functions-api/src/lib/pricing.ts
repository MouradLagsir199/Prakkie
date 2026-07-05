import { normaliseIngredient, normaliseUnit, reconcilePackSize } from '@prakkie/matching';
import type { PoolClient } from 'pg';
import { query } from './db';
import { matchItem, resolveLexicon, type MatchCandidate } from './match';

/**
 * WS5 pricing core: list generation from recipes (G1/G2), per-chain list
 * pricing with pack-size reconciliation (G7/E3), basket comparison (F2) and
 * deals (F3). All money in integer cents; no fake totals — unmatched items are
 * reported, never silently priced.
 */

export interface GeneratedLine {
  name: string;
  quantity: number | null;
  unit: string | null;
  item_normalised: string;
  aisle_group_id: number | null;
  provenance: { recipe_id: string; title: string; servings: number; quantity: number | null; unit: string | null }[];
}

interface RecipeRow {
  id: string;
  title: string;
  servings_base: number;
  ingredients: { raw_text?: string; quantity?: number | null; unit?: string | null; item_normalised?: string | null }[];
}

/** Scale + normalise + merge the ingredients of the given recipes into list lines. */
export async function generateLines(
  recipes: { recipe_id: string; servings: number }[],
  userId: string
): Promise<GeneratedLine[]> {
  const ids = recipes.map((r) => r.recipe_id);
  const rows = await query<RecipeRow>(
    `SELECT id, title, servings_base, ingredients FROM app.recipes
     WHERE id = ANY($2) AND deleted_at IS NULL AND (owner_id = $1 OR household_id IN (
       SELECT household_id FROM app.household_members WHERE user_id = $1))`,
    [userId, ids]
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  const merged = new Map<string, GeneratedLine>();
  for (const { recipe_id, servings } of recipes) {
    const recipe = byId.get(recipe_id);
    if (!recipe) continue;
    const factor = servings / (recipe.servings_base || 1);
    for (const ing of recipe.ingredients ?? []) {
      const norm = normaliseIngredient(ing.raw_text ?? ing.item_normalised ?? '');
      const item = ing.item_normalised || norm.item;
      if (!item) continue;
      const { term, aisleGroupId } = await resolveLexicon(item);
      const qty = (ing.quantity ?? norm.quantity) !== null ? (ing.quantity ?? norm.quantity)! * factor : null;
      const unit = ing.unit ?? norm.unit;

      const existing = merged.get(term);
      const prov = { recipe_id, title: recipe.title, servings, quantity: qty, unit };
      if (!existing) {
        merged.set(term, {
          name: term,
          quantity: qty,
          unit,
          item_normalised: term,
          aisle_group_id: aisleGroupId,
          provenance: [prov],
        });
        continue;
      }
      existing.provenance.push(prov);
      // merge quantities when both convert to the same base unit (G2)
      if (existing.quantity !== null && qty !== null && existing.unit && unit) {
        const a = normaliseUnit(existing.unit, existing.quantity);
        const b = normaliseUnit(unit, qty);
        if (a && b && a.unit === b.unit) {
          existing.quantity = a.value + b.value;
          existing.unit = a.unit === 'st' ? 'stuks' : a.unit;
          continue;
        }
      }
      if (existing.unit === unit && existing.quantity !== null && qty !== null) {
        existing.quantity += qty;
      } else if (qty !== null && existing.quantity === null) {
        existing.quantity = qty;
        existing.unit = unit;
      } // incompatible units: keep first, provenance still records both
    }
  }
  return [...merged.values()];
}

export interface PricedLine {
  item_id: string;
  name: string;
  matched: boolean;
  sku_id?: string;
  product_name?: string;
  confidence?: number;
  needs_review?: boolean;
  packs?: number;
  fits_exactly?: boolean;
  line_price_cents?: number;
  fractional_cents?: number;
  promo?: unknown;
  promo_savings_cents?: number;
}

export interface ChainPricing {
  chain_id: string;
  total_cents: number;
  fractional_total_cents: number;
  promo_savings_cents: number;
  matched: number;
  unmatched: string[];
  full_assortment: boolean;
  staleness: string | null; // "prijzen van {date}" source timestamp
  lines: PricedLine[];
}

interface ListItemRow {
  id: string;
  name: string;
  quantity: string | null;
  unit: string | null;
  item_normalised: string | null;
  matches: Record<string, { sku_id: string; confidence: number; user_pinned?: boolean }>;
}

function neededBase(item: ListItemRow): { value: number; unit: string } | null {
  if (item.quantity === null || !item.unit) return null;
  const canon = normaliseUnit(item.unit, Number(item.quantity));
  return canon ? { value: canon.value, unit: canon.unit } : null;
}

function packBase(p: MatchCandidate): { value: number; unit: string } | null {
  if (p.pack_size_value === null || !p.pack_size_unit) return null;
  const map: Record<string, { f: number; u: string }> = {
    g: { f: 1, u: 'g' }, kg: { f: 1000, u: 'g' }, ml: { f: 1, u: 'ml' }, l: { f: 1000, u: 'ml' },
    stuks: { f: 1, u: 'st' },
  };
  const m = map[p.pack_size_unit];
  return m ? { value: Number(p.pack_size_value) * m.f, unit: m.u } : null;
}

function activePromoPrice(p: MatchCandidate): number | null {
  if (p.promo_price_cents === null || p.promo_price_cents === undefined) return null;
  const promo = p.promo as { valid_to?: string } | null;
  if (promo?.valid_to && new Date(promo.valid_to) < new Date()) return null;
  return Number(p.promo_price_cents);
}

/** Price one list across chains; persists newly computed matches on the items. */
export async function priceList(
  listId: string,
  chainIds: string[],
  userId: string,
  client?: Pick<PoolClient, 'query'>
): Promise<ChainPricing[]> {
  const q = client ?? { query };
  const items = (
    await q.query(
      `SELECT i.id, i.name, i.quantity, i.unit, i.item_normalised, i.matches
       FROM app.list_items i WHERE i.list_id = $1 AND i.deleted_at IS NULL AND i.checked = false`,
      [listId]
    )
  ).rows as ListItemRow[];

  const chains = (
    await q.query(
      `SELECT id, full_assortment, enabled, last_ingest_at FROM catalog.chains WHERE id = ANY($1)`,
      [chainIds]
    )
  ).rows as { id: string; full_assortment: boolean; enabled: boolean; last_ingest_at: string | null }[];
  const enabledChains = chains.filter((c) => c.enabled);

  // resolve matches (batched; reuse stored ones, match the rest in parallel-ish)
  const skuNeeds = new Map<string, Set<string>>(); // chain → skus to hydrate
  const itemMatches = new Map<string, Map<string, { sku_id: string; confidence: number; source?: string }>>();
  for (const item of items) {
    const map = new Map<string, { sku_id: string; confidence: number }>();
    for (const [chain, m] of Object.entries(item.matches ?? {})) {
      if (m?.sku_id) map.set(chain, m);
    }
    itemMatches.set(item.id, map);
  }

  const candidateCache = new Map<string, MatchCandidate>(); // `${chain}:${sku}` → product
  for (const item of items) {
    const have = itemMatches.get(item.id)!;
    const missing = enabledChains.map((c) => c.id).filter((c) => !have.has(c));
    if (missing.length) {
      const term = item.item_normalised || normaliseIngredient(item.name).item;
      const result = await matchItem(term, missing, userId, client);
      const stored = { ...(item.matches ?? {}) } as Record<string, unknown>;
      for (const chain of missing) {
        const best = result[chain]?.best;
        if (best) {
          have.set(chain, { sku_id: best.sku_id, confidence: best.confidence });
          stored[chain] = { sku_id: best.sku_id, confidence: best.confidence };
          candidateCache.set(`${chain}:${best.sku_id}`, best);
        }
      }
      await q.query(`UPDATE app.list_items SET matches = $2 WHERE id = $1`, [item.id, JSON.stringify(stored)]);
    }
    for (const [chain, m] of have) {
      if (!candidateCache.has(`${chain}:${m.sku_id}`)) {
        (skuNeeds.get(chain) ?? skuNeeds.set(chain, new Set()).get(chain)!).add(m.sku_id);
      }
    }
  }
  for (const [chain, skus] of skuNeeds) {
    const r = await q.query(
      `SELECT chain_id, sku_id, name, brand, price_cents, promo_price_cents, promo,
              unit_price_cents_per_std, std_unit, pack_size_value, pack_size_unit,
              image_url, product_url, aisle_group_id
       FROM catalog.products WHERE chain_id = $1 AND sku_id = ANY($2)`,
      [chain, [...skus]]
    );
    for (const row of r.rows) {
      candidateCache.set(`${chain}:${row.sku_id}`, { ...row, confidence: 0, source: 'trgm' } as MatchCandidate);
    }
  }

  return enabledChains.map((chain) => {
    const lines: PricedLine[] = [];
    let total = 0;
    let fractional = 0;
    let savings = 0;
    const unmatched: string[] = [];
    for (const item of items) {
      const m = itemMatches.get(item.id)!.get(chain.id);
      const product = m ? candidateCache.get(`${chain.id}:${m.sku_id}`) : undefined;
      if (!m || !product) {
        unmatched.push(item.name);
        lines.push({ item_id: item.id, name: item.name, matched: false });
        continue;
      }
      const promoPrice = activePromoPrice(product);
      const unitPrice = promoPrice ?? Number(product.price_cents);
      const needed = neededBase(item);
      const pack = packBase(product);
      let packs = 1;
      let linePrice = unitPrice;
      let frac = unitPrice;
      let fits = false;
      if (needed && pack && needed.unit === pack.unit) {
        const fit = reconcilePackSize({ neededValue: needed.value, packValue: pack.value, packPriceCents: unitPrice });
        packs = fit.packsToBuy;
        linePrice = fit.totalPriceCents;
        frac = fit.fractionalCostCents;
        fits = fit.fitsExactly;
      } else if (needed && needed.unit === 'st') {
        packs = Math.max(1, Math.ceil(needed.value));
        linePrice = packs * unitPrice;
        frac = linePrice;
      }
      const lineSavings = promoPrice !== null ? packs * (Number(product.price_cents) - promoPrice) : 0;
      total += linePrice;
      fractional += frac;
      savings += lineSavings;
      lines.push({
        item_id: item.id,
        name: item.name,
        matched: true,
        sku_id: product.sku_id,
        product_name: product.name,
        confidence: m.confidence,
        needs_review: m.confidence < 0.72,
        packs,
        fits_exactly: fits,
        line_price_cents: linePrice,
        fractional_cents: frac,
        promo: promoPrice !== null ? product.promo : null,
        promo_savings_cents: lineSavings,
      });
    }
    return {
      chain_id: chain.id,
      total_cents: total,
      fractional_total_cents: fractional,
      promo_savings_cents: savings,
      matched: lines.filter((l) => l.matched).length,
      unmatched,
      full_assortment: chain.full_assortment,
      staleness: chain.last_ingest_at,
      lines,
    };
  });
}
