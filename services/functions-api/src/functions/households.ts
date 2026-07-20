import { app } from '@azure/functions';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction } from '../lib/db';
import { env } from '../lib/env';
import { HttpError, handler, json, parseBody, requireAuth } from '../lib/http';

/**
 * WS9 — households (K1) + recipe share links (K3). Shared visibility rides the
 * existing household_id columns + membership table the sync layer already
 * enforces. Invites and share links are HMAC-signed tokens (no extra tables).
 */

const sign = (payload: string) =>
  `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', env.jwtSigningKey).update(payload).digest('base64url')}`;
const verify = (token: string): string | null => {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const payload = Buffer.from(body, 'base64url').toString();
  return createHmac('sha256', env.jwtSigningKey).update(payload).digest('base64url') === mac ? payload : null;
};

app.http('household-create', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'v1/households',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    if (req.method === 'GET') {
      // settings screen (UX-audit C3): which households am I in?
      const r = await query(
        `SELECT h.id, h.name, hm.role,
                (SELECT count(*)::int FROM app.household_members m WHERE m.household_id = h.id) AS member_count
         FROM app.household_members hm JOIN app.households h ON h.id = hm.household_id
         WHERE hm.user_id = $1 ORDER BY hm.joined_at`,
        [claims.userId]
      );
      return json(200, { households: r.rows });
    }
    const body = await parseBody(req, z.object({ name: z.string().min(1).max(60) }));
    const household = await withTransaction(async (tx) => {
      const h = (
        await tx.query(`INSERT INTO app.households (name, created_by) VALUES ($1, $2) RETURNING id, name`, [
          body.name,
          claims.userId,
        ])
      ).rows[0];
      await tx.query(`INSERT INTO app.household_members (household_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        h.id,
        claims.userId,
      ]);
      return h;
    });
    return json(201, household);
  }),
});

app.http('household-invite', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/households/{id}/invite',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    // uitnodigen kan alleen de admin (owner 2026-07-07: rechtenmodel)
    const member = await query<{ role: string }>(
      `SELECT role FROM app.household_members WHERE household_id = $1 AND user_id = $2`,
      [req.params.id, claims.userId]
    );
    if (!member.rowCount) throw new HttpError(403, 'forbidden', 'Geen lid van dit huishouden');
    if (member.rows[0]!.role !== 'owner') throw new HttpError(403, 'forbidden', 'Alleen de admin nodigt leden uit');

    // e-mail invite (owner UX 2026-07-06): stored server-side; the invitee sees
    // it under /v1/households/invites once signed in with that address
    const body = await parseBody(req, z.object({ email: z.string().email().optional() }).default({}));
    if (body.email) {
      const email = body.email.toLowerCase();
      const self = await query<{ email: string | null }>(`SELECT email FROM app.users WHERE id = $1`, [claims.userId]);
      if (self.rows[0]?.email?.toLowerCase() === email) {
        throw new HttpError(400, 'self_invite', 'Je zit al in dit huishouden');
      }
      await query(
        `INSERT INTO app.household_invites (household_id, email, invited_by) VALUES ($1, $2, $3)
         ON CONFLICT (household_id, lower(email)) WHERE accepted_at IS NULL DO NOTHING`,
        [req.params.id, email, claims.userId]
      );
      return json(200, { invited: email });
    }

    // 7-day invite; deep link opens the app which POSTs /join
    const token = sign(JSON.stringify({ h: req.params.id, exp: Date.now() + 7 * 864e5 }));
    return json(200, { invite_token: token, deep_link: `prakkie://huishouden/join?token=${token}` });
  }),
});

app.http('household-invites-mine', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/households/invites',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    // pending invites for the e-mail on my account (guests without e-mail see none)
    const r = await query(
      `SELECT i.id, i.household_id, h.name AS household_name, u.display_name AS invited_by_name, i.created_at
       FROM app.household_invites i
       JOIN app.households h ON h.id = i.household_id
       JOIN app.users u ON u.id = i.invited_by
       WHERE i.accepted_at IS NULL
         AND lower(i.email) = (SELECT lower(email) FROM app.users WHERE id = $1 AND email IS NOT NULL)`,
      [claims.userId]
    );
    return json(200, { invites: r.rows });
  }),
});

app.http('household-invite-accept', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/households/invites/{inviteId}/accept',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const invite = await query<{ id: string; household_id: string }>(
      `SELECT i.id, i.household_id FROM app.household_invites i
       WHERE i.id = $2 AND i.accepted_at IS NULL
         AND lower(i.email) = (SELECT lower(email) FROM app.users WHERE id = $1 AND email IS NOT NULL)`,
      [claims.userId, req.params.inviteId]
    );
    if (!invite.rowCount) throw new HttpError(404, 'not_found', 'Uitnodiging niet gevonden (of al gebruikt)');
    await withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO app.household_members (household_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [invite.rows[0]!.household_id, claims.userId]
      );
      await tx.query(`UPDATE app.household_invites SET accepted_at = now() WHERE id = $1`, [req.params.inviteId]);
    });
    const info = await query(`SELECT id, name FROM app.households WHERE id = $1`, [invite.rows[0]!.household_id]);
    return json(200, info.rows[0]);
  }),
});

app.http('household-join', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/households/join',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const body = await parseBody(req, z.object({ token: z.string() }));
    const payload = verify(body.token);
    if (!payload) throw new HttpError(400, 'invalid_token', 'Ongeldige uitnodiging');
    const { h, exp } = JSON.parse(payload) as { h: string; exp: number };
    if (Date.now() > exp) throw new HttpError(400, 'expired', 'Uitnodiging verlopen');
    await query(
      `INSERT INTO app.household_members (household_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [h, claims.userId]
    );
    const info = await query(`SELECT id, name FROM app.households WHERE id = $1`, [h]);
    return json(200, info.rows[0]);
  }),
});

app.http('household-members', {
  methods: ['GET', 'DELETE', 'PATCH'],
  authLevel: 'anonymous',
  route: 'v1/households/{id}/members/{userId?}',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const me = await query(
      `SELECT role FROM app.household_members WHERE household_id = $1 AND user_id = $2`,
      [req.params.id, claims.userId]
    );
    if (!me.rowCount) throw new HttpError(403, 'forbidden', 'Geen lid van dit huishouden');
    if (req.method === 'DELETE') {
      const target = req.params.userId;
      if (me.rows[0]!.role !== 'owner' && target !== claims.userId) {
        throw new HttpError(403, 'forbidden', 'Alleen de admin verwijdert leden');
      }
      await query(`DELETE FROM app.household_members WHERE household_id = $1 AND user_id = $2`, [req.params.id, target]);
      return json(204, undefined);
    }
    if (req.method === 'PATCH') {
      // rechten toedelen (owner 2026-07-07): alleen de admin; editor = mag
      // bewerken, viewer = alleen lezen. Eigen rol wijzigen kan niet — er
      // blijft altijd een admin over.
      if (me.rows[0]!.role !== 'owner') throw new HttpError(403, 'forbidden', 'Alleen de admin wijzigt rollen');
      const target = req.params.userId;
      if (!target || target === claims.userId) throw new HttpError(400, 'invalid_target', 'Kies een ander lid');
      const body = await parseBody(req, z.object({ role: z.enum(['editor', 'viewer']) }));
      const updated = await query(
        `UPDATE app.household_members SET role = $3 WHERE household_id = $1 AND user_id = $2 AND role <> 'owner' RETURNING role`,
        [req.params.id, target, body.role]
      );
      if (!updated.rowCount) throw new HttpError(404, 'not_found', 'Lid niet gevonden');
      return json(200, { user_id: target, role: body.role });
    }
    const members = await query(
      `SELECT hm.user_id, hm.role, hm.joined_at, u.display_name, u.email, u.avatar_url,
              (SELECT max(d.last_seen_at) FROM app.devices d WHERE d.user_id = hm.user_id) AS last_active_at
       FROM app.household_members hm JOIN app.users u ON u.id = hm.user_id
       WHERE hm.household_id = $1
       ORDER BY hm.joined_at`,
      [req.params.id]
    );
    return json(200, { members: members.rows });
  }),
});

// ---------- recipe share links (K3): one-tap import on the receiving device ----------

app.http('recipe-share', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/recipes/{id}/share',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const owned = await query(
      `SELECT 1 FROM app.recipes WHERE id = $1 AND deleted_at IS NULL AND (owner_id = $2
         OR household_id IN (SELECT household_id FROM app.household_members WHERE user_id = $2))`,
      [req.params.id, claims.userId]
    );
    if (!owned.rowCount) throw new HttpError(404, 'not_found', 'Recept niet gevonden');
    const token = sign(JSON.stringify({ r: req.params.id, exp: Date.now() + 30 * 864e5 }));
    // prakkie.nl universal link once input #8 lands; the token API works today
    return json(200, { share_token: token, url: `https://prakkie.nl/r/${token}` });
  }),
});

app.http('recipe-shared-get', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/shared/{token}',
  handler: handler(async (req) => {
    await requireAuth(req);
    const payload = verify(req.params.token ?? '');
    if (!payload) throw new HttpError(400, 'invalid_token', 'Ongeldige deellink');
    const { r, exp } = JSON.parse(payload) as { r: string; exp: number };
    if (Date.now() > exp) throw new HttpError(410, 'expired', 'Deellink verlopen');
    const recipe = await query(
      `SELECT title, images, servings_base, time_prep_min, time_cook_min, ingredients, steps,
              tags, cuisine, diet_flags, source_url, source_platform, source_author
       FROM app.recipes WHERE id = $1 AND deleted_at IS NULL`,
      [r]
    );
    if (!recipe.rowCount) throw new HttpError(404, 'not_found', 'Recept bestaat niet meer');
    return json(200, { recipe: { ...recipe.rows[0], origin: 'shared' } });
  }),
});

// ---------- cart handoff (L1/L2): AH deep links first, others copy-list ----------

app.http('cart-handoff', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/lists/{id}/handoff',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const chain = req.query.get('chain') ?? 'ah';
    const items = await query<{ name: string; quantity: string | null; unit: string | null; matches: Record<string, { sku_id?: string }> }>(
      `SELECT i.name, i.quantity, i.unit, i.matches FROM app.list_items i
       JOIN app.lists l ON l.id = i.list_id
       WHERE i.list_id = $2 AND i.deleted_at IS NULL AND i.checked = false
         AND (l.owner_id = $1 OR l.household_id IN (SELECT household_id FROM app.household_members WHERE user_id = $1))`,
      [claims.userId, req.params.id]
    );
    const copyText = items.rows
      .map((i) => `${i.quantity ? `${i.quantity}${i.unit ? ` ${i.unit}` : ''} ` : ''}${i.name}`)
      .join('\n');
    if (chain === 'ah') {
      const skus = items.rows.map((i) => i.matches?.ah?.sku_id).filter(Boolean);
      const products = skus.length
        ? await query<{ product_url: string }>(
            `SELECT product_url FROM catalog.products WHERE chain_id = 'ah' AND sku_id = ANY($1) AND product_url IS NOT NULL`,
            [skus]
          )
        : { rows: [] as { product_url: string }[] };
      return json(200, {
        chain: 'ah',
        mode: 'deep_links',
        product_links: products.rows.map((p) => p.product_url),
        copy_text: copyText, // fallback stays available
      });
    }
    return json(200, { chain, mode: 'copy_list', copy_text: copyText });
  }),
});
