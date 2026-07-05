import type { CachedRow, LocalStore, PendingMutation, SyncEntityName, SyncMutation } from '@prakkie/shared';

/**
 * Web fallback for the offline store (Metro platform fork of database.ts).
 * The Expo web target is a preview, not the offline-first product surface —
 * an in-memory replica per session is enough there; native uses expo-sqlite.
 */
export class SqliteStore implements LocalStore {
  private rows = new Map<string, CachedRow>();
  private cursors = new Map<string, string>();
  private pending: PendingMutation[] = [];
  private seq = 0;

  static async open(_name = 'prakkie.db'): Promise<SqliteStore> {
    return new SqliteStore();
  }

  private key(entity: string, id: string) {
    return `${entity}:${id}`;
  }
  async getRow(entity: SyncEntityName, id: string) {
    return this.rows.get(this.key(entity, id)) ?? null;
  }
  async putRow(entity: SyncEntityName, row: CachedRow) {
    this.rows.set(this.key(entity, row.id), row);
  }
  async removeRow(entity: SyncEntityName, id: string) {
    this.rows.delete(this.key(entity, id));
  }
  async listRows(entity: SyncEntityName) {
    return [...this.rows.entries()].filter(([k]) => k.startsWith(`${entity}:`)).map(([, v]) => v);
  }
  async getCursor(entity: SyncEntityName) {
    return this.cursors.get(entity) ?? null;
  }
  async setCursor(entity: SyncEntityName, iso: string) {
    this.cursors.set(entity, iso);
  }
  async getPending() {
    return [...this.pending];
  }
  async addPending(m: SyncMutation) {
    this.pending.push({ ...m, seq: ++this.seq });
  }
  async updatePending(seq: number, fields: Record<string, unknown>, base: string | null) {
    const m = this.pending.find((p) => p.seq === seq);
    if (m) {
      m.fields = fields;
      m.base_updated_at = base;
    }
  }
  async removePending(seqs: number[]) {
    this.pending = this.pending.filter((p) => !seqs.includes(p.seq));
  }
  async removePendingForId(entity: SyncEntityName, id: string) {
    this.pending = this.pending.filter((p) => !(p.entity === entity && p.id === id));
  }
  async clear() {
    this.rows.clear();
    this.cursors.clear();
    this.pending = [];
  }
}
