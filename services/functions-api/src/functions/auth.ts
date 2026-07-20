import { app, HttpRequest } from '@azure/functions';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { hashPassword, hashRefreshToken, parseRefreshToken, verifyPassword } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { HttpError, handler, json, parseBody, requireAuth } from '../lib/http';
import { PUBLIC_USER_COLUMNS, createDevice, getUser, issueSession, type UserRow } from '../lib/session';
import { env } from '../lib/env';

/**
 * Custom JWT auth per ADR-0004 — Apple, Google, email and guest all end in the
 * same place: an app.users row, a device row, a 15-min access JWT and a
 * rotating refresh token. Guest → account upgrade never changes the user id.
 */

const Platform = z.enum(['ios', 'android', 'web']);
const Password = z.string().min(8).max(200);

// ---------- guest ----------

app.http('auth-guest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/guest',
  handler: handler(async (req) => {
    const body = await parseBody(req, z.object({ platform: Platform }));
    const bundle = await withTransaction(async (tx) => {
      const user = (
        await tx.query(
          `INSERT INTO app.users (is_guest) VALUES (true) RETURNING ${PUBLIC_USER_COLUMNS}`
        )
      ).rows[0] as UserRow;
      const deviceId = await createDevice(user.id, body.platform, tx);
      return issueSession(user, deviceId, tx);
    });
    return json(201, bundle);
  }),
});

// ---------- email + password ----------

app.http('auth-register', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/register',
  handler: handler(async (req) => {
    const body = await parseBody(
      req,
      z.object({
        email: z.string().email(),
        password: Password,
        display_name: z.string().min(1).max(100).optional(),
        platform: Platform,
      })
    );
    const passwordHash = hashPassword(body.password);
    const bundle = await withTransaction(async (tx) => {
      const existing = await tx.query('SELECT 1 FROM app.users WHERE email = $1', [body.email]);
      if (existing.rowCount) throw new HttpError(409, 'email_taken', 'Er bestaat al een account met dit e-mailadres');
      const user = (
        await tx.query(
          `INSERT INTO app.users (email, password_hash, display_name, is_guest)
           VALUES ($1, $2, $3, false) RETURNING ${PUBLIC_USER_COLUMNS}`,
          [body.email, passwordHash, body.display_name ?? null]
        )
      ).rows[0] as UserRow;
      const deviceId = await createDevice(user.id, body.platform, tx);
      return issueSession(user, deviceId, tx);
    });
    return json(201, bundle);
  }),
});

app.http('auth-login', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/login',
  handler: handler(async (req) => {
    const body = await parseBody(
      req,
      z.object({ email: z.string().email(), password: Password, platform: Platform })
    );
    const result = await query<UserRow & { password_hash: string | null }>(
      `SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM app.users
       WHERE email = $1 AND deleted_at IS NULL`,
      [body.email]
    );
    const user = result.rows[0];
    if (!user?.password_hash || !verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, 'invalid_credentials', 'E-mailadres of wachtwoord klopt niet');
    }
    delete (user as Partial<typeof user>).password_hash;
    const deviceId = await createDevice(user.id, body.platform);
    return json(200, await issueSession(user, deviceId));
  }),
});

// ---------- guest → account upgrade (user id preserved, spec §A1) ----------

app.http('auth-upgrade', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/upgrade',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    if (!claims.isGuest) throw new HttpError(409, 'not_a_guest', 'Account is al volledig');
    const body = await parseBody(
      req,
      z.object({
        email: z.string().email(),
        password: Password,
        display_name: z.string().min(1).max(100).optional(),
      })
    );
    const passwordHash = hashPassword(body.password);
    const user = await withTransaction(async (tx) => {
      const existing = await tx.query('SELECT 1 FROM app.users WHERE email = $1 AND id <> $2', [
        body.email,
        claims.userId,
      ]);
      if (existing.rowCount) throw new HttpError(409, 'email_taken', 'Er bestaat al een account met dit e-mailadres');
      const updated = await tx.query(
        `UPDATE app.users
         SET email = $2, password_hash = $3, display_name = coalesce($4, display_name), is_guest = false
         WHERE id = $1 AND is_guest = true AND deleted_at IS NULL
         RETURNING ${PUBLIC_USER_COLUMNS}`,
        [claims.userId, body.email, passwordHash, body.display_name ?? null]
      );
      if (!updated.rowCount) throw new HttpError(409, 'not_a_guest', 'Account is al volledig');
      return updated.rows[0] as UserRow;
    });
    // fresh session so the is_guest claim flips immediately
    return json(200, await issueSession(user, claims.deviceId));
  }),
});

// ---------- Apple / Google (native id_token → our JWT) ----------

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

interface ProviderConfig {
  column: 'apple_sub' | 'google_sub';
  jwks: ReturnType<typeof createRemoteJWKSet>;
  issuer: string | string[];
  audiences: string[];
}

function providerConfig(provider: 'apple' | 'google'): ProviderConfig {
  if (provider === 'apple') {
    return {
      column: 'apple_sub',
      jwks: APPLE_JWKS,
      issuer: 'https://appleid.apple.com',
      audiences: env.appleClientIds,
    };
  }
  return {
    column: 'google_sub',
    jwks: GOOGLE_JWKS,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audiences: env.googleClientIds,
  };
}

async function providerSignIn(req: HttpRequest, provider: 'apple' | 'google') {
  const cfg = providerConfig(provider);
  if (cfg.audiences.length === 0) {
    // owner input #4 (OAuth client ids) not delivered yet
    throw new HttpError(501, 'provider_not_configured', `${provider} sign-in is nog niet geconfigureerd`);
  }
  const body = await parseBody(
    req,
    z.object({ id_token: z.string(), platform: Platform, display_name: z.string().max(100).optional() })
  );
  const { sub, email } = await verifyProviderToken(body.id_token, provider, cfg);

  // a valid guest bearer upgrades that user in place — id preserved
  let guestUserId: string | null = null;
  const header = req.headers.get('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      const claims = await requireAuth(req);
      if (claims.isGuest) guestUserId = claims.userId;
    } catch {
      /* absent/expired bearer is fine for sign-in */
    }
  }

  const bundle = await withTransaction((tx) =>
    linkProviderIdentity(tx, cfg, {
      sub,
      email,
      displayName: body.display_name,
      platform: body.platform,
      guestUserId,
    })
  );
  return json(200, bundle);
}

async function verifyProviderToken(idToken: string, provider: 'apple' | 'google', cfg = providerConfig(provider)) {
  try {
    const { payload } = await jwtVerify(idToken, cfg.jwks, {
      issuer: cfg.issuer as string,
      audience: cfg.audiences,
    });
    if (!payload.sub) throw new Error('missing subject');
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    };
  } catch {
    throw new HttpError(401, 'invalid_provider_token', `Ongeldig ${provider} id_token`);
  }
}

async function linkProviderIdentity(
  tx: PoolClient,
  cfg: ProviderConfig,
  input: {
    sub: string;
    email: string | null;
    displayName?: string;
    platform: 'ios' | 'android' | 'web';
    guestUserId: string | null;
  }
) {
    const bySub = await tx.query(
      `SELECT ${PUBLIC_USER_COLUMNS} FROM app.users WHERE ${cfg.column} = $1 AND deleted_at IS NULL`,
      [input.sub]
    );
    let user = bySub.rows[0] as UserRow | undefined;
    if (!user && input.email) {
      // Existing account wins over the temporary guest. This keeps recipes and
      // lists reachable when somebody changes phone or identity provider.
      user = (
        await tx.query(
          `UPDATE app.users SET ${cfg.column} = $2 WHERE email = $1 AND deleted_at IS NULL
           RETURNING ${PUBLIC_USER_COLUMNS}`,
          [input.email, input.sub]
        )
      ).rows[0] as UserRow | undefined;
    }
    if (!user && input.guestUserId) {
      user = (
        await tx.query(
          `UPDATE app.users
           SET ${cfg.column} = $2, email = coalesce(email, $3), display_name = coalesce($4, display_name), is_guest = false
           WHERE id = $1 AND deleted_at IS NULL RETURNING ${PUBLIC_USER_COLUMNS}`,
          [input.guestUserId, input.sub, input.email, input.displayName ?? null]
        )
      ).rows[0] as UserRow;
    }
    if (!user) {
      user = (
        await tx.query(
          `INSERT INTO app.users (${cfg.column}, email, display_name, is_guest)
           VALUES ($1, $2, $3, false) RETURNING ${PUBLIC_USER_COLUMNS}`,
          [input.sub, input.email, input.displayName ?? null]
        )
      ).rows[0] as UserRow;
    }
    const deviceId = await createDevice(user.id, input.platform, tx);
    return issueSession(user, deviceId, tx);
}

app.http('auth-apple', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/apple',
  handler: handler((req) => providerSignIn(req, 'apple')),
});

app.http('auth-google', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/google',
  handler: handler((req) => providerSignIn(req, 'google')),
});

// ---------- refresh rotation + reuse detection ----------

app.http('auth-refresh', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/refresh',
  handler: handler(async (req) => {
    const body = await parseBody(req, z.object({ refresh_token: z.string() }));
    const parsed = parseRefreshToken(body.refresh_token);
    if (!parsed) throw new HttpError(401, 'invalid_refresh_token', 'Malformed refresh token');

    const device = (
      await query<{ id: string; user_id: string; refresh_token_hash: string | null; revoked_at: string | null }>(
        'SELECT id, user_id, refresh_token_hash, revoked_at FROM app.devices WHERE id = $1',
        [parsed.deviceId]
      )
    ).rows[0];
    if (!device || device.revoked_at || !device.refresh_token_hash) {
      throw new HttpError(401, 'invalid_refresh_token', 'Refresh token revoked or unknown');
    }
    if (device.refresh_token_hash !== hashRefreshToken(body.refresh_token)) {
      // token reuse — someone is replaying an old token for this device: revoke it (ADR-0004)
      await query('UPDATE app.devices SET revoked_at = now(), refresh_token_hash = NULL WHERE id = $1', [
        device.id,
      ]);
      throw new HttpError(401, 'refresh_reuse_detected', 'Refresh token reuse detected; device revoked');
    }
    const user = await getUser(device.user_id);
    if (!user) throw new HttpError(401, 'invalid_refresh_token', 'User no longer exists');
    return json(200, await issueSession(user, device.id));
  }),
});

app.http('auth-logout', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/auth/logout',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    await query('UPDATE app.devices SET revoked_at = now(), refresh_token_hash = NULL, push_token = NULL WHERE id = $1', [
      claims.deviceId,
    ]);
    return json(204, undefined);
  }),
});
