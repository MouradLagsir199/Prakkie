import { z } from 'zod';
import { ChainId } from './chains';

/** Product schema — docs/02_supermarket_data_sources.md §3. Provider-agnostic by design. */

export const PromoMechanic = z.object({
  /** e.g. "bonus", "aanbieding", "actie" */
  type: z.string(),
  price_cents: z.number().int().nonnegative().nullable().default(null),
  /** Human mechanic as the chain words it: "Bonus 25%", "1+1 gratis", "2e halve prijs". */
  mechanic: z.string(),
  valid_from: z.string().date().nullable().default(null),
  valid_to: z.string().date().nullable().default(null),
});
export type PromoMechanic = z.infer<typeof PromoMechanic>;

export const StdUnit = z.enum(['kg', 'l', 'st']);
export type StdUnit = z.infer<typeof StdUnit>;

export const Product = z.object({
  chain: ChainId,
  sku_id: z.string(),
  ean: z.string().nullable().default(null),
  name: z.string(),
  brand: z.string().nullable().default(null),
  pack_size_value: z.number().positive().nullable().default(null),
  /** "g" | "kg" | "ml" | "l" | "st" — as the chain lists it. */
  pack_size_unit: z.string().nullable().default(null),
  price_cents: z.number().int().nonnegative(),
  /** Per kg / l / stuk — for honest cross-pack comparison. */
  unit_price_cents_per_std: z.number().int().nonnegative().nullable().default(null),
  std_unit: StdUnit.nullable().default(null),
  promo: PromoMechanic.nullable().default(null),
  /** Chain's own taxonomy path — mapped to our aisle taxonomy via chain_category_map. */
  category_path: z.array(z.string()).default([]),
  aisle_group_id: z.number().int().nullable().default(null),
  image_url: z.string().url().nullable().default(null),
  product_url: z.string().url().nullable().default(null),
  available: z.boolean().default(true),
  fetched_at: z.string().datetime(),
});
export type Product = z.infer<typeof Product>;

/** A product matched to an ingredient line, with confidence + pack-fit info (spec §E3/E6). */
export const ProductMatch = z.object({
  chain: ChainId,
  sku_id: z.string(),
  confidence: z.number().min(0).max(1),
  /** Pinned by the user via the shortlist — wins over any automatic match (spec §E5). */
  user_pinned: z.boolean().default(false),
  packs_to_buy: z.number().int().positive().default(1),
  /** Leftover after the recipe need is covered, in the product's pack unit. 0 ⇒ "pakt precies". */
  leftover_value: z.number().nonnegative().nullable().default(null),
  leftover_unit: z.string().nullable().default(null),
  total_price_cents: z.number().int().nonnegative(),
});
export type ProductMatch = z.infer<typeof ProductMatch>;
