import type { CachedRow } from '@prakkie/shared';
import type { FixtureRecipe } from '../fixtures/recipes';

/**
 * Server recipe row → the card view-model the WS4 components already render.
 * (FixtureRecipe doubles as the card contract; Ontdek reuses it too.)
 */

export interface RecipeRowData {
  id: string;
  title: string;
  images?: { url?: string }[] | string[];
  time_prep_min?: number | null;
  time_cook_min?: number | null;
  servings_base?: number;
  ingredients?: { raw_text?: string; item_normalised?: string | null; quantity?: number | null; unit?: string | null; note?: string | null; confidence?: number | null }[];
  steps?: { order: number; text: string; timer_seconds?: number }[];
  tags?: string[];
  cuisine?: string | null;
  source_author?: string | null;
  source_url?: string | null;
  source_platform?: string | null;
  price_cache?: { per_portion_cents?: number; has_bonus?: boolean } | null;
  missing_fields?: string[];
  created_at?: string;
}

export function recipeImage(r: RecipeRowData): string {
  const first = (r.images ?? [])[0] as { url?: string } | string | undefined;
  const url = typeof first === 'string' ? first : first?.url;
  return url ?? 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=500&q=60';
}

export function toCard(row: CachedRow): FixtureRecipe {
  const r = row.row as unknown as RecipeRowData;
  return {
    id: r.id,
    title: r.title,
    imageUrl: recipeImage(r),
    timeTotalMin: (r.time_prep_min ?? 0) + (r.time_cook_min ?? 0),
    pricePerPortionCents: r.price_cache?.per_portion_cents ?? 0,
    bonusTip: r.price_cache?.has_bonus ?? false,
    collections: [],
    keyIngredients: (r.ingredients ?? [])
      .map((i) => i.item_normalised ?? '')
      .filter(Boolean)
      .slice(0, 4),
  };
}

export type RecipeSort = 'nieuwste' | 'oudste' | 'a-z' | 'laatst-gekookt' | 'tijd' | 'prijs';

/** The exact mockup-02 sort list. */
export const RECIPE_SORTS: { key: RecipeSort; label: string }[] = [
  { key: 'nieuwste', label: 'Nieuwste eerst' },
  { key: 'oudste', label: 'Oudste eerst' },
  { key: 'a-z', label: 'Alfabetisch A–Z' },
  { key: 'laatst-gekookt', label: 'Laatst gekookt' },
  { key: 'tijd', label: 'Bereidingstijd' },
  { key: 'prijs', label: 'Prijs p.p.' },
];

export function sortRecipes(rows: CachedRow[], sort: RecipeSort): CachedRow[] {
  const arr = [...rows];
  const r = (row: CachedRow) => row.row as unknown as RecipeRowData & { last_cooked_at?: string | null };
  switch (sort) {
    case 'a-z':
      return arr.sort((a, b) => r(a).title.localeCompare(r(b).title, 'nl'));
    case 'oudste':
      return arr.sort((a, b) => (r(a).created_at ?? '').localeCompare(r(b).created_at ?? ''));
    case 'laatst-gekookt':
      return arr.sort((a, b) => (r(b).last_cooked_at ?? '').localeCompare(r(a).last_cooked_at ?? ''));
    case 'tijd':
      return arr.sort(
        (a, b) => (r(a).time_prep_min ?? 0) + (r(a).time_cook_min ?? 0) - ((r(b).time_prep_min ?? 0) + (r(b).time_cook_min ?? 0))
      );
    case 'prijs':
      return arr.sort(
        (a, b) => (r(a).price_cache?.per_portion_cents ?? 9e9) - (r(b).price_cache?.per_portion_cents ?? 9e9)
      );
    default:
      return arr.sort((a, b) => (r(b).created_at ?? '').localeCompare(r(a).created_at ?? ''));
  }
}
