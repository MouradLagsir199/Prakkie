import type { PullEntityChanges, PushResult, SyncEntityName, SyncMutation, SyncTransport } from '@prakkie/shared';
import { Platform } from 'react-native';
// platform-forked: SecureStore native, localStorage web (SecureStore crasht op web)
import * as SecureStore from './secure-tokens';

/**
 * API client for func-prakkie-api (ADR-0004 sessions): 15-min access JWT +
 * rotating refresh token in SecureStore. First launch silently creates a guest
 * session — the first import happens before any account prompt (spec §A1).
 */

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://func-prakkie-api-dev.azurewebsites.net/api';

const KEYS = { access: 'prakkie.access', refresh: 'prakkie.refresh', user: 'prakkie.user' };

export interface SessionUser {
  id: string;
  email: string | null;
  display_name: string | null;
  is_guest: boolean;
  [key: string]: unknown;
}

interface SessionBundle {
  user: SessionUser;
  access_token: string;
  refresh_token: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function readError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return new ApiError(res.status, body.error ?? 'unknown', body.message ?? `HTTP ${res.status}`);
}

/** Fired when the stored user id changes (login as someone else, guest re-mint).
 *  The local replica belongs to the previous identity — the data layer resets it. */
type IdentityListener = (user: SessionUser) => void;
const identityListeners: IdentityListener[] = [];
export function onIdentityChange(listener: IdentityListener): void {
  identityListeners.push(listener);
}
function fireIdentityChange(user: SessionUser): void {
  for (const l of identityListeners) l(user);
}

async function storeSession(bundle: SessionBundle): Promise<SessionUser> {
  const previous = await currentUser().catch(() => null);
  await SecureStore.setItemAsync(KEYS.access, bundle.access_token);
  await SecureStore.setItemAsync(KEYS.refresh, bundle.refresh_token);
  await SecureStore.setItemAsync(KEYS.user, JSON.stringify(bundle.user));
  if (previous && previous.id !== bundle.user.id) fireIdentityChange(bundle.user);
  return bundle.user;
}

export async function currentUser(): Promise<SessionUser | null> {
  const raw = await SecureStore.getItemAsync(KEYS.user);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

let sessionFlight: Promise<SessionUser> | null = null;

/** Guest session on first launch; reuses the stored session afterwards.
 *  Single-flight: parallel callers must not mint two different guests. */
export function ensureSession(): Promise<SessionUser> {
  sessionFlight ??= (async () => {
    try {
      const existing = await currentUser();
      if (existing && (await SecureStore.getItemAsync(KEYS.refresh))) return existing;
      const res = await request('/v1/auth/guest', { method: 'POST', body: JSON.stringify({ platform }) });
      if (!res.ok) throw await readError(res);
      return await storeSession((await res.json()) as SessionBundle);
    } finally {
      sessionFlight = null;
    }
  })();
  return sessionFlight;
}

export async function register(email: string, password: string, displayName?: string): Promise<SessionUser> {
  // a live guest session upgrades in place — user id (and their recipes) preserved
  const guest = await currentUser();
  const path = guest?.is_guest ? '/v1/auth/upgrade' : '/v1/auth/register';
  const res = await (guest?.is_guest ? authedRequest : request)(path, {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name: displayName, platform: guest?.is_guest ? undefined : platform }),
  });
  if (!res.ok) throw await readError(res);
  return storeSession((await res.json()) as SessionBundle);
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await request('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, platform }),
  });
  if (!res.ok) throw await readError(res);
  return storeSession((await res.json()) as SessionBundle);
}

export async function logout(): Promise<void> {
  try {
    await authedRequest('/v1/auth/logout', { method: 'POST', body: '{}' });
  } catch {
    // best effort — local wipe is what matters
  }
  await SecureStore.deleteItemAsync(KEYS.access);
  await SecureStore.deleteItemAsync(KEYS.refresh);
  await SecureStore.deleteItemAsync(KEYS.user);
}

async function refreshSession(): Promise<boolean> {
  const refreshToken = await SecureStore.getItemAsync(KEYS.refresh);
  if (!refreshToken) return false;
  const res = await request('/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return false;
  await storeSession((await res.json()) as SessionBundle);
  return true;
}

let recoveryFlight: Promise<boolean> | null = null;

/** 401 fallback, single-flight: the refresh token ROTATES on use, so parallel
 *  401s racing /v1/auth/refresh would let the loser conclude "session dead" and
 *  wipe a session the winner had just repaired. All callers share one recovery. */
function recoverSession(failedToken: string | null): Promise<boolean> {
  recoveryFlight ??= (async () => {
    try {
      // another request may have recovered the session while this one queued
      if ((await SecureStore.getItemAsync(KEYS.access)) !== failedToken) return true;
      if (await refreshSession()) return true;
      // refresh-token dood (geroteerd/verlopen). Een gast-identiteit is dan
      // cryptografisch onbereikbaar — weggooien en vers beginnen is de enige
      // route (fixt de "eeuwige 401" web-sessie). E-mailaccounts wissen we
      // nooit stilletjes: daar hoort opnieuw inloggen via Profiel.
      const previous = await currentUser().catch(() => null);
      if (previous && !previous.is_guest) return false;
      await SecureStore.deleteItemAsync(KEYS.access);
      await SecureStore.deleteItemAsync(KEYS.refresh);
      await SecureStore.deleteItemAsync(KEYS.user);
      const fresh = await ensureSession().catch(() => null);
      // the user key was just wiped, so storeSession saw no "previous" — fire here
      if (fresh && fresh.id !== previous?.id) fireIdentityChange(fresh);
      return fresh !== null;
    } finally {
      recoveryFlight = null;
    }
  })();
  return recoveryFlight;
}

/** Bearer request with silent refresh-and-retry on 401 — and guest self-heal. */
export async function authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
  // web skips onboarding (the usual ensureSession caller) — bootstrap the
  // guest session here so the first request isn't a dead "Bearer null" 401
  if (!(await SecureStore.getItemAsync(KEYS.access))) await ensureSession();
  const attempt = async () => {
    const token = await SecureStore.getItemAsync(KEYS.access);
    const res = await request(path, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });
    return { token, res };
  };
  let { token, res } = await attempt();
  if (res.status === 401 && (await recoverSession(token))) ({ res } = await attempt());
  return res;
}

/** SyncTransport over /v1/sync — plugged into the shared OfflineEngine. */
export const httpTransport: SyncTransport = {
  async pull(entity: SyncEntityName, since: string): Promise<PullEntityChanges> {
    const res = await authedRequest(`/v1/sync?since=${encodeURIComponent(since)}&entities=${entity}`);
    if (!res.ok) throw await readError(res);
    const body = (await res.json()) as { changes: Record<string, PullEntityChanges> };
    return body.changes[entity] ?? { rows: [], has_more: false };
  },
  async push(mutations: SyncMutation[]): Promise<{ results: PushResult[] }> {
    const res = await authedRequest('/v1/sync/push', { method: 'POST', body: JSON.stringify({ mutations }) });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as { results: PushResult[] };
  },
};
