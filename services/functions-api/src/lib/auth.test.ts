import { beforeAll, describe, expect, it } from 'vitest';
import {
  hashPassword,
  hashRefreshToken,
  newRefreshToken,
  parseRefreshToken,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './auth';

beforeAll(() => {
  process.env.JWT_SIGNING_KEY = 'test-signing-key-that-is-long-enough-for-hs256';
});

describe('password hashing (argon2id)', () => {
  it('round-trips and rejects wrong passwords', () => {
    const hash = hashPassword('hunter2-maar-langer');
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(verifyPassword('hunter2-maar-langer', hash)).toBe(true);
    expect(verifyPassword('verkeerd-wachtwoord', hash)).toBe(false);
  });

  it('salts: same password twice gives different hashes', () => {
    expect(hashPassword('zelfde')).not.toEqual(hashPassword('zelfde'));
  });

  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('access JWT', () => {
  it('signs and verifies round-trip with all claims', async () => {
    const claims = {
      userId: '0197a6b2-0000-7000-8000-000000000001',
      deviceId: '0197a6b2-0000-7000-8000-000000000002',
      isGuest: true,
      tier: 'free' as const,
      householdIds: ['0197a6b2-0000-7000-8000-000000000003'],
    };
    const token = await signAccessToken(claims);
    expect(await verifyAccessToken(token)).toEqual(claims);
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken({
      userId: '0197a6b2-0000-7000-8000-000000000001',
      deviceId: '0197a6b2-0000-7000-8000-000000000002',
      isGuest: false,
      tier: 'premium',
      householdIds: [],
    });
    await expect(verifyAccessToken(token.slice(0, -2) + 'xx')).rejects.toThrow();
  });
});

describe('refresh tokens', () => {
  it('embeds the device id and hashes deterministically', () => {
    const deviceId = '0197a6b2-0000-7000-8000-00000000000a';
    const { token, hash } = newRefreshToken(deviceId);
    expect(parseRefreshToken(token)).toEqual({ deviceId });
    expect(hashRefreshToken(token)).toEqual(hash);
  });

  it('rejects malformed tokens', () => {
    expect(parseRefreshToken('garbage')).toBeNull();
    expect(parseRefreshToken('not-a-uuid.secret')).toBeNull();
  });
});
