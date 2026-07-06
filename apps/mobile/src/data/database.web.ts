import type { CachedRow, LocalStore, PendingMutation, SyncEntityName, SyncMutation } from '@prakkie/shared';

/**
 * Web platform fork of the offline store — PERSISTENT, full experience:
 * localStorage-backed implementation of the same LocalStore contract the
 * expo-sqlite adapter fulfils natively. (sqlite-wasm would demand COOP/COEP
 * cross-origin isolation, which breaks loading recipe images from chain CDNs —
 * localStorage keeps offline persistence without that trade-off.)
 */

const P = 'prakkie:'; // key namespace

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(P + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(P + key, JSON.stringify(value));
  } catch {
    /* quota: drop writes rather than crash; server stays source of truth */
  }
}
function remove(key: string): void {
  globalThis.localStorage?.removeItem(P + key);
}

/** per-entity id index so listRows stays O(entity size), not O(storage) */
function ids(entity: string): string[] {
  return read<string[]>(`idx:${entity}`, []);
}
function setIds(entity: string, list: string[]): void {
  write(`idx:${entity}`, list);
}

export class SqliteStore implements LocalStore {
  static async open(_name = 'prakkie.db'): Promise<SqliteStore> {
    return new SqliteStore();
  }

  async getRow(entity: SyncEntityName, id: string): Promise<CachedRow | null> {
    return read<CachedRow | null>(`row:${entity}:${id}`, null);
  }
  async putRow(entity: SyncEntityName, row: CachedRow): Promise<void> {
    write(`row:${entity}:${row.id}`, row);
    const list = ids(entity);
    if (!list.includes(row.id)) setIds(entity, [...list, row.id]);
  }
  async removeRow(entity: SyncEntityName, id: string): Promise<void> {
    remove(`row:${entity}:${id}`);
    setIds(entity, ids(entity).filter((x) => x !== id));
  }
  async listRows(entity: SyncEntityName): Promise<CachedRow[]> {
    return ids(entity)
      .map((id) => read<CachedRow | null>(`row:${entity}:${id}`, null))
      .filter((r): r is CachedRow => r !== null);
  }
  async getCursor(entity: SyncEntityName): Promise<string | null> {
    return read<string | null>(`cursor:${entity}`, null);
  }
  async setCursor(entity: SyncEntityName, iso: string): Promise<void> {
    write(`cursor:${entity}`, iso);
  }
  async getPending(): Promise<PendingMutation[]> {
    return read<PendingMutation[]>('pending', []);
  }
  async addPending(m: SyncMutation): Promise<void> {
    const pending = read<PendingMutation[]>('pending', []);
    const seq = (read<number>('pending:seq', 0) as number) + 1;
    write('pending:seq', seq);
    write('pending', [...pending, { ...m, seq }]);
  }
  async updatePending(seq: number, fields: Record<string, unknown>, base: string | null): Promise<void> {
    write(
      'pending',
      read<PendingMutation[]>('pending', []).map((p) =>
        p.seq === seq ? { ...p, fields, base_updated_at: base } : p
      )
    );
  }
  async removePending(seqs: number[]): Promise<void> {
    write('pending', read<PendingMutation[]>('pending', []).filter((p) => !seqs.includes(p.seq)));
  }
  async removePendingForId(entity: SyncEntityName, id: string): Promise<void> {
    write('pending', read<PendingMutation[]>('pending', []).filter((p) => !(p.entity === entity && p.id === id)));
  }
  async clear(): Promise<void> {
    const keys: string[] = [];
    for (let i = 0; i < (globalThis.localStorage?.length ?? 0); i++) {
      const k = globalThis.localStorage.key(i);
      if (k?.startsWith(P)) keys.push(k);
    }
    keys.forEach((k) => globalThis.localStorage.removeItem(k));
  }
}
