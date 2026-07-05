import type { ChainId } from './chains';

/**
 * Chain-agnostic aisle taxonomy (~20 groups) with per-chain ordering profiles
 * ("AH-indeling", "Jumbo-indeling") — docs/02 §3, drives shopping-list sort (spec §G3).
 * Names are uppercase Dutch exactly as the mockup-06 section headers render them.
 */

export interface AisleGroup {
  id: number;
  slug: string;
  nameNl: string;
  defaultSort: number;
}

export const AISLE_GROUPS: AisleGroup[] = [
  { id: 1, slug: 'groente-fruit', nameNl: 'GROENTE & FRUIT', defaultSort: 1 },
  { id: 2, slug: 'zuivel-eieren', nameNl: 'ZUIVEL & EIEREN', defaultSort: 2 },
  { id: 3, slug: 'vlees-vis', nameNl: 'VLEES & VIS', defaultSort: 3 },
  { id: 4, slug: 'vega-plantaardig', nameNl: 'VEGA & PLANTAARDIG', defaultSort: 4 },
  { id: 5, slug: 'kaas-vleeswaren', nameNl: 'KAAS & VLEESWAREN', defaultSort: 5 },
  { id: 6, slug: 'brood-banket', nameNl: 'BROOD & BANKET', defaultSort: 6 },
  { id: 7, slug: 'ontbijt-beleg', nameNl: 'ONTBIJT & BELEG', defaultSort: 7 },
  { id: 8, slug: 'pasta-rijst-wereld', nameNl: 'PASTA, RIJST & WERELDKEUKEN', defaultSort: 8 },
  { id: 9, slug: 'conserven-soepen', nameNl: 'CONSERVEN & SOEPEN', defaultSort: 9 },
  { id: 10, slug: 'kruiden-sauzen-olie', nameNl: 'KRUIDEN, SAUZEN & OLIE', defaultSort: 10 },
  { id: 11, slug: 'bakken-zoet', nameNl: 'BAKPRODUCTEN & ZOET', defaultSort: 11 },
  { id: 12, slug: 'snoep-koek', nameNl: 'SNOEP & KOEK', defaultSort: 12 },
  { id: 13, slug: 'chips-noten', nameNl: 'CHIPS & NOTEN', defaultSort: 13 },
  { id: 14, slug: 'diepvries', nameNl: 'DIEPVRIES', defaultSort: 14 },
  { id: 15, slug: 'dranken-sappen', nameNl: 'DRANKEN & SAPPEN', defaultSort: 15 },
  { id: 16, slug: 'koffie-thee', nameNl: 'KOFFIE & THEE', defaultSort: 16 },
  { id: 17, slug: 'bier-wijn', nameNl: 'BIER & WIJN', defaultSort: 17 },
  { id: 18, slug: 'drogisterij-verzorging', nameNl: 'DROGISTERIJ & VERZORGING', defaultSort: 18 },
  { id: 19, slug: 'huishouden-non-food', nameNl: 'HUISHOUDEN & NON-FOOD', defaultSort: 19 },
  { id: 20, slug: 'overig', nameNl: 'OVERIG', defaultSort: 20 },
];

export const OVERIG_GROUP_ID = 20;

/**
 * Per-chain ordering profiles: aisle_group_id → sort position for that chain's
 * store layout. Seeded for AH (the reference "AH-indeling"); other chains start
 * from the default order until their profile is tuned during WS2.
 */
export type ChainAisleProfile = Partial<Record<ChainId, number[]>>;

/** Ordered aisle_group_ids per chain; chains not listed use defaultSort. */
export const CHAIN_AISLE_ORDER: ChainAisleProfile = {
  // AH store walk: produce first, then bakery, chilled, meat, …
  ah: [1, 6, 5, 3, 4, 2, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 14, 18, 19, 20],
};

export function aisleOrderForChain(chain: ChainId): AisleGroup[] {
  const order = CHAIN_AISLE_ORDER[chain];
  if (!order) return [...AISLE_GROUPS].sort((a, b) => a.defaultSort - b.defaultSort);
  const byId = new Map(AISLE_GROUPS.map((g) => [g.id, g]));
  const ordered = order.map((id) => byId.get(id)).filter((g): g is AisleGroup => g !== undefined);
  // Any group missing from the profile falls in at the end, before OVERIG-last rule.
  for (const g of AISLE_GROUPS) if (!order.includes(g.id)) ordered.push(g);
  return ordered;
}
