import type { EntityDef } from './entities';

/**
 * Pure conflict logic for /v1/sync/push — LWW per field group (plan/04 §5).
 * Clients send only the fields they changed, plus base_updated_at (the server
 * updated_at their copy was based on).
 *
 * - No conflict (base >= server row): every provided field applies.
 * - Conflict (server row is newer): only whole field groups the client touched
 *   apply — the client's write wins for those groups, the server keeps the
 *   rest. Ungrouped fields fall back to plain LWW: the newer write (the
 *   incoming one, by arrival) wins.
 */

export interface FieldDecision {
  apply: Record<string, unknown>;
  conflict: boolean;
}

export function decideFields(
  def: EntityDef,
  provided: Record<string, unknown>,
  baseUpdatedAt: string | null,
  serverUpdatedAt: string | null
): FieldDecision {
  const writable = Object.fromEntries(
    Object.entries(provided).filter(([k]) => def.writable.includes(k))
  );
  const conflict =
    serverUpdatedAt !== null &&
    (baseUpdatedAt === null || new Date(baseUpdatedAt) < new Date(serverUpdatedAt));
  if (!conflict) return { apply: writable, conflict: false };

  // conflict: expand each touched group to all its provided members
  const apply: Record<string, unknown> = {};
  const grouped = new Set(def.fieldGroups.flat());
  for (const [key, value] of Object.entries(writable)) {
    if (!grouped.has(key)) {
      apply[key] = value; // ungrouped → plain LWW, incoming write wins
      continue;
    }
    const group = def.fieldGroups.find((g) => g.includes(key))!;
    for (const member of group) {
      if (member in writable) apply[member] = writable[member];
    }
  }
  return { apply, conflict: true };
}

/** JSON.stringify jsonb columns so node-postgres binds them as jsonb, not text[]. */
export function bindValue(def: EntityDef, column: string, value: unknown): unknown {
  if (value !== null && value !== undefined && def.jsonb.includes(column)) {
    return JSON.stringify(value);
  }
  return value;
}
