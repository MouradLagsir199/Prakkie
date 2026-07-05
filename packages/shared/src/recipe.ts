import { z } from 'zod';

/** Canonical recipe schema — spec 01_functional_spec.md §B8. */

export const RecipeOrigin = z.enum(['import', 'manual', 'crawled', 'crawled_save', 'shared']);
export type RecipeOrigin = z.infer<typeof RecipeOrigin>;

export const SourcePlatform = z.enum(['instagram', 'tiktok', 'facebook', 'pinterest', 'youtube', 'blog']);
export type SourcePlatform = z.infer<typeof SourcePlatform>;

export const RecipeIngredient = z.object({
  raw_text: z.string(),
  /** null ⇒ vague amount is allowed ("naar smaak") — never invent quantities. */
  quantity: z.number().positive().nullable(),
  unit: z.string().nullable(),
  /** Join key into the product-matching engine (spec §E). Dutch supermarket term, e.g. "bosui". */
  item_normalised: z.string().nullable(),
  note: z.string().nullable().default(null),
  /** 0–1; low values render the "100 g? · controleer" pattern (mockup 04). */
  confidence: z.number().min(0).max(1).nullable().default(null),
});
export type RecipeIngredient = z.infer<typeof RecipeIngredient>;

export const RecipeStep = z.object({
  order: z.number().int().min(1),
  text: z.string(),
  /** Auto-detected inline timer ("20 min sudderen" → 1200), tappable in cook mode (spec §D3). */
  timer_seconds: z.number().int().positive().optional(),
});
export type RecipeStep = z.infer<typeof RecipeStep>;

export const Nutrition = z.object({
  kcal: z.number().nonnegative().optional(),
  protein_g: z.number().nonnegative().optional(),
  carbs_g: z.number().nonnegative().optional(),
  fat_g: z.number().nonnegative().optional(),
});
export type Nutrition = z.infer<typeof Nutrition>;

export const DietFlag = z.enum(['vegetarisch', 'vegan', 'glutenvrij', 'halal', 'lactosevrij']);
export type DietFlag = z.infer<typeof DietFlag>;

export const Recipe = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  source_url: z.string().url().nullable().default(null),
  source_platform: SourcePlatform.nullable().default(null),
  /** Creator handle / site name, e.g. "@lekkersimpelnl" or "Leukerecepten" — bron blijft bewaard (spec §C6). */
  source_author: z.string().nullable().default(null),
  images: z.array(z.string()).default([]),
  servings_base: z.number().int().positive().default(2),
  time_prep_min: z.number().int().nonnegative().nullable().default(null),
  time_cook_min: z.number().int().nonnegative().nullable().default(null),
  ingredients: z.array(RecipeIngredient).default([]),
  steps: z.array(RecipeStep).default([]),
  tags: z.array(z.string()).default([]),
  cuisine: z.string().nullable().default(null),
  diet_flags: z.array(DietFlag).default([]),
  nutrition: Nutrition.nullable().default(null),
  /** Fields the parser could not determine — surfaced in the review screen, never silently guessed. */
  missing_fields: z.array(z.string()).default([]),
  origin: RecipeOrigin,
  owner_id: z.string().uuid().nullable().default(null),
  household_id: z.string().uuid().nullable().default(null),
  last_cooked_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Recipe = z.infer<typeof Recipe>;
