import type { PullEntityChanges, PushResult, SyncEntityName, SyncMutation } from './sync';
import { SYNC_ENTITY_NAMES } from './sync';

/**
 * Offline-first sync engine (plan/05 WS1) — platform-agnostic core behind the
 * expo-sqlite cache. All reads hit the local store; writes apply optimistically
 * to the store and join a durable mutation queue; `sync()` pushes the queue
 * then pulls per-entity deltas. A fresh install (empty store) pulling from
 * epoch reproduces the full account — that is the reinstall/platform-switch
 * guarantee.
 */

export interface CachedRow {
  id: string;
  /** last known server row merged with optimistic local edits */
  row: Record<string, unknown>;
  /** server updated_at of the base copy; null = created locally, never synced */
  updatedAt: string | null;
  deleted: boolean;
}

export interface PendingMutation extends SyncMutation {
  /** monotonically increasing queue position (sqlite AUTOINCREMENT) */
  seq: number;
}

export interface LocalStore {
  getRow(entity: SyncEntityName, id: string): Promise<CachedRow | null>;
  putRow(entity: SyncEntityName, row: CachedRow): Promise<void>;
  removeRow(entity: SyncEntityName, id: string): Promise<void>;
  listRows(entity: SyncEntityName): Promise<CachedRow[]>;
  getCursor(entity: SyncEntityName): Promise<string | null>;
  setCursor(entity: SyncEntityName, iso: string): Promise<void>;
  getPending(): Promise<PendingMutation[]>;
  addPending(mutation: SyncMutation): Promise<void>;
  /** replace fields/base of the queued mutation with this seq */
  updatePending(seq: number, fields: Record<string, unknown>, baseUpdatedAt: string | null): Promise<void>;
  removePending(seqs: number[]): Promise<void>;
  removePendingForId(entity: SyncEntityName, id: string): Promise<void>;
  /** wipe everything (sign-out) */
  clear(): Promise<void>;
}

export interface SyncTransport {
  pull(entity: SyncEntityName, since: string): Promise<PullEntityChanges>;
  push(mutations: SyncMutation[]): Promise<{ results: PushResult[] }>;
}

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  rejected: PushResult[];
}

const EPOCH = '1970-01-01T00:00:00Z';
const PUSH_BATCH = 200;

export class OfflineEngine {
  private store: LocalStore;
  private transport: SyncTransport;
  /** notified after any local change so UI layers can re-query */
  private onChange?: (entity: SyncEntityName) => void;

  // plain field assignment (no TS parameter properties) keeps this runnable
  // under Node's strip-only TS mode (scripts/offline-smoke.mjs)
  constructor(store: LocalStore, transport: SyncTransport, onChange?: (entity: SyncEntityName) => void) {
    this.store = store;
    this.transport = transport;
    this.onChange = onChange;
  }

  /** Optimistic local upsert + queue. Successive edits to the same row coalesce. */
  async upsert(entity: SyncEntityName, id: string, fields: Record<string, unknown>): Promise<void> {
    const cached = await this.store.getRow(entity, id);
    const pendingForRow = (await this.store.getPending()).filter(
      (m) => m.entity === entity && m.id === id && m.op === 'upsert'
    );

    const head = pendingForRow[0];
    if (head) {
      await this.store.updatePending(head.seq, { ...head.fields, ...fields }, head.base_updated_at);
    } else {
      await this.store.addPending({
        entity,
        op: 'upsert',
        id,
        fields,
        base_updated_at: cached?.updatedAt ?? null,
      });
    }

    await this.store.putRow(entity, {
      id,
      row: { ...(cached?.row ?? {}), id, ...fields },
      updatedAt: cached?.updatedAt ?? null,
      deleted: false,
    });
    this.onChange?.(entity);
  }

  /** Local delete + queue; any queued upserts for the row are superseded. */
  async delete(entity: SyncEntityName, id: string): Promise<void> {
    const cached = await this.store.getRow(entity, id);
    await this.store.removePendingForId(entity, id);
    // a row created offline and deleted offline never needs to reach the server
    if (cached?.updatedAt != null) {
      await this.store.addPending({ entity, op: 'delete', id, fields: {}, base_updated_at: cached.updatedAt });
    }
    if (cached) await this.store.putRow(entity, { ...cached, deleted: true });
    this.onChange?.(entity);
  }

  /** Push the queue, then pull per-entity deltas. Safe to call on any trigger. */
  async sync(entities: readonly SyncEntityName[] = SYNC_ENTITY_NAMES): Promise<SyncOutcome> {
    const { pushed, rejected } = await this.push();
    const pulled = await this.pull(entities);
    return { pushed, pulled, rejected };
  }

  private async push(): Promise<{ pushed: number; rejected: PushResult[] }> {
    const rejected: PushResult[] = [];
    let pushed = 0;
    for (;;) {
      const pending = (await this.store.getPending()).slice(0, PUSH_BATCH);
      if (pending.length === 0) break;

      const { results } = await this.transport.push(
        pending.map(({ seq: _seq, ...mutation }) => mutation)
      );
      const bySeq = new Map(pending.map((m) => [`${m.entity}:${m.id}:${m.op}`, m.seq]));
      const done: number[] = [];

      for (const result of results) {
        const entity = result.entity as SyncEntityName;
        const seq =
          bySeq.get(`${result.entity}:${result.id}:upsert`) ?? bySeq.get(`${result.entity}:${result.id}:delete`);
        if (seq !== undefined) done.push(seq);

        if (result.status === 'applied' || result.status === 'conflict_applied') {
          pushed++;
          if (result.row) await this.applyServerRow(entity, result.row);
        } else if (result.status === 'deleted') {
          pushed++;
          if (result.row) await this.applyServerRow(entity, result.row);
          else await this.store.removeRow(entity, result.id);
        } else {
          // forbidden/invalid: drop the optimistic copy when the server never had it
          rejected.push(result);
          const cached = await this.store.getRow(entity, result.id);
          if (cached && cached.updatedAt === null) await this.store.removeRow(entity, result.id);
        }
        this.onChange?.(entity);
      }
      await this.store.removePending(done);
      // results always cover every sent mutation; guard against a server bug looping us
      if (done.length === 0) break;
    }
    return { pushed, rejected };
  }

  private async pull(entities: readonly SyncEntityName[]): Promise<number> {
    let pulled = 0;
    for (const entity of entities) {
      for (;;) {
        const since = (await this.store.getCursor(entity)) ?? EPOCH;
        const { rows, has_more } = await this.transport.pull(entity, since);
        if (rows.length === 0) break;

        const pendingIds = new Set(
          (await this.store.getPending()).filter((m) => m.entity === entity).map((m) => m.id)
        );
        // compare as epoch millis — ISO strings of differing precision don't sort lexically
        let cursorMs = Date.parse(since);
        for (const row of rows) {
          const id = String(row.id);
          const rowMs = Date.parse(String(row.updated_at));
          if (rowMs > cursorMs) cursorMs = rowMs;
          // never clobber a row with unpushed local edits; its push resolves it
          if (pendingIds.has(id)) continue;
          await this.applyServerRow(entity, row);
          pulled++;
        }
        await this.store.setCursor(entity, new Date(cursorMs).toISOString());
        this.onChange?.(entity);
        if (!has_more) break;
        // a full page sharing one timestamp would spin forever — bail, next sync resumes
        if (cursorMs <= Date.parse(since)) break;
      }
    }
    return pulled;
  }

  private async applyServerRow(entity: SyncEntityName, row: Record<string, unknown>): Promise<void> {
    const id = String(row.id);
    const deleted = row.deleted_at != null;
    const updatedAt = row.updated_at != null ? new Date(row.updated_at as string).toISOString() : null;
    await this.store.putRow(entity, { id, row, updatedAt, deleted });
  }
}
