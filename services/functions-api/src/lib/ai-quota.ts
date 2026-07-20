import { query } from './db';
import { HttpError } from './http';

/**
 * Maandquotums voor de drie AI-acties (owner 2026-07-10). Er is géén gratis of
 * onbeperkte tier: het €2,99-plan (tier premium/lifetime) krijgt de volle
 * limieten, de proefperiode (tier 'free', eerste 30 dagen na aanmelden) de
 * helft. Cache-hits (prakkie-resolve-cache, import-URL-cache) verbruiken nooit
 * een tik — alleen echte LLM-calls tellen.
 */

export type AiKind = 'prakkie' | 'import' | 'enrich' | 'generate';

export const PAID_LIMITS: Record<AiKind, number> = { prakkie: 100, import: 30, enrich: 30, generate: 20 };
export const TRIAL_LIMITS: Record<AiKind, number> = { prakkie: 50, import: 15, enrich: 15, generate: 10 };

const KIND_LABEL: Record<AiKind, string> = {
  prakkie: 'prakkie-zoekopdrachten',
  import: 'recept-imports',
  enrich: 'recept-aanvullingen',
  generate: 'recept-generaties',
};

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

interface QuotaContext {
  limits: Record<AiKind, number>;
  trial: boolean;
  trialExpired: boolean;
  trialDaysRemaining: number | null;
}

async function quotaContext(userId: string, tier: string): Promise<QuotaContext> {
  if (tier !== 'free') {
    return { limits: PAID_LIMITS, trial: false, trialExpired: false, trialDaysRemaining: null };
  }
  const r = await query<{ expired: boolean; days_remaining: number }>(
    `SELECT created_at < now() - interval '30 days' AS expired,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (created_at + interval '30 days' - now())) / 86400))::int AS days_remaining
     FROM app.users WHERE id = $1`,
    [userId]
  );
  return {
    limits: TRIAL_LIMITS,
    trial: true,
    trialExpired: !!r.rows[0]?.expired,
    trialDaysRemaining: Number(r.rows[0]?.days_remaining ?? 0),
  };
}

/** Atomaire verbruik-tik; 402 als het quotum op is of de proefperiode voorbij. */
export async function consumeAiQuota(userId: string, tier: string, kind: AiKind): Promise<void> {
  const ctx = await quotaContext(userId, tier);
  if (ctx.trialExpired) {
    throw new HttpError(
      402,
      'trial_expired',
      'Je proefperiode van 30 dagen is voorbij. Met Prakkie Plus (€2,99/maand) ga je door waar je was.'
    );
  }
  const limit = ctx.limits[kind];
  const r = await query(
    `INSERT INTO app.ai_usage (user_id, month, kind, used) VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, month, kind)
     DO UPDATE SET used = app.ai_usage.used + 1
     WHERE app.ai_usage.used < $4
     RETURNING used`,
    [userId, monthStart(), kind, limit]
  );
  if (!r.rowCount) {
    throw new HttpError(
      402,
      'quota_exceeded',
      `Je ${KIND_LABEL[kind]} voor deze maand zijn op (${limit}/maand${ctx.trial ? ' in de proefperiode' : ''}).`
    );
  }
}

export interface AiQuota {
  used: number;
  limit: number;
}

/** Alle drie tellers in één keer — voor GET /v1/me/quota en response-payloads. */
export async function getAiQuota(
  userId: string,
  tier: string
): Promise<{
  quotas: Record<AiKind, AiQuota>;
  trial: boolean;
  trial_expired: boolean;
  trial_days_remaining: number | null;
}> {
  const ctx = await quotaContext(userId, tier);
  const r = await query<{ kind: AiKind; used: number }>(
    `SELECT kind, used FROM app.ai_usage WHERE user_id = $1 AND month = $2`,
    [userId, monthStart()]
  );
  const usedBy = new Map(r.rows.map((row) => [row.kind, Number(row.used)]));
  const kinds: AiKind[] = ['prakkie', 'import', 'enrich', 'generate'];
  return {
    quotas: Object.fromEntries(
      kinds.map((k) => [k, { used: usedBy.get(k) ?? 0, limit: ctx.limits[k] }])
    ) as Record<AiKind, AiQuota>,
    trial: ctx.trial,
    trial_expired: ctx.trialExpired,
    trial_days_remaining: ctx.trialDaysRemaining,
  };
}

/** tier-lookup voor paden zonder claims (import-queue-worker). */
export async function tierOf(userId: string): Promise<string> {
  const r = await query<{ tier: string }>(`SELECT tier FROM app.subscriptions WHERE user_id = $1`, [userId]);
  return r.rows[0]?.tier ?? 'free';
}
