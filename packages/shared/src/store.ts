import { z } from 'zod';

/**
 * Virtuele supermarkt (plan/12): het API-contract van de winkel-registry.
 * Afdelingen en panelen zijn gecureerde catalogus-data (migratie 0029 +
 * seed-store-categories.mjs); de aggregaten komen uit store_category_stats
 * (nachtelijk ververst) zodat een scene-load één goedkope query is.
 */

/** Visueel thema van een afdeling — bepaalt de scene-sfeer client-side. */
export const StoreTheme = z.enum(['produce', 'bakery', 'fridge', 'freezer', 'dry', 'nonfood']);
export type StoreTheme = z.infer<typeof StoreTheme>;

/** Fixture waarin een paneel in de scene hangt (spec §10–13). */
export const FixtureType = z.enum(['shelf', 'fridge', 'freezer', 'produce', 'bakery', 'endcap']);
export type FixtureType = z.infer<typeof FixtureType>;

/** Eén subcategorie binnen een categorie (GET /v1/store/department/{id}).
 *  Aggregaten zijn over de gevráágde ketens; product_count 0 = paneel bestaat
 *  maar heeft bij jouw supers nu niets (state "tijdelijk leeg", spec §10.3). */
export const StorePanel = z.object({
  id: z.number().int(),
  slug: z.string(),
  name_nl: z.string(),
  fixture_type: FixtureType,
  sort: z.number().int(),
  image_url: z.string().nullable().default(null),
  product_count: z.number().int(),
  min_price_cents: z.number().int().nullable().default(null),
  chain_count: z.number().int(),
  promo_count: z.number().int(),
});
export type StorePanel = z.infer<typeof StorePanel>;

/** Sorteringen van de paneel-productlijst (spec §14.3). */
export const StorePanelSort = z.enum(['aanbevolen', 'prijs', 'eenheidsprijs', 'bonus']);
export type StorePanelSort = z.infer<typeof StorePanelSort>;

/** Categorie-kaart op de Boodschappen-home (GET /v1/store/discover) —
 *  een afdeling mét representatieve productfoto uit haar best gevulde paneel. */
export const DiscoverCategory = z.object({
  id: z.number().int(),
  slug: z.string(),
  name_nl: z.string(),
  theme: StoreTheme,
  sort: z.number().int(),
  panel_count: z.number().int(),
  product_count: z.number().int(),
  promo_count: z.number().int(),
  image_url: z.string().nullable().default(null),
});
export type DiscoverCategory = z.infer<typeof DiscoverCategory>;

/** "Aanbevolen voor jou"-kaart: één basisproduct in de bonus, geaggregeerd
 *  over de ketens van de user — vanaf-prijs + aantal lopende aanbiedingen. */
export const DiscoverProduct = z.object({
  head_term: z.string(),
  /** keten van de vanaf-prijs (goedkoopste aanbieding) */
  chain: z.string(),
  /** keten van het getoonde product zelf — hierop pint de +-knop */
  rep_chain: z.string(),
  sku_id: z.string(),
  name: z.string(),
  brand: z.string().nullable().default(null),
  price_cents: z.number().int(),
  promo_price_cents: z.number().int().nullable().default(null),
  pack_size_value: z.number().nullable().default(null),
  pack_size_unit: z.string().nullable().default(null),
  unit_price_cents_per_std: z.number().int().nullable().default(null),
  std_unit: z.string().nullable().default(null),
  image_url: z.string().nullable().default(null),
  /** lopende aanbiedingen voor dit product over alle gekozen ketens;
   *  0 = geen bonusdata → dit is een vergelijk-loont-aanrader (fallback) */
  offer_count: z.number().int(),
  chain_count: z.number().int(),
  min_price_cents: z.number().int(),
});
export type DiscoverProduct = z.infer<typeof DiscoverProduct>;
