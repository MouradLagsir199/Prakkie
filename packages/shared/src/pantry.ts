import { z } from 'zod';

/** Pantry — spec §I. */

export const PantryItem = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  household_id: z.string().uuid().nullable().default(null),
  name: z.string(),
  item_normalised: z.string().nullable().default(null),
  quantity: z.number().positive().nullable().default(null),
  unit: z.string().nullable().default(null),
  ean: z.string().nullable().default(null),
  source: z.enum(['manual', 'purchased', 'barcode']).default('manual'),
  expires_at: z.string().date().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type PantryItem = z.infer<typeof PantryItem>;
