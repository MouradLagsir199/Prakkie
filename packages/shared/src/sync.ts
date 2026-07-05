/**
 * Client↔server sync protocol (plan/04 §5) — the wire types for
 * GET /v1/sync and POST /v1/sync/push, shared by the API and the mobile
 * offline engine. The server's entity registry (functions-api lib/entities.ts)
 * stays authoritative; this is the client-visible subset.
 */

export const SYNC_ENTITY_NAMES = [
  'recipes',
  'recipe_collections',
  'recipe_notes',
  'lists',
  'list_items',
  'plans',
  'plan_entries',
  'plan_templates',
  'pantry_items',
  'match_corrections',
] as const;

export type SyncEntityName = (typeof SYNC_ENTITY_NAMES)[number];

export interface SyncMutation {
  entity: SyncEntityName;
  op: 'upsert' | 'delete';
  /** client-generated UUID (v7 preferred — sortable) */
  id: string;
  fields: Record<string, unknown>;
  /** server updated_at the client's copy was based on; null = new row */
  base_updated_at: string | null;
}

export type PushStatus = 'applied' | 'conflict_applied' | 'deleted' | 'forbidden' | 'invalid';

export interface PushResult {
  entity: string;
  id: string;
  status: PushStatus;
  message?: string;
  /** the post-mutation server row (absent for forbidden/invalid) */
  row?: Record<string, unknown>;
}

export interface PullEntityChanges {
  rows: Record<string, unknown>[];
  has_more: boolean;
}

/**
 * UUIDv7 (time-ordered) from an injected CSPRNG so the same code runs under
 * Node (crypto.getRandomValues) and React Native (expo-crypto.getRandomValues).
 */
export function uuidv7(getRandomValues: (bytes: Uint8Array) => unknown): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes); // fills in place (WebCrypto contract)
  const now = Date.now();
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
