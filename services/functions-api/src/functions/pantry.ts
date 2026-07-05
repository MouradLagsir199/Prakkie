import { app } from '@azure/functions';
import { normaliseIngredient } from '@prakkie/matching';
import { query } from '../lib/db';
import { handler, json, requireAuth } from '../lib/http';

/**
 * WS8 — pantry intelligence. Pantry items themselves sync like any entity
 * (offline cache); these endpoints add the smarts:
 *  - cook-from-pantry over the user's OWN library, ranked by fewest missing (I2)
 *  - nutrition stays honest: only what import/crawl delivered, never invented.
 */

app.http('pantry-cook-suggestions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/pantry/cook-suggestions',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const pantry = await query<{ item_normalised: string | null; name: string }>(
      `SELECT item_normalised, name FROM app.pantry_items
       WHERE deleted_at IS NULL AND (owner_id = $1 OR household_id IN (
         SELECT household_id FROM app.household_members WHERE user_id = $1))`,
      [claims.userId]
    );
    const have = new Set(
      pantry.rows.map((p) => (p.item_normalised ?? normaliseIngredient(p.name).item).toLowerCase())
    );

    const recipes = await query<{ id: string; title: string; images: unknown; ingredients: { item_normalised?: string | null; raw_text?: string }[] }>(
      `SELECT id, title, images, ingredients FROM app.recipes
       WHERE deleted_at IS NULL AND (owner_id = $1 OR household_id IN (
         SELECT household_id FROM app.household_members WHERE user_id = $1))`,
      [claims.userId]
    );
    const suggestions = recipes.rows
      .map((r) => {
        const items = (r.ingredients ?? []).map(
          (i) => (i.item_normalised ?? normaliseIngredient(i.raw_text ?? '').item).toLowerCase()
        ).filter(Boolean);
        const missing = items.filter((i) => !have.has(i));
        return { id: r.id, title: r.title, images: r.images, total: items.length, missing_count: missing.length, missing };
      })
      .filter((s) => s.total > 0)
      .sort((a, b) => a.missing_count - b.missing_count || b.total - a.total)
      .slice(0, 20);
    return json(200, { pantry_size: have.size, suggestions });
  }),
});
