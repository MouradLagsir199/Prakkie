import { app } from '@azure/functions';
import { z } from 'zod';
import { query, withTransaction } from '../lib/db';
import { SYNC_ENTITIES, getEntity, visibilityWhere, type EntityDef } from '../lib/entities';
import { bindValue, decideFields } from '../lib/sync-core';
import { HttpError, handler, json, parseBody, requireAuth } from '../lib/http';

const PULL_LIMIT = 500;

/**
 * GET /v1/sync?since=<ISO>&entities=recipes,lists,…
 * Per-entity delta pull (plan/04 §5): rows the caller may see with
 * updated_at > since, tombstones included. Cursor = max updated_at returned.
 */
app.http('sync-pull', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/sync',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const since = req.query.get('since') ?? '1970-01-01T00:00:00Z';
    if (Number.isNaN(Date.parse(since))) {
      throw new HttpError(400, 'invalid_since', 'since must be an ISO timestamp');
    }
    const requested = (req.query.get('entities') ?? Object.keys(SYNC_ENTITIES).join(','))
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const unknown = requested.filter((e) => !getEntity(e));
    if (unknown.length) throw new HttpError(400, 'unknown_entities', `Unknown entities: ${unknown.join(', ')}`);

    const changes: Record<string, { rows: unknown[]; has_more: boolean }> = {};
    for (const name of requested) {
      const def = getEntity(name)!;
      const result = await query(
        `SELECT t.* FROM ${def.table} t
         WHERE ${visibilityWhere(def)} AND t.updated_at > $2
         ORDER BY t.updated_at ASC
         LIMIT ${PULL_LIMIT + 1}`,
        [claims.userId, since]
      );
      const rows = result.rows.slice(0, PULL_LIMIT);
      changes[name] = { rows, has_more: result.rows.length > PULL_LIMIT };
    }
    return json(200, { server_time: new Date().toISOString(), since, changes });
  }),
});

const Mutation = z.object({
  entity: z.string(),
  op: z.enum(['upsert', 'delete']),
  id: z.string().uuid(), // client-generated UUIDv7 (plan/04 §5)
  fields: z.record(z.unknown()).default({}),
  base_updated_at: z.string().datetime({ offset: true }).nullable().default(null),
});

interface PushResult {
  entity: string;
  id: string;
  status: 'applied' | 'conflict_applied' | 'deleted' | 'forbidden' | 'invalid';
  message?: string;
  row?: unknown;
}

/**
 * POST /v1/sync/push — client-queued mutations, applied in order.
 * Conflict resolution = LWW per field group (lib/sync-core.ts).
 */
app.http('sync-push', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/sync/push',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const body = await parseBody(req, z.object({ mutations: z.array(Mutation).max(200) }));

    const results: PushResult[] = [];
    for (const mutation of body.mutations) {
      const def = getEntity(mutation.entity);
      if (!def) {
        results.push({ entity: mutation.entity, id: mutation.id, status: 'invalid', message: 'unknown entity' });
        continue;
      }
      try {
        results.push(await applyMutation(claims.userId, def, mutation));
      } catch (err) {
        results.push({
          entity: mutation.entity,
          id: mutation.id,
          status: 'invalid',
          message: err instanceof Error ? err.message : 'failed',
        });
      }
    }
    return json(200, { server_time: new Date().toISOString(), results });
  }),
});

async function applyMutation(
  userId: string,
  def: EntityDef,
  mutation: z.infer<typeof Mutation>
): Promise<PushResult> {
  const base = { entity: mutation.entity, id: mutation.id };
  return withTransaction(async (tx) => {
    const existing = await tx.query(
      `SELECT t.* FROM ${def.table} t WHERE t.id = $2 AND ${visibilityWhere(def)} FOR UPDATE`,
      [userId, mutation.id]
    );
    // an id that exists but isn't visible must behave like a foreign row
    if (!existing.rowCount) {
      const anyRow = await tx.query(`SELECT 1 FROM ${def.table} WHERE id = $1`, [mutation.id]);
      if (anyRow.rowCount) return { ...base, status: 'forbidden' as const };
    }

    if (mutation.op === 'delete') {
      if (!existing.rowCount) return { ...base, status: 'deleted' as const }; // idempotent
      if (def.hasTombstone === false) {
        await tx.query(`DELETE FROM ${def.table} WHERE id = $1`, [mutation.id]);
        return { ...base, status: 'deleted' as const };
      }
      await tx.query(`UPDATE ${def.table} SET deleted_at = now() WHERE id = $1`, [mutation.id]);
      const row = (await tx.query(`SELECT * FROM ${def.table} WHERE id = $1`, [mutation.id])).rows[0];
      return { ...base, status: 'deleted' as const, row };
    }

    const serverRow = existing.rows[0] as { updated_at?: Date } | undefined;
    const { apply, conflict } = decideFields(
      def,
      mutation.fields,
      mutation.base_updated_at,
      serverRow?.updated_at ? new Date(serverRow.updated_at).toISOString() : null
    );

    // checked is client-writable; who/when are always server truth
    if (def.table === 'app.list_items' && 'checked' in apply) {
      (apply as Record<string, unknown>).checked_by = apply.checked ? userId : null;
      (apply as Record<string, unknown>).checked_at = apply.checked ? new Date().toISOString() : null;
    }

    if (serverRow) {
      const columns = Object.keys(apply);
      if (columns.length) {
        const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
        const values = columns.map((c) => bindValue(def, c, apply[c]));
        // resurrect tombstoned rows on upsert so offline edits of a deleted row win visibly
        await tx.query(`UPDATE ${def.table} SET ${sets}, deleted_at = NULL WHERE id = $1`, [
          mutation.id,
          ...values,
        ]);
      }
    } else {
      for (const required of def.insertRequired) {
        if (apply[required] === undefined || apply[required] === null) {
          return { ...base, status: 'invalid' as const, message: `missing required field ${required}` };
        }
      }
      const columns = Object.keys(apply);
      const scopeColumns = def.scope === 'ownerHousehold' ? ['owner_id'] : def.scope === 'userKeyed' ? ['user_id'] : [];
      // children: parent visibility is the insert gate
      if (def.scope === 'listChild' || def.scope === 'planChild') {
        const parentTable = def.scope === 'listChild' ? 'app.lists' : 'app.plans';
        const parentId = def.scope === 'listChild' ? apply.list_id : apply.plan_id;
        const parent = await tx.query(
          `SELECT 1 FROM ${parentTable} t WHERE t.id = $2 AND (t.owner_id = $1 OR t.household_id IN (SELECT household_id FROM app.household_members WHERE user_id = $1))`,
          [userId, parentId]
        );
        if (!parent.rowCount) return { ...base, status: 'forbidden' as const };
      }
      // attribution: who added this row (e.g. list_items.added_by → household log)
      const stampColumns = def.stampUserColumn ? [def.stampUserColumn] : [];
      const allColumns = ['id', ...scopeColumns, ...stampColumns, ...columns];
      const values = [
        mutation.id,
        ...scopeColumns.map(() => userId),
        ...stampColumns.map(() => userId),
        ...columns.map((c) => bindValue(def, c, apply[c])),
      ];
      const placeholders = allColumns.map((_, i) => `$${i + 1}`).join(', ');
      await tx.query(`INSERT INTO ${def.table} (${allColumns.join(', ')}) VALUES (${placeholders})`, values);
    }

    const row = (await tx.query(`SELECT * FROM ${def.table} WHERE id = $1`, [mutation.id])).rows[0];
    return { ...base, status: conflict ? ('conflict_applied' as const) : ('applied' as const), row };
  });
}
