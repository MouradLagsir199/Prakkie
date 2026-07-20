import { app } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { z } from 'zod';
import { ChainId, DietFlag, Locale, Units } from '@prakkie/shared';
import { getAiQuota } from '../lib/ai-quota';
import { query, withTransaction } from '../lib/db';
import { env } from '../lib/env';
import { HttpError, handler, json, parseBody, requireAuth } from '../lib/http';
import { PUBLIC_USER_COLUMNS, type UserRow } from '../lib/session';

/** /v1/me — user settings (spec §A3: language/units, household size, home chains). */

const SettingsPatch = z.object({
  display_name: z.string().min(1).max(100).nullable().optional(),
  locale: Locale.optional(),
  units: Units.optional(),
  default_servings: z.number().int().positive().max(20).optional(),
  diet_flags: z.array(DietFlag).optional(),
  home_chain_ids: z.array(ChainId).min(1).optional(), // first entry = "jouw winkel"
});

app.http('me', {
  methods: ['GET', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  route: 'v1/me',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);

    if (req.method === 'DELETE') {
      const avatar = await query<{ avatar_url: string | null }>(
        `SELECT avatar_url FROM app.users WHERE id = $1 AND deleted_at IS NULL`,
        [claims.userId]
      );
      if (!avatar.rowCount) throw new HttpError(404, 'not_found', 'Account bestaat niet meer');

      await withTransaction(async (tx) => {
        const owned = await tx.query<{ household_id: string }>(
          `SELECT household_id FROM app.household_members WHERE user_id = $1 AND role = 'owner'`,
          [claims.userId]
        );
        for (const { household_id: householdId } of owned.rows) {
          const successor = await tx.query<{ user_id: string }>(
            `SELECT user_id FROM app.household_members
             WHERE household_id = $1 AND user_id <> $2
             ORDER BY joined_at LIMIT 1`,
            [householdId, claims.userId]
          );
          if (successor.rowCount) {
            await tx.query(
              `UPDATE app.household_members SET role = 'owner' WHERE household_id = $1 AND user_id = $2`,
              [householdId, successor.rows[0]!.user_id]
            );
          }
        }
        await tx.query(`DELETE FROM app.household_members WHERE user_id = $1`, [claims.userId]);
        await tx.query(`UPDATE app.devices SET revoked_at = now(), push_token = NULL WHERE user_id = $1`, [claims.userId]);
        await tx.query(
          `UPDATE app.users
           SET email = NULL, apple_sub = NULL, google_sub = NULL, password_hash = NULL,
               display_name = NULL, avatar_url = NULL, is_guest = true,
               deleted_at = now(), purge_after = now() + interval '30 days', updated_at = now()
           WHERE id = $1`,
          [claims.userId]
        );
      });

      // Blob cleanup is best-effort; identity and sessions are already gone.
      if (avatar.rows[0]?.avatar_url) {
        const container = BlobServiceClient.fromConnectionString(env.storageConnection).getContainerClient('avatars');
        for await (const blob of container.listBlobsFlat({ prefix: `${claims.userId}.` })) {
          await container.deleteBlob(blob.name).catch(() => {});
        }
      }
      return json(200, { deleted: true });
    }

    if (req.method === 'PATCH') {
      const body = await parseBody(req, SettingsPatch);
      const columns = Object.keys(body) as (keyof typeof body)[];
      if (columns.length) {
        const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
        await query(`UPDATE app.users SET ${sets} WHERE id = $1 AND deleted_at IS NULL`, [
          claims.userId,
          ...columns.map((c) => body[c]),
        ]);
      }
    }

    const userColumns = PUBLIC_USER_COLUMNS.split(', ')
      .map((c) => `u.${c}`)
      .join(', ');
    const result = await query<UserRow>(
      `SELECT ${userColumns}, coalesce(s.tier, 'free') AS tier
       FROM app.users u LEFT JOIN app.subscriptions s ON s.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [claims.userId]
    );
    if (!result.rowCount) throw new HttpError(404, 'not_found', 'Account bestaat niet meer');
    return json(200, result.rows[0]);
  }),
});

/** GET /v1/me/quota — de drie AI-tegoeden (prakkie/import/enrich) voor de
 *  quota-badges in de app (owner 2026-07-10): zichtbaar vóór de eerste actie,
 *  niet pas na een resolve-response. */
app.http('me-quota', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/me/quota',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const { quotas, trial, trial_expired, trial_days_remaining } = await getAiQuota(claims.userId, claims.tier);
    return json(200, { ...quotas, trial, trial_expired, trial_days_remaining });
  }),
});

/** Profielfoto (owner 2026-07-07 avond): base64 → publieke blob, URL op de user.
 *  Blob-naam = userId (overschrijft de vorige); ?v=timestamp bust caches. */
const AvatarBody = z.object({
  data_base64: z.string().min(1).max(4_000_000), // ~3 MB beeld
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

app.http('me-avatar', {
  methods: ['POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'v1/me/avatar',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    if (req.method === 'DELETE') {
      await query(`UPDATE app.users SET avatar_url = NULL WHERE id = $1`, [claims.userId]);
      return json(200, { avatar_url: null });
    }
    const body = await parseBody(req, AvatarBody);
    const buffer = Buffer.from(body.data_base64, 'base64');
    // kleiner dan een minimale PNG-header kan geen beeld zijn
    if (buffer.length < 30) throw new HttpError(400, 'invalid_image', 'Beeld is leeg of kapot');

    const container = BlobServiceClient.fromConnectionString(env.storageConnection).getContainerClient('avatars');
    await container.createIfNotExists({ access: 'blob' }); // publiek leesbaar per blob-URL
    const ext = body.content_type === 'image/png' ? 'png' : body.content_type === 'image/webp' ? 'webp' : 'jpg';
    const blob = container.getBlockBlobClient(`${claims.userId}.${ext}`);
    await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: body.content_type } });

    const avatarUrl = `${blob.url}?v=${Date.now()}`;
    await query(`UPDATE app.users SET avatar_url = $2 WHERE id = $1`, [claims.userId, avatarUrl]);
    return json(200, { avatar_url: avatarUrl });
  }),
});
