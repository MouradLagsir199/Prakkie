import type { CachedRow, LocalStore, PendingMutation, SyncEntityName, SyncMutation } from '@prakkie/shared';
import * as SQLite from 'expo-sqlite';

/**
 * expo-sqlite implementation of the shared LocalStore (WS1 offline cache).
 * Rows are stored as server-shaped JSON — the zod schemas in @prakkie/shared
 * describe them; sqlite only needs to key, list and queue.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS entity_rows (
  entity     TEXT NOT NULL,
  id         TEXT NOT NULL,
  row        TEXT NOT NULL,
  updated_at TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity, id)
);
CREATE TABLE IF NOT EXISTS pending_mutations (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity          TEXT NOT NULL,
  op              TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  id              TEXT NOT NULL,
  fields          TEXT NOT NULL,
  base_updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface RowRecord {
  id: string;
  row: string;
  updated_at: string | null;
  deleted: number;
}

interface PendingRecord {
  seq: number;
  entity: string;
  op: 'upsert' | 'delete';
  id: string;
  fields: string;
  base_updated_at: string | null;
}

export class SqliteStore implements LocalStore {
  private constructor(private db: SQLite.SQLiteDatabase) {}

  static async open(name = 'prakkie.db'): Promise<SqliteStore> {
    const db = await SQLite.openDatabaseAsync(name);
    await db.execAsync(SCHEMA);
    return new SqliteStore(db);
  }

  private toCached(r: RowRecord): CachedRow {
    return { id: r.id, row: JSON.parse(r.row), updatedAt: r.updated_at, deleted: r.deleted === 1 };
  }

  async getRow(entity: SyncEntityName, id: string): Promise<CachedRow | null> {
    const r = await this.db.getFirstAsync<RowRecord>(
      'SELECT id, row, updated_at, deleted FROM entity_rows WHERE entity = ? AND id = ?',
      [entity, id]
    );
    return r ? this.toCached(r) : null;
  }

  async putRow(entity: SyncEntityName, row: CachedRow): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO entity_rows (entity, id, row, updated_at, deleted) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entity, id) DO UPDATE SET row = excluded.row, updated_at = excluded.updated_at, deleted = excluded.deleted`,
      [entity, row.id, JSON.stringify(row.row), row.updatedAt, row.deleted ? 1 : 0]
    );
  }

  async removeRow(entity: SyncEntityName, id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM entity_rows WHERE entity = ? AND id = ?', [entity, id]);
  }

  async listRows(entity: SyncEntityName): Promise<CachedRow[]> {
    const rows = await this.db.getAllAsync<RowRecord>(
      'SELECT id, row, updated_at, deleted FROM entity_rows WHERE entity = ?',
      [entity]
    );
    return rows.map((r) => this.toCached(r));
  }

  async getCursor(entity: SyncEntityName): Promise<string | null> {
    const r = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM sync_state WHERE key = ?',
      [`cursor:${entity}`]
    );
    return r?.value ?? null;
  }

  async setCursor(entity: SyncEntityName, iso: string): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [`cursor:${entity}`, iso]
    );
  }

  async getPending(): Promise<PendingMutation[]> {
    const rows = await this.db.getAllAsync<PendingRecord>(
      'SELECT seq, entity, op, id, fields, base_updated_at FROM pending_mutations ORDER BY seq ASC'
    );
    return rows.map((r) => ({
      seq: r.seq,
      entity: r.entity as SyncEntityName,
      op: r.op,
      id: r.id,
      fields: JSON.parse(r.fields),
      base_updated_at: r.base_updated_at,
    }));
  }

  async addPending(m: SyncMutation): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO pending_mutations (entity, op, id, fields, base_updated_at) VALUES (?, ?, ?, ?, ?)',
      [m.entity, m.op, m.id, JSON.stringify(m.fields), m.base_updated_at]
    );
  }

  async updatePending(seq: number, fields: Record<string, unknown>, base: string | null): Promise<void> {
    await this.db.runAsync('UPDATE pending_mutations SET fields = ?, base_updated_at = ? WHERE seq = ?', [
      JSON.stringify(fields),
      base,
      seq,
    ]);
  }

  async removePending(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    await this.db.runAsync(
      `DELETE FROM pending_mutations WHERE seq IN (${seqs.map(() => '?').join(',')})`,
      seqs
    );
  }

  async removePendingForId(entity: SyncEntityName, id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM pending_mutations WHERE entity = ? AND id = ?', [entity, id]);
  }

  /** sign-out: local cache is a replica, the account lives on the server */
  async clear(): Promise<void> {
    await this.db.execAsync('DELETE FROM entity_rows; DELETE FROM pending_mutations; DELETE FROM sync_state;');
  }
}
