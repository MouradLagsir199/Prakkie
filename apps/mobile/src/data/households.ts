import { authedRequest } from './api';
import { kv } from './kv';

/**
 * Household context shared by Boodschappen (added-by log, shared lists) and
 * Profiel (members, invites). Cached in kv so the log renders offline.
 */

export interface HouseholdInfo {
  id: string;
  name: string;
  role: string;
  member_count: number;
}
export interface MemberInfo {
  user_id: string;
  display_name: string | null;
  email: string | null;
  /** owner = admin · editor = mag bewerken · viewer = alleen lezen */
  role: string;
  avatar_url?: string | null;
  last_active_at?: string | null;
}

export const roleLabel = (role: string) =>
  role === 'owner' ? 'admin' : role === 'viewer' ? 'alleen lezen' : 'mag bewerken';

const KV_KEY = 'prakkie.household';

interface CachedHousehold {
  household: HouseholdInfo | null;
  members: MemberInfo[];
}

let memory: CachedHousehold | null = null;

export async function loadHousehold(force = false): Promise<CachedHousehold> {
  if (memory && !force) return memory;
  try {
    const res = await authedRequest('/v1/households');
    if (res.ok) {
      const { households } = (await res.json()) as { households: HouseholdInfo[] };
      const household = households[0] ?? null;
      let members: MemberInfo[] = [];
      if (household) {
        const m = await authedRequest(`/v1/households/${household.id}/members`);
        if (m.ok) members = ((await m.json()) as { members: MemberInfo[] }).members;
      }
      memory = { household, members };
      await kv.setItem(KV_KEY, JSON.stringify(memory)).catch(() => {});
      return memory;
    }
  } catch {
    /* offline → cached */
  }
  const raw = await kv.getItem(KV_KEY).catch(() => null);
  memory = raw ? (JSON.parse(raw) as CachedHousehold) : { household: null, members: [] };
  return memory;
}

export function invalidateHousehold(): void {
  memory = null;
}

/** Identity switch: the cached household belongs to the previous account. */
export async function resetHouseholdCache(): Promise<void> {
  memory = null;
  await kv.setItem(KV_KEY, '').catch(() => {});
}

/** household_id to stamp on newly created lists — shared with the whole house. */
export async function activeHouseholdId(): Promise<string | null> {
  return (await loadHousehold()).household?.id ?? null;
}

export function memberName(members: MemberInfo[], userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = members.find((x) => x.user_id === userId);
  return m?.display_name ?? m?.email?.split('@')[0] ?? null;
}
