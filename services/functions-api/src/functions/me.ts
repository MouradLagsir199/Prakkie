import { app } from '@azure/functions';
import { z } from 'zod';
import { ChainId, DietFlag, Locale, Units } from '@prakkie/shared';
import { query } from '../lib/db';
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
  methods: ['GET', 'PATCH'],
  authLevel: 'anonymous',
  route: 'v1/me',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);

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
