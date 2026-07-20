import { z } from 'zod';

/**
 * The eleven supported Dutch supermarket chains — the complete set per
 * docs/02_supermarket_data_sources.md §2. Chains without a public priced
 * assortment (Lidl, Nettorama, Boni, …) are out of scope by spec.
 */
export const CHAIN_IDS = [
  'ah',
  'jumbo',
  'plus',
  'dirk',
  'dekamarkt',
  'aldi',
  'vomar',
  'hoogvliet',
  'spar',
  'picnic',
  'ekoplaza',
] as const;

export const ChainId = z.enum(CHAIN_IDS);
export type ChainId = z.infer<typeof ChainId>;

export interface ChainInfo {
  id: ChainId;
  displayName: string;
  /** Two-letter chip shown in the Prijzen tab (mockup 07). */
  chip: string;
  /** One connector can serve multiple chains (Detailresult → dirk + dekamarkt). */
  connector: 'ah' | 'jumbo' | 'plus' | 'detailresult' | 'aldi' | 'vomar' | 'hoogvliet' | 'spar' | 'picnic' | 'ekoplaza';
  /** false ⇒ partial online assortment ⇒ "n items niet in assortiment" UX, never a fake total. */
  fullAssortment: boolean;
  /** Picnic has no product deep-links. */
  hasProductUrls: boolean;
}

export const CHAINS: Record<ChainId, ChainInfo> = {
  ah: { id: 'ah', displayName: 'Albert Heijn', chip: 'AH', connector: 'ah', fullAssortment: true, hasProductUrls: true },
  jumbo: { id: 'jumbo', displayName: 'Jumbo', chip: 'JU', connector: 'jumbo', fullAssortment: true, hasProductUrls: true },
  plus: { id: 'plus', displayName: 'Plus', chip: 'PL', connector: 'plus', fullAssortment: true, hasProductUrls: true },
  dirk: { id: 'dirk', displayName: 'Dirk van den Broek', chip: 'DI', connector: 'detailresult', fullAssortment: true, hasProductUrls: true },
  dekamarkt: { id: 'dekamarkt', displayName: 'DekaMarkt', chip: 'DE', connector: 'detailresult', fullAssortment: true, hasProductUrls: true },
  aldi: { id: 'aldi', displayName: 'Aldi', chip: 'AL', connector: 'aldi', fullAssortment: false, hasProductUrls: true },
  vomar: { id: 'vomar', displayName: 'Vomar', chip: 'VO', connector: 'vomar', fullAssortment: true, hasProductUrls: true },
  hoogvliet: { id: 'hoogvliet', displayName: 'Hoogvliet', chip: 'HO', connector: 'hoogvliet', fullAssortment: true, hasProductUrls: true },
  spar: { id: 'spar', displayName: 'Spar', chip: 'SP', connector: 'spar', fullAssortment: true, hasProductUrls: true },
  picnic: { id: 'picnic', displayName: 'Picnic', chip: 'PI', connector: 'picnic', fullAssortment: false, hasProductUrls: false },
  ekoplaza: { id: 'ekoplaza', displayName: 'Ekoplaza', chip: 'EK', connector: 'ekoplaza', fullAssortment: true, hasProductUrls: true },
};

export const DEFAULT_HOME_CHAIN: ChainId = 'ah';

/**
 * Chains with a live, seeded assortment (mirrors catalog.chains.enabled).
 * User-facing pickers offer only these; the rest show as "binnenkort"
 * (UX-audit C2). Vertical scaling flips a chain here once its connector runs.
 */
export const LIVE_CHAIN_IDS: readonly ChainId[] = [
  'ah',
  'jumbo',
  'plus',
  'dirk',
  'dekamarkt',
  'aldi',
  'vomar',
  'hoogvliet',
  'spar',
  'ekoplaza',
];
