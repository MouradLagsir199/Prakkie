import { z } from 'zod';
import { ChainId } from './chains';
import { DietFlag } from './recipe';

/** Accounts & settings — spec §A. */

export const Locale = z.enum(['nl', 'en']);
export const Units = z.enum(['metric', 'imperial']);
export const Tier = z.enum(['free', 'premium', 'lifetime']);

export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable().default(null),
  display_name: z.string().nullable().default(null),
  /** Guest mode: first import needs no account (spec §A1); upgraded in place, id preserved. */
  is_guest: z.boolean().default(false),
  locale: Locale.default('nl'),
  units: Units.default('metric'),
  default_servings: z.number().int().positive().default(2),
  diet_flags: z.array(DietFlag).default([]),
  /** Multi-select from the 11 chains (spec §A3); first entry = "jouw winkel". */
  home_chain_ids: z.array(ChainId).default(['ah']),
  tier: Tier.default('free'),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type User = z.infer<typeof User>;

export const Household = z.object({
  id: z.string().uuid(),
  name: z.string(),
  created_by: z.string().uuid(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Household = z.infer<typeof Household>;

export const HouseholdMember = z.object({
  household_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(['owner', 'member']),
  joined_at: z.string().datetime(),
});
export type HouseholdMember = z.infer<typeof HouseholdMember>;
