import { describe, expect, it } from 'vitest';
import {
  OfflineEngine,
  type CachedRow,
  type LocalStore,
  type PendingMutation,
  type SyncTransport,
} from './offline-engine';
import type { PushResult, SyncEntityName, SyncMutation } from './sync';
import { uuidv7 } from './sync';
import { randomFillSync } from 'node:crypto';

const uid = () => uuidv7((b) => randomFillSync(b));

/** In-memory LocalStore — what the expo-sqlite adapter implements on device. */
class MemoryStore implements LocalStore {
  rows = new Map<string, CachedRow>();
  cursors = new Map<string, string>();
  pending: PendingMutation[] = [];
  private seq = 0;

  private key(entity: string, id: string) {
    return `${entity}:${id}`;
  }
  async getRow(entity: SyncEntityName, id: string) {
    return this.rows.get(this.key(entity, id)) ?? null;
  }
  async putRow(entity: SyncEntityName, row: CachedRow) {
    this.rows.set(this.key(entity, row.id), structuredClone(row));
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
    this.pending.push({ ...structuredClone(m), seq: ++this.seq });
  }
  async updatePending(seq: number, fields: Record<string, unknown>, base: string | null) {
    const m = this.pending.find((p) => p.seq === seq);
    if (m) {
      m.fields = structuredClone(fields);
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
    this.seq = 0;
  }
}

/** Minimal fake of the /v1/sync server: LWW rows keyed by entity+id. */
class FakeServer implements SyncTransport {
  tables = new Map<string, Map<string, Record<string, unknown>>>();
  offline = false;
  private clock = Date.parse('2026-07-05T12:00:00Z');

  private table(entity: string) {
    if (!this.tables.has(entity)) this.tables.set(entity, new Map());
    return this.tables.get(entity)!;
  }
  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
  /** server-side write outside the sync channel (e.g. another device) */
  directUpsert(entity: string, id: string, fields: Record<string, unknown>) {
    const t = this.table(entity);
    t.set(id, { ...(t.get(id) ?? { id, deleted_at: null }), ...fields, updated_at: this.tick() });
  }

  async pull(entity: SyncEntityName, since: string) {
    if (this.offline) throw new Error('network unreachable');
    const rows = [...this.table(entity).values()]
      .filter((r) => Date.parse(String(r.updated_at)) > Date.parse(since))
      .sort((a, b) => Date.parse(String(a.updated_at)) - Date.parse(String(b.updated_at)));
    return { rows: structuredClone(rows), has_more: false };
  }

  async push(mutations: SyncMutation[]) {
    if (this.offline) throw new Error('network unreachable');
    const results: PushResult[] = [];
    for (const m of mutations) {
      const t = this.table(m.entity);
      const existing = t.get(m.id);
      if (m.op === 'delete') {
        if (existing) {
          existing.deleted_at = this.tick();
          existing.updated_at = existing.deleted_at;
        }
        results.push({ entity: m.entity, id: m.id, status: 'deleted', row: structuredClone(existing) });
        continue;
      }
      if (m.fields.__forbidden) {
        results.push({ entity: m.entity, id: m.id, status: 'forbidden' });
        continue;
      }
      const conflict =
        existing != null &&
        (m.base_updated_at === null ||
          Date.parse(m.base_updated_at) < Date.parse(String(existing.updated_at)));
      const next = { ...(existing ?? { id: m.id }), ...m.fields, deleted_at: null, updated_at: this.tick() };
      t.set(m.id, next);
      results.push({
        entity: m.entity,
        id: m.id,
        status: conflict ? 'conflict_applied' : 'applied',
        row: structuredClone(next),
      });
    }
    return { results };
  }
}

/** FakeServer whose push responses can be held open — models a slow network
 *  while the user keeps tapping (the web "state doesn't stick" bug class). */
class GatedServer extends FakeServer {
  gate: Promise<void> | null = null;
  override async push(mutations: SyncMutation[]) {
    const result = await super.push(mutations); // request reached the server…
    if (this.gate) await this.gate; // …but the response is still in flight
    return result;
  }
}

function setup() {
  const server = new FakeServer();
  const store = new MemoryStore();
  const engine = new OfflineEngine(store, server);
  return { server, store, engine };
}

function gatedSetup() {
  const server = new GatedServer();
  const store = new MemoryStore();
  const engine = new OfflineEngine(store, server);
  let open!: () => void;
  server.gate = new Promise((r) => (open = r));
  const release = () => {
    open();
    server.gate = null;
  };
  return { server, store, engine, release };
}

/** yield a macrotask so a just-started sync reaches its transport.push await */
const inFlightTick = () => new Promise((r) => setTimeout(r, 0));

describe('offline engine', () => {
  it('airplane-mode edit queues locally and syncs once online', async () => {
    const { server, store, engine } = setup();
    server.offline = true;

    const id = uid();
    await engine.upsert('recipes', id, { title: 'Shakshuka', origin: 'manual' });
    await expect(engine.sync(['recipes'])).rejects.toThrow(); // offline: queue survives
    expect(await store.getPending()).toHaveLength(1);
    expect((await store.getRow('recipes', id))?.row.title).toBe('Shakshuka'); // still readable offline

    server.offline = false;
    const outcome = await engine.sync(['recipes']);
    expect(outcome.pushed).toBe(1);
    expect(await store.getPending()).toHaveLength(0);
    expect(server.tables.get('recipes')?.get(id)?.title).toBe('Shakshuka');
    expect((await store.getRow('recipes', id))?.updatedAt).not.toBeNull(); // server base recorded
  });

  it('reinstall: a fresh store pulls the full account from epoch', async () => {
    const { server, engine } = setup();
    const id = uid();
    await engine.upsert('recipes', id, { title: 'Nasi', origin: 'import' });
    await engine.sync(['recipes']);

    // same account, brand-new device/install
    const fresh = new MemoryStore();
    const engine2 = new OfflineEngine(fresh, server);
    const outcome = await engine2.sync(['recipes']);
    expect(outcome.pulled).toBe(1);
    expect((await fresh.getRow('recipes', id))?.row.title).toBe('Nasi');
  });

  it('coalesces successive offline edits of one row into one mutation', async () => {
    const { server, store, engine } = setup();
    const id = uid();
    await engine.upsert('recipes', id, { title: 'Soep', origin: 'manual' });
    await engine.upsert('recipes', id, { title: 'Tomatensoep' });
    await engine.upsert('recipes', id, { cuisine: 'nl' });

    const pending = await store.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fields).toEqual({ title: 'Tomatensoep', origin: 'manual', cuisine: 'nl' });

    await engine.sync(['recipes']);
    expect(server.tables.get('recipes')?.get(id)?.title).toBe('Tomatensoep');
  });

  it('offline edit of a row another device changed pushes as conflict and adopts server truth', async () => {
    const { server, store, engine } = setup();
    const id = uid();
    await engine.upsert('lists', id, { name: 'Week 27' });
    await engine.sync(['lists']);

    server.directUpsert('lists', id, { name: 'Week 27 (huis)' }); // other device wins meanwhile
    await engine.upsert('lists', id, { sort_order: 3 }); // stale base
    const outcome = await engine.sync(['lists']);

    expect(outcome.rejected).toHaveLength(0);
    const local = await store.getRow('lists', id);
    expect(local?.row.sort_order).toBe(3);
    expect(local?.row.name).toBe('Week 27 (huis)'); // server row after conflict_applied is truth
  });

  it('delete propagates; tombstones from other devices arrive via pull', async () => {
    const { server, store, engine } = setup();
    const a = uid();
    const b = uid();
    await engine.upsert('recipes', a, { title: 'A', origin: 'manual' });
    await engine.upsert('recipes', b, { title: 'B', origin: 'manual' });
    await engine.sync(['recipes']);

    await engine.delete('recipes', a); // local delete
    await engine.sync(['recipes']);
    expect(server.tables.get('recipes')?.get(a)?.deleted_at).not.toBeNull();

    // other device tombstones b
    const t = server.tables.get('recipes')!.get(b)!;
    t.deleted_at = server.tick();
    t.updated_at = t.deleted_at;
    await engine.sync(['recipes']);
    expect((await store.getRow('recipes', b))?.deleted).toBe(true);
    expect((await store.listRows('recipes')).filter((r) => !r.deleted)).toHaveLength(0);
  });

  it('a row created and deleted while offline never reaches the server', async () => {
    const { server, store, engine } = setup();
    const id = uid();
    await engine.upsert('recipes', id, { title: 'Vergissing', origin: 'manual' });
    await engine.delete('recipes', id);
    expect(await store.getPending()).toHaveLength(0);
    await engine.sync(['recipes']);
    expect(server.tables.get('recipes')?.has(id) ?? false).toBe(false);
  });

  it('pull never clobbers rows with unpushed local edits', async () => {
    const { server, store, engine } = setup();
    const id = uid();
    await engine.upsert('recipes', id, { title: 'Origineel', origin: 'manual' });
    await engine.sync(['recipes']);

    server.directUpsert('recipes', id, { title: 'Van server' });
    server.offline = true;
    await engine.upsert('recipes', id, { title: 'Lokaal bewerkt' });
    server.offline = false;

    // pull alone (empty other entities is fine) — pending row must survive
    await engine.sync(['recipes']);
    expect((await store.getRow('recipes', id))?.row.title).not.toBe('Van server');
    expect(await store.getPending()).toHaveLength(0); // push resolved it in the same sync
  });

  it('forbidden mutation is dropped and its never-synced optimistic row removed', async () => {
    const { store, engine } = setup();
    const id = uid();
    await engine.upsert('recipes', id, { title: 'Niet van mij', origin: 'manual', __forbidden: true });
    const outcome = await engine.sync(['recipes']);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.status).toBe('forbidden');
    expect(await store.getRow('recipes', id)).toBeNull();
    expect(await store.getPending()).toHaveLength(0);
  });

  it('an edit made while its row is mid-push is not lost or visually reverted', async () => {
    const { server, store, engine, release } = gatedSetup();
    const id = uid();
    await engine.upsert('list_items', id, { name: 'roomboter', qty: 1 });

    const sync = engine.sync(['list_items']);
    await inFlightTick(); // batch is now awaiting the server response
    await engine.upsert('list_items', id, { matches: { ah: 'sku-1' } }); // the product pick
    release();
    await sync;

    // the pick survives the in-flight batch (old bug: removePending ate it and
    // applyServerRow reverted the row to the server copy without the pick)
    expect((await store.getRow('list_items', id))?.row.matches).toEqual({ ah: 'sku-1' });

    await engine.sync(['list_items']); // re-push lands the merged fields
    expect(server.tables.get('list_items')?.get(id)?.matches).toEqual({ ah: 'sku-1' });
    expect(await store.getPending()).toHaveLength(0);
  });

  it('a delete during the insert push still reaches the server (no ghost revive)', async () => {
    const { server, store, engine, release } = gatedSetup();
    const id = uid();
    await engine.upsert('lists', id, { name: 'Boodschappen 6 juli' });

    const sync = engine.sync(['lists']);
    await inFlightTick();
    await engine.delete('lists', id); // user taps Verwijder while the insert is in flight
    release();
    await sync;

    expect((await store.getRow('lists', id))?.deleted).toBe(true); // never revived

    await engine.sync(['lists']); // queued delete tombstones the row the insert created
    expect(server.tables.get('lists')?.get(id)?.deleted_at).not.toBeNull();
    expect(await store.getPending()).toHaveLength(0);
  });

  it('concurrent sync calls serialise instead of double-pushing the queue', async () => {
    const { server, store, engine } = setup();
    let pushCalls = 0;
    const original = server.push.bind(server);
    server.push = async (mutations) => {
      pushCalls++;
      return original(mutations);
    };

    const id = uid();
    await engine.upsert('recipes', id, { title: 'Dubbel', origin: 'manual' });
    await Promise.all([engine.sync(['recipes']), engine.sync(['recipes'])]);

    expect(pushCalls).toBe(1); // the second sync found an empty queue
    expect(await store.getPending()).toHaveLength(0);
    expect(server.tables.get('recipes')?.get(id)?.title).toBe('Dubbel');
  });

  it('uuidv7 ids are valid v7 and time-ordered', () => {
    const a = uid();
    const b = uid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) <= b.slice(0, 13)).toBe(true);
  });
});
