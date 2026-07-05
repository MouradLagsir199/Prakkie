import { app } from '@azure/functions';
import { query } from '../lib/db';
import { HttpError, handler, json, requireAuth } from '../lib/http';

/**
 * WS7 — Ontdek feed. The feed shows title+image+badges+attribution ONLY
 * (display depth behind config pending legal input #12); the full recipe is
 * fetched on save and goes through the mockup-04 review flow like any import.
 * Ranking v1: deal overlap > price p.p. (when precomputed) > freshness.
 */

app.http('discover-feed', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/discover',
  handler: handler(async (req) => {
    await requireAuth(req);
    const q = req.query.get('q')?.trim();
    const limit = Math.min(50, Number(req.query.get('limit') ?? 30));
    const params: unknown[] = [limit];
    let where = `cr.dead_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM discovery.blocklist b WHERE cr.source_url LIKE '%' || b.domain || '%')`;
    if (q) {
      params.push(q);
      where += ` AND cr.search_tsv @@ plainto_tsquery('dutch', $2)`;
    }
    const rows = await query(
      `SELECT cr.id, cr.title, cr.site_name, cr.image_url, cr.time_total_min, cr.servings,
              p.price_per_portion_cents, p.deal_overlap_count
       FROM discovery.crawled_recipes cr
       LEFT JOIN LATERAL (
         SELECT price_per_portion_cents, deal_overlap_count FROM discovery.recipe_prices rp
         WHERE rp.crawled_recipe_id = cr.id ORDER BY rp.deal_overlap_count DESC NULLS LAST LIMIT 1
       ) p ON true
       WHERE ${where}
       ORDER BY p.deal_overlap_count DESC NULLS LAST,
                p.price_per_portion_cents ASC NULLS LAST,
                cr.first_seen_at DESC
       LIMIT $1`,
      params
    );
    return json(200, { items: rows.rows });
  }),
});

app.http('discover-detail', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/discover/{id}',
  handler: handler(async (req) => {
    await requireAuth(req);
    const r = await query(
      `SELECT id, title, site_name, source_url, image_url, recipe FROM discovery.crawled_recipes
       WHERE id = $1 AND dead_at IS NULL`,
      [req.params.id]
    );
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Recept niet gevonden in Ontdek');
    const row = r.rows[0] as { id: string; title: string; site_name: string; source_url: string; image_url: string | null; recipe: Record<string, unknown> };
    // origin flips to crawled_save when the user saves it into their library
    return json(200, { id: row.id, site_name: row.site_name, source_url: row.source_url, recipe: { ...row.recipe, origin: 'crawled_save', source_platform: 'blog' } });
  }),
});
