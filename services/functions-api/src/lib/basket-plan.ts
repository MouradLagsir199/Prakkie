import { query } from './db';

/**
 * Basket-plan (matching v2, docs/09 Fase 4+6). Read-only, additief naast de
 * bestaande EAN-only pricing: gebruikt de canonical product graph om elk
 * lijst-item (via zijn ankerproduct) te vertalen naar het goedkoopste
 * equivalent per keten, en levert een eerlijk direct totaal + de basket-
 * optimizer (goedkoopste enkele winkel / split / besparing).
 *
 * De vier-uitgangen-funnel: EXACT (zelfde EAN) en EQUIVALENT (canonieke sibling)
 * tellen in het totaal; COMPROMISE (wel iets in de categorie, geen equivalent)
 * en NO_MATCH (niets) vormen de "nog te kiezen"-wachtrij. Niets wordt
 * weggeschreven — de client past keuzes pas expliciet toe.
 */

export type LineDecision = 'exact' | 'equivalent' | 'compromise' | 'no_match';

export interface CandidatePrice {
  chain_id: string;
  sku_id: string;
  name: string;
  price_cents: number;
  is_exact: boolean;
  confidence: number;
  reasons: string[];
}

export interface PlanItemInput {
  item_id: string;
  name: string;
  canonical_id: string | null;
  /** goedkoopste kandidaat per keten (al gereduceerd) */
  candidates: Record<string, CandidatePrice | undefined>;
  /** heeft de keten wél iets in dezelfde categorie (→ COMPROMISE i.p.v. NO_MATCH)? */
  categoryHasAlt: Record<string, boolean>;
}

export interface PlanLine {
  item_id: string;
  name: string;
  decision_by_chain: Record<string, LineDecision>;
  price_by_chain: Record<string, number | null>;
  reason_by_chain: Record<string, string>;
}

export interface ChainTotal {
  chain_id: string;
  total_cents: number;
  matched: number;
  missing: number;
  complete: boolean;
}

export interface BasketOptimizer {
  cheapest_single: { chain_id: string; total_cents: number; missing: number } | null;
  split: { total_cents: number; by_chain: Record<string, number>; assignments: Record<string, string>; missing: number } | null;
  savings_vs_single_cents: number;
}

export interface BasketPlan {
  list_id: string;
  chains: readonly string[];
  lines: PlanLine[];
  chain_totals: ChainTotal[];
  optimizer: BasketOptimizer;
  matcher_version: string;
}

// ---- pure logica (unit-getest, geen DB) --------------------------------------

const REASON_NL: Record<LineDecision, string> = {
  exact: 'identiek product (zelfde EAN)',
  equivalent: 'gelijkwaardig alternatief',
  compromise: 'geen gelijkwaardig alternatief — kies zelf',
  no_match: 'niet beschikbaar bij deze keten',
};

export function classifyLine(item: PlanItemInput, chain: string): { decision: LineDecision; price: number | null; reason: string } {
  const cand = item.candidates[chain];
  if (cand) {
    const decision: LineDecision = cand.is_exact ? 'exact' : 'equivalent';
    const reason = cand.reasons.length ? `${REASON_NL[decision]} · ${cand.reasons.join(' · ')}` : REASON_NL[decision];
    return { decision, price: cand.price_cents, reason };
  }
  const decision: LineDecision = item.categoryHasAlt[chain] ? 'compromise' : 'no_match';
  return { decision, price: null, reason: REASON_NL[decision] };
}

export function buildLines(items: PlanItemInput[], chains: readonly string[]): PlanLine[] {
  return items.map((item) => {
    const decision_by_chain: Record<string, LineDecision> = {};
    const price_by_chain: Record<string, number | null> = {};
    const reason_by_chain: Record<string, string> = {};
    for (const chain of chains) {
      const { decision, price, reason } = classifyLine(item, chain);
      decision_by_chain[chain] = decision;
      price_by_chain[chain] = price;
      reason_by_chain[chain] = reason;
    }
    return { item_id: item.item_id, name: item.name, decision_by_chain, price_by_chain, reason_by_chain };
  });
}

const isMatched = (d: LineDecision) => d === 'exact' || d === 'equivalent';

export function buildChainTotals(lines: PlanLine[], chains: readonly string[]): ChainTotal[] {
  return chains.map((chain) => {
    let total = 0;
    let matched = 0;
    let missing = 0;
    for (const line of lines) {
      if (isMatched(line.decision_by_chain[chain]!)) {
        total += line.price_by_chain[chain] ?? 0;
        matched++;
      } else {
        missing++;
      }
    }
    return { chain_id: chain, total_cents: total, matched, missing, complete: lines.length > 0 && missing === 0 };
  });
}

export function optimizeBasket(lines: PlanLine[], chains: readonly string[]): BasketOptimizer {
  const totals = buildChainTotals(lines, chains);
  // Goedkoopste enkele winkel: eerst zo min mogelijk ontbrekend, dan laagste totaal.
  const cheapest_single = totals.length
    ? [...totals].sort((a, b) => a.missing - b.missing || a.total_cents - b.total_cents)[0]!
    : null;

  // Split: per regel de goedkoopste keten die dit item matcht.
  const by_chain: Record<string, number> = {};
  const assignments: Record<string, string> = {};
  let splitTotal = 0;
  let splitMissing = 0;
  for (const line of lines) {
    let best: { chain: string; price: number } | null = null;
    for (const chain of chains) {
      if (!isMatched(line.decision_by_chain[chain]!)) continue;
      const price = line.price_by_chain[chain];
      if (price != null && (!best || price < best.price)) best = { chain, price };
    }
    if (!best) { splitMissing++; continue; }
    splitTotal += best.price;
    assignments[line.item_id] = best.chain;
    by_chain[best.chain] = (by_chain[best.chain] ?? 0) + best.price;
  }
  const split = lines.length ? { total_cents: splitTotal, by_chain, assignments, missing: splitMissing } : null;

  // Besparing van split t.o.v. de goedkoopste complete enkele winkel (eerlijk:
  // alleen vergelijken als beide alle regels dekken).
  let savings = 0;
  if (split && split.missing === 0 && cheapest_single && cheapest_single.complete) {
    savings = Math.max(0, cheapest_single.total_cents - split.total_cents);
  }
  return { cheapest_single: cheapest_single && { chain_id: cheapest_single.chain_id, total_cents: cheapest_single.total_cents, missing: cheapest_single.missing }, split, savings_vs_single_cents: savings };
}

export function assembleBasketPlan(listId: string, chains: readonly string[], items: PlanItemInput[], matcherVersion: string): BasketPlan {
  const lines = buildLines(items, chains);
  return {
    list_id: listId,
    chains,
    lines,
    chain_totals: buildChainTotals(lines, chains),
    optimizer: optimizeBasket(lines, chains),
    matcher_version: matcherVersion,
  };
}

// ---- data-ophaal (DB) --------------------------------------------------------

const MATCHER_VERSION = 'graph-v1';

interface ListItemRow { id: string; name: string; matches: Record<string, { sku_id?: string; user_pinned?: boolean; origin?: string; preferred?: boolean }> | null }
interface EffPriceRow { chain_id: string; sku_id: string; name: string; ean: string | null; price_cents: number; canonical_id: string; category: string | null; confidence: string; reasons: string[] }

/** Het ankerproduct van een item: de door de gebruiker gekozen sku. */
function anchorSkuOf(matches: ListItemRow['matches']): string | null {
  const entries = Object.values(matches ?? {}).filter((m) => m?.sku_id && (m.user_pinned || m.origin === 'user_confirmed' || m.origin === 'bulk_accepted'));
  return entries.find((m) => m.preferred)?.sku_id ?? entries[0]?.sku_id ?? null;
}

export async function planBasket(listId: string, chains: readonly string[]): Promise<BasketPlan> {
  const items = (await query<ListItemRow>(
    `SELECT id, name, matches FROM app.list_items
     WHERE list_id = $1 AND deleted_at IS NULL AND checked = false`,
    [listId]
  )).rows;

  const anchorByItem = new Map<string, string>();
  for (const it of items) {
    const sku = anchorSkuOf(it.matches);
    if (sku) anchorByItem.set(it.id, sku);
  }
  const anchorSkus = [...new Set([...anchorByItem.values()])];

  // Canonieke knoop + EAN per ankerproduct.
  const anchorRows = anchorSkus.length
    ? (await query<{ sku_id: string; canonical_id: string; ean: string | null }>(
        `SELECT cm.sku_id, cm.canonical_id, p.ean
         FROM catalog.canonical_member cm
         JOIN catalog.products p USING (chain_id, sku_id)
         WHERE cm.sku_id = ANY($1)`,
        [anchorSkus]
      )).rows
    : [];
  const canonicalBySku = new Map(anchorRows.map((r) => [r.sku_id, r.canonical_id]));
  const eanBySku = new Map(anchorRows.map((r) => [r.sku_id, r.ean]));
  const canonicalIds = [...new Set(anchorRows.map((r) => r.canonical_id))];

  // Alle siblings van die knopen in de doelketens, mét effectieve prijs.
  const siblingRows = canonicalIds.length
    ? (await query<EffPriceRow>(
        `SELECT cm.chain_id, cm.sku_id, p.name, p.ean,
                COALESCE(p.promo_price_cents, p.price_cents) AS price_cents,
                cm.canonical_id, pf.category, cm.confidence::text, cm.reasons
         FROM catalog.canonical_member cm
         JOIN catalog.products p USING (chain_id, sku_id)
         LEFT JOIN catalog.product_facets pf USING (chain_id, sku_id)
         WHERE cm.canonical_id = ANY($1) AND cm.chain_id = ANY($2)
           AND p.available AND p.price_cents IS NOT NULL`,
        [canonicalIds, chains]
      )).rows
    : [];

  // Reduceer tot de goedkoopste sibling per (canonical_id, chain).
  const cheapest = new Map<string, EffPriceRow>();
  const categoriesByCanonical = new Map<string, string>();
  for (const r of siblingRows) {
    if (r.category) categoriesByCanonical.set(r.canonical_id, r.category);
    const key = `${r.canonical_id}|${r.chain_id}`;
    const cur = cheapest.get(key);
    if (!cur || r.price_cents < cur.price_cents) cheapest.set(key, r);
  }

  // Welke ketens hebben überhaupt iets in de categorie (voor COMPROMISE)?
  const categories = [...new Set([...categoriesByCanonical.values()])];
  const catChainHas = new Set<string>();
  if (categories.length) {
    const rows = (await query<{ chain_id: string; category: string }>(
      `SELECT DISTINCT chain_id, category FROM catalog.product_facets
       WHERE verified AND category = ANY($1) AND chain_id = ANY($2)`,
      [categories, chains]
    )).rows;
    for (const r of rows) catChainHas.add(`${r.category}|${r.chain_id}`);
  }

  const planItems: PlanItemInput[] = items.map((it) => {
    const anchorSku = anchorByItem.get(it.id) ?? null;
    const canonicalId = anchorSku ? canonicalBySku.get(anchorSku) ?? null : null;
    const anchorEan = anchorSku ? eanBySku.get(anchorSku) ?? null : null;
    const category = canonicalId ? categoriesByCanonical.get(canonicalId) ?? null : null;
    const candidates: Record<string, CandidatePrice | undefined> = {};
    const categoryHasAlt: Record<string, boolean> = {};
    for (const chain of chains) {
      const row = canonicalId ? cheapest.get(`${canonicalId}|${chain}`) : undefined;
      candidates[chain] = row
        ? {
            chain_id: chain, sku_id: row.sku_id, name: row.name, price_cents: row.price_cents,
            is_exact: !!anchorEan && !!row.ean && normEan(anchorEan) === normEan(row.ean),
            confidence: Number(row.confidence), reasons: row.reasons ?? [],
          }
        : undefined;
      categoryHasAlt[chain] = !!category && catChainHas.has(`${category}|${chain}`);
    }
    return { item_id: it.id, name: it.name, canonical_id: canonicalId, candidates, categoryHasAlt };
  });

  return assembleBasketPlan(listId, chains, planItems, MATCHER_VERSION);
}

function normEan(ean: string | null): string | null {
  if (!ean) return null;
  const d = String(ean).replace(/\D/g, '').replace(/^0+/, '');
  return d.length ? d : null;
}
