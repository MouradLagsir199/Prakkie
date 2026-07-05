import { app } from '@azure/functions';
import { z } from 'zod';
import { query } from './db';
import { visibilityWhere, type EntityDef } from './entities';
import { bindValue } from './sync-core';
import { HttpError, handler, json, parseBody, requireAuth } from './http';

/**
 * REST convenience layer over the same entity definitions /v1/sync uses —
 * one source of truth for writable columns and visibility.
 */

const ListQuery = { limitMax: 200, limitDefault: 50 };

export function registerCrud(opts: {
  /** function-name prefix, e.g. 'recipes' */
  name: string;
  /** route base under /api, e.g. 'v1/recipes' */
  route: string;
  def: EntityDef;
  createSchema: z.ZodTypeAny;
  updateSchema: z.ZodTypeAny;
  /** extra WHERE fragments by query param, e.g. { list_id: 't.list_id = ' } */
  filters?: Record<string, string>;
  searchTsv?: boolean;
}) {
  const { name, route, def, createSchema, updateSchema, filters = {}, searchTsv = false } = opts;

  app.http(`${name}-collection`, {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route,
    handler: handler(async (req) => {
      const claims = await requireAuth(req);

      if (req.method === 'GET') {
        const limit = Math.min(Number(req.query.get('limit') ?? ListQuery.limitDefault), ListQuery.limitMax);
        const params: unknown[] = [claims.userId];
        let where = `${visibilityWhere(def)} AND t.deleted_at IS NULL`;
        for (const [param, fragment] of Object.entries(filters)) {
          const value = req.query.get(param);
          if (value !== null) {
            params.push(value);
            where += ` AND ${fragment}$${params.length}`;
          }
        }
        const q = req.query.get('q');
        if (searchTsv && q) {
          params.push(q);
          where += ` AND t.search_tsv @@ plainto_tsquery('dutch', $${params.length})`;
        }
        const result = await query(
          `SELECT t.* FROM ${def.table} t WHERE ${where} ORDER BY t.updated_at DESC LIMIT ${limit}`,
          params
        );
        return json(200, { items: result.rows });
      }

      // POST — create; client may supply its own UUIDv7 id (offline-first)
      const body = (await parseBody(
        req,
        (createSchema as z.ZodObject<z.ZodRawShape>).extend({ id: z.string().uuid().optional() })
      )) as Record<string, unknown>;
      const columns = def.writable.filter((c) => body[c] !== undefined);
      const scopeColumn = def.scope === 'ownerHousehold' ? 'owner_id' : def.scope === 'userKeyed' ? 'user_id' : null;

      if (def.scope === 'listChild' || def.scope === 'planChild') {
        const parentTable = def.scope === 'listChild' ? 'app.lists' : 'app.plans';
        const parentId = def.scope === 'listChild' ? body.list_id : body.plan_id;
        const parent = await query(
          `SELECT 1 FROM ${parentTable} t WHERE t.id = $2 AND (t.owner_id = $1 OR t.household_id IN (SELECT household_id FROM app.household_members WHERE user_id = $1))`,
          [claims.userId, parentId]
        );
        if (!parent.rowCount) throw new HttpError(404, 'not_found', 'Parent not found');
      }

      const allColumns = ['id', ...(scopeColumn ? [scopeColumn] : []), ...columns];
      const values = [
        body.id ?? null, // NULL id → DEFAULT below
        ...(scopeColumn ? [claims.userId] : []),
        ...columns.map((c) => bindValue(def, c, body[c])),
      ];
      const placeholders = allColumns.map((c, i) => (c === 'id' ? `coalesce($1, gen_random_uuid())` : `$${i + 1}`));
      const result = await query(
        `INSERT INTO ${def.table} (${allColumns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        values
      );
      return json(201, result.rows[0]);
    }),
  });

  app.http(`${name}-item`, {
    methods: ['GET', 'PATCH', 'DELETE'],
    authLevel: 'anonymous',
    route: `${route}/{id}`,
    handler: handler(async (req) => {
      const claims = await requireAuth(req);
      const id = z.string().uuid().parse(req.params.id);
      const existing = await query(
        `SELECT t.* FROM ${def.table} t WHERE t.id = $2 AND ${visibilityWhere(def)} AND t.deleted_at IS NULL`,
        [claims.userId, id]
      );
      if (!existing.rowCount) throw new HttpError(404, 'not_found', 'Niet gevonden');

      if (req.method === 'GET') return json(200, existing.rows[0]);

      if (req.method === 'DELETE') {
        await query(`UPDATE ${def.table} SET deleted_at = now() WHERE id = $1`, [id]);
        return json(204, undefined);
      }

      const body = (await parseBody(req, updateSchema)) as Record<string, unknown>;
      const columns = def.writable.filter((c) => body[c] !== undefined);
      if (!columns.length) return json(200, existing.rows[0]);
      const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const result = await query(
        `UPDATE ${def.table} SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...columns.map((c) => bindValue(def, c, body[c]))]
      );
      return json(200, result.rows[0]);
    }),
  });
}
