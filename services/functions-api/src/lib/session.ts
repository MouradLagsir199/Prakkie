import type { PoolClient } from 'pg';
import { query } from './db';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  newRefreshToken,
  signAccessToken,
  type AccessClaims,
} from './auth';

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_guest: boolean;
  locale: string;
  units: string;
  default_servings: number;
  diet_flags: string[];
  home_chain_ids: string[];
  created_at: string;
  updated_at: string;
}

export const PUBLIC_USER_COLUMNS =
  'id, email, display_name, avatar_url, is_guest, locale, units, default_servings, diet_flags, home_chain_ids, created_at, updated_at';

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: UserRow & { tier: string };
}

async function loadClaimsContext(userId: string): Promise<{ tier: AccessClaims['tier']; householdIds: string[] }> {
  const [sub, members] = await Promise.all([
    query<{ tier: AccessClaims['tier'] }>('SELECT tier FROM app.subscriptions WHERE user_id = $1', [userId]),
    query<{ household_id: string }>('SELECT household_id FROM app.household_members WHERE user_id = $1', [userId]),
  ]);
  return {
    tier: sub.rows[0]?.tier ?? 'free',
    householdIds: members.rows.map((r) => r.household_id),
  };
}

/**
 * Creates (or rotates) the device row's refresh token and issues an access JWT.
 * Pass an open transaction client when the caller also creates the user row.
 */
export async function issueSession(
  user: UserRow,
  deviceId: string,
  client?: PoolClient
): Promise<TokenBundle> {
  const { token, hash } = newRefreshToken(deviceId);
  const q = client ? client.query.bind(client) : query;
  await q(
    `UPDATE app.devices
     SET refresh_token_hash = $2, revoked_at = NULL, last_seen_at = now()
     WHERE id = $1`,
    [deviceId, hash]
  );
  const { tier, householdIds } = await loadClaimsContext(user.id);
  const access = await signAccessToken({
    userId: user.id,
    deviceId,
    isGuest: user.is_guest,
    tier,
    householdIds,
  });
  return {
    access_token: access,
    refresh_token: token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user: { ...user, tier },
  };
}

export async function createDevice(
  userId: string,
  platform: 'ios' | 'android' | 'web',
  client?: PoolClient
): Promise<string> {
  const q = client ? client.query.bind(client) : query;
  const result = await q(
    'INSERT INTO app.devices (user_id, platform) VALUES ($1, $2) RETURNING id',
    [userId, platform]
  );
  return (result.rows[0] as { id: string }).id;
}

export async function getUser(userId: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM app.users WHERE id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  return result.rows[0] ?? null;
}
