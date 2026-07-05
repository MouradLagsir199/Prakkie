import { z } from 'zod';

/** Meal planning — spec §H, mockup 05 is the contract. */

export const MealSlot = z.enum(['dinner', 'lunch', 'breakfast']);
export type MealSlot = z.infer<typeof MealSlot>;

export const PlanEntry = z.object({
  id: z.string().uuid(),
  plan_id: z.string().uuid(),
  recipe_id: z.string().uuid(),
  /** null = the "Zonder datum · deze week nog inplannen" parking strip (spec §H3). */
  entry_date: z.string().date().nullable().default(null),
  meal_slot: MealSlot.default('dinner'),
  servings: z.number().int().positive(),
  sort_order: z.number().int().default(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type PlanEntry = z.infer<typeof PlanEntry>;

export const WeekPlan = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  household_id: z.string().uuid().nullable().default(null),
  /** Monday of the ISO week this plan covers. */
  week_start: z.string().date(),
  applied_template_id: z.string().uuid().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type WeekPlan = z.infer<typeof WeekPlan>;

export const PlanTemplateEntry = z.object({
  /** 0 = Monday … 6 = Sunday; null = undated strip. */
  weekday: z.number().int().min(0).max(6).nullable(),
  meal_slot: MealSlot.default('dinner'),
  recipe_id: z.string().uuid(),
  servings: z.number().int().positive(),
});

export const PlanTemplate = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  household_id: z.string().uuid().nullable().default(null),
  /** "Standaard week" — sjabloon (spec §H4). */
  name: z.string(),
  entries: z.array(PlanTemplateEntry).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type PlanTemplate = z.infer<typeof PlanTemplate>;
