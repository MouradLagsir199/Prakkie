import { z } from 'zod';
import { SourcePlatform } from './recipe';

/**
 * LinkContext — the fused source material an import URL yields before parsing
 * (docs/06_social_import_apify.md §1). Apify/metadata/oEmbed/JSON-LD/transcript
 * all merge into this one shape; OpenAI's parseRecipe(context) consumes it.
 */

export const JsonLdRecipeData = z.object({
  name: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  image: z.array(z.string()).default([]),
  recipeIngredient: z.array(z.string()).default([]),
  recipeInstructions: z.array(z.string()).default([]),
  recipeYield: z.string().nullable().default(null),
  prepTime: z.string().nullable().default(null),
  cookTime: z.string().nullable().default(null),
  totalTime: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
});
export type JsonLdRecipeData = z.infer<typeof JsonLdRecipeData>;

export const LinkContext = z.object({
  sourceUrl: z.string().url(),
  platform: SourcePlatform,
  title: z.string().nullable().default(null),
  /** Caption / post text / description — the primary text signal. */
  description: z.string().nullable().default(null),
  imageUrl: z.string().url().nullable().default(null),
  /** Creator handle / site name for "bron blijft bewaard". */
  provider: z.string().nullable().default(null),
  /** Structured schema.org/Recipe data when present (blogs, Pinterest rich pins). */
  structuredRecipe: JsonLdRecipeData.nullable().default(null),
  /** Pinterest: an external recipe URL linked from the pin. */
  linkedRecipeUrl: z.string().url().nullable().default(null),
  /** Video transcript (≥ ~40 usable chars, truncated ≤ 12 000 — docs/06 §3). */
  transcript: z.string().nullable().default(null),
  /** Non-fatal issues collected along the way; drives 422-vs-503 (docs/06 §5). */
  warnings: z.array(z.string()).default([]),
});
export type LinkContext = z.infer<typeof LinkContext>;
