import {
  OfflineEngine,
  uuidv7,
  type CachedRow,
  type SyncEntityName,
  type SyncOutcome,
} from '@prakkie/shared';
import { getRandomValues } from 'expo-crypto';
import { useEffect, useState } from 'react';
import { ensureSession, httpTransport, onIdentityChange } from './api';
import { SqliteStore } from './database';
import { resetHouseholdCache } from './households';
import { kv } from './kv';

/**
 * Data layer entry point (WS1): local-first reads, queued writes, sync on
 * demand. Screens read via useEntityRows/listRows and never block on network.
 */

export const newId = () => uuidv7((b) => getRandomValues(b));

type Listener = () => void;
const listeners = new Map<SyncEntityName, Set<Listener>>();

function notify(entity: SyncEntityName) {
  listeners.get(entity)?.forEach((l) => l());
}

let opened: Promise<{ store: SqliteStore; engine: OfflineEngine }> | null = null;

export function getData() {
  opened ??= (async () => {
    const store = await SqliteStore.open();
    const engine = new OfflineEngine(store, httpTransport, notify);
    return { store, engine };
  })();
  return opened;
}

/** Queue a create/update; returns the row id. Never touches the network. */
export async function upsertRow(
  entity: SyncEntityName,
  fields: Record<string, unknown>,
  id: string = newId()
): Promise<string> {
  const { engine } = await getData();
  await engine.upsert(entity, id, fields);
  return id;
}

export async function deleteRow(entity: SyncEntityName, id: string): Promise<void> {
  const { engine } = await getData();
  await engine.delete(entity, id);
}

export async function listRows(entity: SyncEntityName): Promise<CachedRow[]> {
  const { store } = await getData();
  return (await store.listRows(entity)).filter((r) => !r.deleted);
}

/** The replica (rows, cursors, queue) is valid for exactly one account. After
 *  an identity switch — login as someone else, or a dead guest session that got
 *  re-minted — ghost rows from the old account would poison every push (the
 *  server rejects children of parents it never gave this user), which the
 *  engine then correctly rolls back: "alles wat ik doe verdwijnt weer". So:
 *  wipe and re-pull. An empty store pulling from epoch reproduces the full
 *  account — the WS1 reinstall guarantee. */
const REPLICA_OWNER = 'prakkie.replica_owner';

async function ensureReplicaOwner(userId: string): Promise<void> {
  const owner = await kv.getItem(REPLICA_OWNER).catch(() => null);
  if (owner === userId) return;
  const { store } = await getData();
  await store.clear();
  await kv.setItem(REPLICA_OWNER, userId).catch(() => {});
  await resetHouseholdCache();
  for (const entity of listeners.keys()) notify(entity);
}

onIdentityChange((user) => {
  ensureReplicaOwner(user.id).catch(() => {});
});

/** Ensure a session exists, push the queue, pull deltas. Call on foreground/reconnect. */
export async function syncNow(entities?: readonly SyncEntityName[]): Promise<SyncOutcome> {
  const user = await ensureSession();
  await ensureReplicaOwner(user.id);
  const { engine } = await getData();
  return engine.sync(entities);
}

/** Sign-out wipe: server keeps the account; the replica leaves the device. */
export async function clearLocalData(): Promise<void> {
  const { store } = await getData();
  await store.clear();
  for (const entity of listeners.keys()) notify(entity);
}

/** Live view of the local cache: re-renders on any local or synced change. */
export function useEntityRows(entity: SyncEntityName): { rows: CachedRow[]; loading: boolean } {
  const [rows, setRows] = useState<CachedRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = () =>
      listRows(entity).then((r) => {
        if (mounted) {
          setRows(r);
          setLoading(false);
        }
      });
    if (!listeners.has(entity)) listeners.set(entity, new Set());
    const set = listeners.get(entity)!;
    set.add(load);
    load();
    return () => {
      mounted = false;
      set.delete(load);
    };
  }, [entity]);

  return { rows, loading };
}
