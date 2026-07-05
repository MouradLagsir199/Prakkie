import { z } from 'zod';
import { ChainId } from './chains';
import { ProductMatch } from './product';

/** Smart shopping list — spec §G, mockup 06 is the contract. */

export const ListItemProvenance = z.object({
  recipe_id: z.string().uuid(),
  recipe_title: z.string(),
  plan_entry_id: z.string().uuid().nullable().default(null),
  quantity: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
});
export type ListItemProvenance = z.infer<typeof ListItemProvenance>;

export const ListItem = z.object({
  id: z.string().uuid(),
  list_id: z.string().uuid(),
  name: z.string(),
  quantity: z.number().nullable().default(null),
  unit: z.string().nullable().default(null),
  item_normalised: z.string().nullable().default(null),
  /** User-overridable aisle group (spec §G3 — categories editable, items movable). */
  aisle_group_id: z.number().int().nullable().default(null),
  sort_order: z.number().int().default(0),
  /** Manually added lines are never touched by plan re-generation (spec §G4). */
  is_manual: z.boolean().default(false),
  /** Merge provenance — "samengevoegd: shakshuka (1) + nasi (2)" (spec §G2). */
  provenance: z.array(ListItemProvenance).default([]),
  /** Matched product per chain. */
  matches: z.record(z.string(), ProductMatch).default({}),
  checked: z.boolean().default(false),
  checked_by: z.string().uuid().nullable().default(null),
  checked_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ListItem = z.infer<typeof ListItem>;

export const ShoppingList = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  household_id: z.string().uuid().nullable().default(null),
  name: z.string(),
  /** Drives the "AH-indeling" layout chip (mockup 06). */
  layout_chain_id: ChainId.default('ah'),
  sort_order: z.number().int().default(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ShoppingList = z.infer<typeof ShoppingList>;
