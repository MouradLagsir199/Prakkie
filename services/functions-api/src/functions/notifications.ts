import { app } from '@azure/functions';
import { z } from 'zod';
import { query } from '../lib/db';
import { handler, json, parseBody, requireAuth } from '../lib/http';

/**
 * WS10 push notifications (opt-in, exactly two v1 types with per-type toggles):
 *  - weekly_plan: zondag 16:00 "Plan je week" for users without next-week plan
 *  - bonus_list: fired by the nightly catalog refresh when a list gains deals
 * Tokens are Expo push tokens (EAS builds); registration is a no-op in Expo Go.
 */

app.http('push-register', {
  methods: ['POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'v1/me/push-token',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    if (req.method === 'DELETE') {
      await query(`UPDATE app.devices SET push_token = NULL WHERE id = $1`, [claims.deviceId]);
      return json(204, undefined);
    }
    const body = await parseBody(
      req,
      z.object({
        push_token: z.string().startsWith('ExponentPushToken'),
        prefs: z.object({ weekly_plan: z.boolean().default(true), bonus_list: z.boolean().default(true) }).default({}),
      })
    );
    await query(`UPDATE app.devices SET push_token = $2, notification_prefs = $3 WHERE id = $1`, [
      claims.deviceId,
      body.push_token,
      JSON.stringify(body.prefs),
    ]);
    return json(200, { registered: true });
  }),
});

export async function sendExpoPush(messages: { to: string; title: string; body: string }[]): Promise<number> {
  if (!messages.length) return 0;
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100)),
    });
    if (res.ok) sent += Math.min(100, messages.length - i);
  }
  return sent;
}

// zondag 16:00 NL ≈ 14:00/15:00 UTC — weekly plan reminder for opted-in devices
app.timer('weekly-plan-reminder', {
  schedule: '0 0 15 * * 0',
  handler: async (_t, ctx) => {
    const nextMonday = new Date();
    nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
    const weekStart = nextMonday.toISOString().slice(0, 10);
    const targets = await query<{ push_token: string }>(
      `SELECT DISTINCT d.push_token FROM app.devices d
       JOIN app.users u ON u.id = d.user_id AND u.deleted_at IS NULL
       WHERE d.push_token IS NOT NULL AND d.revoked_at IS NULL
         AND coalesce((d.notification_prefs->>'weekly_plan')::boolean, true)
         AND NOT EXISTS (
           SELECT 1 FROM app.plans p WHERE p.week_start = $1 AND p.deleted_at IS NULL
             AND (p.owner_id = u.id OR p.household_id IN (
               SELECT household_id FROM app.household_members WHERE user_id = u.id)))`,
      [weekStart]
    );
    const sent = await sendExpoPush(
      targets.rows.map((t) => ({
        to: t.push_token,
        title: 'Tijd om je week te plannen 🍽️',
        body: 'Kies je gerechten voor volgende week — je boodschappenlijst staat in één tik klaar.',
      }))
    );
    ctx.log(`weekly-plan-reminder: ${sent}/${targets.rowCount} sent for week ${weekStart}`);
  },
});
