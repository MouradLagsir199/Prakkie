// Live offline-sync smoke (WS1): runs the real @prakkie/shared OfflineEngine
// against the deployed dev API, simulating two installs of one account.
//   Usage: npx esbuild scripts/offline-smoke.mjs --bundle --platform=node --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs [baseUrl]
// Proves: queued offline edit pushes; a brand-new install (empty store) pulls
// the full account (reinstall/platform-switch survival); deletes propagate.
import { randomFillSync } from 'node:crypto';
import { OfflineEngine } from '../packages/shared/src/offline-engine.ts';
import { uuidv7 } from '../packages/shared/src/sync.ts';

const BASE = process.argv[2] ?? 'https://func-prakkie-api-dev.azurewebsites.net/api';
const uid = () => uuidv7((b) => randomFillSync(b));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ---- minimal in-memory LocalStore (same contract the expo-sqlite adapter implements)
function memoryStore() {
  const rows = new Map();
  const cursors = new Map();
  let pending = [];
  let seq = 0;
  return {
    async getRow(e, id) { return structuredClone(rows.get(`${e}:${id}`) ?? null); },
    async putRow(e, r) { rows.set(`${e}:${r.id}`, structuredClone(r)); },
    async removeRow(e, id) { rows.delete(`${e}:${id}`); },
    async listRows(e) { return [...rows.entries()].filter(([k]) => k.startsWith(`${e}:`)).map(([, v]) => structuredClone(v)); },
    async getCursor(e) { return cursors.get(e) ?? null; },
    async setCursor(e, iso) { cursors.set(e, iso); },
    async getPending() { return structuredClone(pending); },
    async addPending(m) { pending.push({ ...structuredClone(m), seq: ++seq }); },
    async updatePending(s, fields, base) { const m = pending.find((p) => p.seq === s); if (m) { m.fields = fields; m.base_updated_at = base; } },
    async removePending(seqs) { pending = pending.filter((p) => !seqs.includes(p.seq)); },
    async removePendingForId(e, id) { pending = pending.filter((p) => !(p.entity === e && p.id === id)); },
    async clear() { rows.clear(); cursors.clear(); pending = []; },
  };
}

// ---- transport = the mobile api.ts logic, minus SecureStore
async function guestSession() {
  const res = await fetch(`${BASE}/v1/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android' }),
  });
  if (res.status !== 201) throw new Error(`guest auth failed: ${res.status}`);
  return res.json();
}

function transport(token) {
  const authed = (path, init = {}) =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  return {
    async pull(entity, since) {
      const res = await authed(`/v1/sync?since=${encodeURIComponent(since)}&entities=${entity}`);
      if (!res.ok) throw new Error(`pull ${entity} → ${res.status}`);
      return (await res.json()).changes[entity] ?? { rows: [], has_more: false };
    },
    async push(mutations) {
      const res = await authed('/v1/sync/push', { method: 'POST', body: JSON.stringify({ mutations }) });
      if (!res.ok) throw new Error(`push → ${res.status}`);
      return res.json();
    },
  };
}

console.log(`offline-smoke against ${BASE}\n`);
const session = await guestSession();
const t = transport(session.access_token);

// device A ("iOS install"): create a recipe while notionally offline, then sync
const storeA = memoryStore();
const engineA = new OfflineEngine(storeA, t);
const recipeId = uid();
await engineA.upsert('recipes', recipeId, {
  title: 'Offline shakshuka',
  origin: 'manual',
  ingredients: [{ raw_text: '4 eieren' }, { raw_text: '400 g gezeefde tomaten' }],
  steps: [{ order: 1, text: 'Alles in de pan.' }],
});
check('edit is readable locally before any network', (await storeA.getRow('recipes', recipeId))?.row.title === 'Offline shakshuka');
check('mutation queued', (await storeA.getPending()).length === 1);

const out1 = await engineA.sync(['recipes']);
check('queued mutation pushed on sync', out1.pushed === 1 && (await storeA.getPending()).length === 0);
check('server updated_at adopted as base', (await storeA.getRow('recipes', recipeId))?.updatedAt != null);

// device B ("Android install after platform switch"): same account, empty store
const storeB = memoryStore();
const engineB = new OfflineEngine(storeB, t);
const out2 = await engineB.sync(['recipes']);
const onB = await storeB.getRow('recipes', recipeId);
check('fresh install pulls the recipe (reinstall/platform-switch survival)', onB?.row.title === 'Offline shakshuka', `pulled=${out2.pulled}`);
check('ingredients intact across devices', Array.isArray(onB?.row.ingredients) && onB.row.ingredients.length === 2);

// B edits offline; A picks it up on next sync
await engineB.upsert('recipes', recipeId, { title: 'Shakshuka (van Android)' });
await engineB.sync(['recipes']);
await engineA.sync(['recipes']);
check('cross-device edit arrives via pull', (await storeA.getRow('recipes', recipeId))?.row.title === 'Shakshuka (van Android)');

// delete on A propagates as tombstone to B
await engineA.delete('recipes', recipeId);
await engineA.sync(['recipes']);
await engineB.sync(['recipes']);
check('delete propagates as tombstone', (await storeB.getRow('recipes', recipeId))?.deleted === true);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll offline-sync smoke checks passed.');
process.exit(failures ? 1 : 0);
