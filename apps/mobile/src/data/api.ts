import type { PullEntityChanges, PushResult, SyncEntityName, SyncMutation, SyncTransport } from '@prakkie/shared';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

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

async function storeSession(bundle: SessionBundle): Promise<SessionUser> {
  await SecureStore.setItemAsync(KEYS.access, bundle.access_token);
  await SecureStore.setItemAsync(KEYS.refresh, bundle.refresh_token);
  await SecureStore.setItemAsync(KEYS.user, JSON.stringify(bundle.user));
  return bundle.user;
}

export async function currentUser(): Promise<SessionUser | null> {
  const raw = await SecureStore.getItemAsync(KEYS.user);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

/** Guest session on first launch; reuses the stored session afterwards. */
export async function ensureSession(): Promise<SessionUser> {
  const existing = await currentUser();
  if (existing && (await SecureStore.getItemAsync(KEYS.refresh))) return existing;
  const res = await request('/v1/auth/guest', { method: 'POST', body: JSON.stringify({ platform }) });
  if (!res.ok) throw await readError(res);
  return storeSession((await res.json()) as SessionBundle);
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

/** Bearer request with one silent refresh-and-retry on 401. */
export async function authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const attempt = async () =>
    request(path, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${await SecureStore.getItemAsync(KEYS.access)}` },
    });
  let res = await attempt();
  if (res.status === 401 && (await refreshSession())) res = await attempt();
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
