import { app } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../lib/db';
import { HttpError, handler, json, parseBody, requireAuth } from '../lib/http';
import { generateLines, priceList } from '../lib/pricing';

/** WS5 — list-generate (G1/G2), list-price (G7), basket-compare (F2), deals-for-list (F3). */

async function requireList(listId: string, userId: string): Promise<void> {
  const r = await query(
    `SELECT 1 FROM app.lists l WHERE l.id = $2 AND l.deleted_at IS NULL AND (l.owner_id = $1
       OR l.household_id IN (SELECT household_id FROM app.household_members WHERE user_id = $1))`,
    [userId, listId]
  );
  if (!r.rowCount) throw new HttpError(404, 'not_found', 'Lijst niet gevonden');
}

async function userChains(userId: string, requested: string[]): Promise<string[]> {
  const enabled = await query<{ id: string }>(`SELECT id FROM catalog.chains WHERE enabled`);
  const ids = new Set(enabled.rows.map((r) => r.id));
  if (requested.length) return requested.filter((c) => ids.has(c));
  const user = await query<{ home_chain_ids: string[] }>(`SELECT home_chain_ids FROM app.users WHERE id = $1`, [userId]);
  const home = (user.rows[0]?.home_chain_ids ?? []).filter((c) => ids.has(c));
  return home.length ? home : [...ids];
}

// ---------- generate ----------

app.http('list-generate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/lists/{id}/generate',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const listId = req.params.id!;
    await requireList(listId, claims.userId);
    const body = await parseBody(
      req,
      z.object({
        recipes: z.array(z.object({ recipe_id: z.string().uuid(), servings: z.number().int().positive() })).min(1),
        replace_generated: z.boolean().default(false),
        /** G6 — subtract pantry stock; reversible per line client-side */
        pantry_aware: z.boolean().default(false),
      })
    );
    let lines = await generateLines(body.recipes, claims.userId);
    if (body.pantry_aware) {
      const pantry = await query<{ item_normalised: string | null; name: string }>(
        `SELECT item_normalised, name FROM app.pantry_items WHERE deleted_at IS NULL AND (owner_id = $1
           OR household_id IN (SELECT household_id FROM app.household_members WHERE user_id = $1))`,
        [claims.userId]
      );
      const have = new Set(pantry.rows.map((p) => (p.item_normalised ?? p.name).toLowerCase()));
      lines = lines.filter((l) => !have.has(l.item_normalised.toLowerCase()));
    }
    const inserted = await withTransaction(async (tx) => {
      if (body.replace_generated) {
        // re-derive: only non-manual lines are plan/generator-owned (G4 rule)
        await tx.query(
          `UPDATE app.list_items SET deleted_at = now() WHERE list_id = $1 AND is_manual = false AND deleted_at IS NULL`,
          [listId]
        );
      }
      let sort = 0;
      for (const line of lines) {
        await tx.query(
          `INSERT INTO app.list_items (id, list_id, name, quantity, unit, item_normalised, aisle_group_id,
             sort_order, is_manual, provenance)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)`,
          [
            randomUUID(), listId, line.name, line.quantity, line.unit, line.item_normalised,
            line.aisle_group_id, sort++, JSON.stringify(line.provenance),
          ]
        );
      }
      return lines.length;
    });
    return json(200, { list_id: listId, added: inserted });
  }),
});

// ---------- price / compare / deals ----------

app.http('list-price', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/lists/{id}/price',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const listId = req.params.id!;
    await requireList(listId, claims.userId);
    const chains = await userChains(claims.userId, (req.query.get('chains') ?? '').split(',').filter(Boolean));
    const pricing = await priceList(listId, chains, claims.userId);
    return json(200, { list_id: listId, chains: pricing });
  }),
});

app.http('basket-compare', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/lists/{id}/compare',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const listId = req.params.id!;
    await requireList(listId, claims.userId);
    const all = await query<{ id: string }>(`SELECT id FROM catalog.chains WHERE enabled`);
    const user = await query<{ home_chain_ids: string[] }>(`SELECT home_chain_ids FROM app.users WHERE id = $1`, [claims.userId]);
    const home = req.query.get('home') ?? user.rows[0]?.home_chain_ids?.[0] ?? 'ah';

    const pricing = await priceList(listId, all.rows.map((r) => r.id), claims.userId);
    // honest ranking: complete chains by total; partial-coverage chains listed apart (mockup 07)
    const complete = pricing.filter((c) => c.unmatched.length === 0 && c.full_assortment);
    const partial = pricing.filter((c) => c.unmatched.length > 0 || !c.full_assortment);
    complete.sort((a, b) => a.total_cents - b.total_cents);
    const homeChain = pricing.find((c) => c.chain_id === home) ?? null;
    const cheapest = complete[0] ?? null;

    // F4: name the items that drive the difference vs the cheapest chain
    let insight: { savings_cents: number; driving_items: { name: string; delta_cents: number }[] } | null = null;
    if (homeChain && cheapest && cheapest.chain_id !== homeChain.chain_id) {
      const cheapLines = new Map(cheapest.lines.map((l) => [l.item_id, l]));
      const deltas = homeChain.lines
        .filter((l) => l.matched && cheapLines.get(l.item_id)?.matched)
        .map((l) => ({
          name: l.name,
          delta_cents: (l.line_price_cents ?? 0) - (cheapLines.get(l.item_id)!.line_price_cents ?? 0),
        }))
        .filter((d) => d.delta_cents > 0)
        .sort((a, b) => b.delta_cents - a.delta_cents);
      insight = {
        savings_cents: homeChain.total_cents - cheapest.total_cents,
        driving_items: deltas.slice(0, 3),
      };
    }
    return json(200, {
      list_id: listId,
      home_chain: home,
      ranked: complete,
      partial,
      cheapest_chain: cheapest?.chain_id ?? null,
      insight,
    });
  }),
});

app.http('deals-for-list', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/lists/{id}/deals',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const listId = req.params.id!;
    await requireList(listId, claims.userId);
    const chains = await userChains(claims.userId, (req.query.get('chains') ?? '').split(',').filter(Boolean));
    const pricing = await priceList(listId, chains, claims.userId);
    const deals = pricing.flatMap((chain) =>
      chain.lines
        .filter((l) => l.matched && l.promo)
        .map((l) => ({
          chain_id: chain.chain_id,
          item: l.name,
          product_name: l.product_name,
          promo: l.promo,
          savings_cents: l.promo_savings_cents ?? 0,
        }))
    );
    deals.sort((a, b) => b.savings_cents - a.savings_cents);
    return json(200, { list_id: listId, deals });
  }),
});
