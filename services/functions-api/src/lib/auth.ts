import { argon2id } from '@noble/hashes/argon2';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from './env';

/**
 * Token model per ADR-0004: 15-min HS256 access JWT signed with the Key Vault
 * key + opaque rotating refresh token whose sha256 lives on the device row.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const JWT_ISSUER = 'prakkie-api';

// OWASP argon2id baseline; pure-JS (@noble) so the Linux Consumption bundle
// needs no native binaries. ~100 ms per hash on the Functions worker.
const ARGON2_OPTS = { t: 3, m: 19_456, p: 1, dkLen: 32 } as const;

const b64 = {
  encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
  decode: (text: string) => new Uint8Array(Buffer.from(text, 'base64url')),
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = argon2id(password.normalize('NFKC'), salt, ARGON2_OPTS);
  return `$argon2id$v=19$m=${ARGON2_OPTS.m},t=${ARGON2_OPTS.t},p=${ARGON2_OPTS.p}$${b64.encode(salt)}$${b64.encode(hash)}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!match) return false;
  const expected = b64.decode(match[5]!);
  const actual = argon2id(password.normalize('NFKC'), b64.decode(match[4]!), {
    m: Number(match[1]),
    t: Number(match[2]),
    p: Number(match[3]),
    dkLen: expected.length,
  });
  // constant-time compare
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

export interface AccessClaims {
  userId: string;
  deviceId: string;
  isGuest: boolean;
  tier: 'free' | 'premium' | 'lifetime';
  householdIds: string[];
}

function signingKey(): Uint8Array {
  return new TextEncoder().encode(env.jwtSigningKey);
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({
    device_id: claims.deviceId,
    is_guest: claims.isGuest,
    tier: claims.tier,
    household_ids: claims.householdIds,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(signingKey());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, signingKey(), { issuer: JWT_ISSUER });
  return {
    userId: payload.sub as string,
    deviceId: payload.device_id as string,
    isGuest: Boolean(payload.is_guest),
    tier: (payload.tier as AccessClaims['tier']) ?? 'free',
    householdIds: (payload.household_ids as string[]) ?? [],
  };
}

/**
 * Refresh tokens are opaque: `<deviceId>.<secret>`. Only sha256(token) is
 * stored; a well-formed token for a device that doesn't hash-match the stored
 * value is treated as reuse and revokes the device (ADR-0004).
 */
export function newRefreshToken(deviceId: string): { token: string; hash: string } {
  const token = `${deviceId}.${b64.encode(randomBytes(32))}`;
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return b64.encode(sha256(new TextEncoder().encode(token)));
}

export function parseRefreshToken(token: string): { deviceId: string } | null {
  const [deviceId, secret] = token.split('.');
  if (!deviceId || !secret || !/^[0-9a-f-]{36}$/i.test(deviceId)) return null;
  return { deviceId };
}
