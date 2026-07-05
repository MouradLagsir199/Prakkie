import { z } from 'zod';
import { Nutrition, RecipeIngredient, RecipeOrigin, RecipeStep, SourcePlatform, DietFlag } from '@prakkie/shared';
import { registerCrud } from '../lib/crud';
import { SYNC_ENTITIES } from '../lib/entities';

/** /v1/recipes — CRUD over the same entity definition the sync layer uses. */

const RecipeBody = z.object({
  household_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1),
  origin: RecipeOrigin,
  source_url: z.string().url().nullable().optional(),
  source_platform: SourcePlatform.nullable().optional(),
  source_author: z.string().nullable().optional(),
  images: z.array(z.string()).optional(),
  servings_base: z.number().int().positive().optional(),
  time_prep_min: z.number().int().nonnegative().nullable().optional(),
  time_cook_min: z.number().int().nonnegative().nullable().optional(),
  ingredients: z.array(RecipeIngredient).optional(),
  steps: z.array(RecipeStep).optional(),
  nutrition: Nutrition.nullable().optional(),
  missing_fields: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  cuisine: z.string().nullable().optional(),
  diet_flags: z.array(DietFlag).optional(),
  last_cooked_at: z.string().datetime({ offset: true }).nullable().optional(),
});

registerCrud({
  name: 'recipes',
  route: 'v1/recipes',
  def: SYNC_ENTITIES.recipes,
  createSchema: RecipeBody,
  updateSchema: RecipeBody.partial(),
  searchTsv: true,
});
