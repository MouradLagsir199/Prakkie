import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ChainConnector, NormalizedProduct } from '../connectors/types';
import { getPool } from './db';

/**
 * Shared silver pipeline (plan/05 WS2) — written once, used by all connectors:
 * parse → content-hash → delta upsert → price history on change → availability
 * sweep → chains.last_ingest_* bookkeeping. Kill switch honoured here: a
 * disabled chain never ingests, and killing one chain mid-run cannot touch the
 * other ten (each run is a single-chain transaction).
 */

export interface IngestResult {
  chainId: string;
  parsed: number;
  skipped: number;
  inserted: number;
  updated: number;
  unchanged: number;
  priceChanges: number;
  markedUnavailable: number;
}

export function contentHash(p: NormalizedProduct): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        p.ean, p.name, p.brand, p.packSizeValue, p.packSizeUnit, p.priceCents,
        p.unitPriceCentsPerStd, p.stdUnit, p.promo, p.categoryPath, p.imageUrl,
        p.productUrl, p.available,
      ])
    )
    .digest('hex');
}

async function chainEnabled(client: PoolClient, chainId: string): Promise<boolean> {
  const r = await client.query('SELECT enabled FROM catalog.chains WHERE id = $1', [chainId]);
  return r.rows[0]?.enabled === true;
}

/** longest-prefix category → aisle mapping from catalog.chain_category_map */
async function loadCategoryMap(client: PoolClient, chainId: string): Promise<Map<string, number>> {
  const r = await client.query(
    'SELECT category_prefix, aisle_group_id FROM catalog.chain_category_map WHERE chain_id = $1',
    [chainId]
  );
  return new Map(r.rows.map((row) => [String(row.category_prefix).toLowerCase(), Number(row.aisle_group_id)]));
}

function aisleFor(categoryPath: string[], map: Map<string, number>): number | null {
  const joined = categoryPath.join(' > ').toLowerCase();
  let best: { len: number; id: number } | null = null;
  for (const [prefix, id] of map) {
    if (joined.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, id };
  }
  return best?.id ?? null;
}

export async function ingestChain(
  connector: ChainConnector,
  chainId: string, // 'dirk' or 'dekamarkt' for the shared detailresult connector
  bronzeLines: AsyncIterable<string> | Iterable<string>,
  /** sweep=false for partial (--limit) ingests so they can't mark the rest of the chain unavailable */
  options: {
    sweep?: boolean;
    /**
     * One-time, local-admin bootstrap for a brand-new disabled chain. Never
     * exposed by the function-key HTTP endpoint: a normal disabled chain must
     * remain a hard kill switch.
     */
    allowDisabledBootstrap?: boolean;
  } = {}
): Promise<IngestResult> {
  const pool = getPool();
  const client = await pool.connect();
  const result: IngestResult = {
    chainId, parsed: 0, skipped: 0, inserted: 0, updated: 0,
    unchanged: 0, priceChanges: 0, markedUnavailable: 0,
  };
  const startedAt = new Date();
  try {
    if (!(await chainEnabled(client, chainId)) && options.allowDisabledBootstrap !== true) {
      throw new Error(`chain ${chainId} is disabled (kill switch) — refusing to ingest`);
    }
    const categoryMap = await loadCategoryMap(client, chainId);

    // existing state in one read: hash for delta, price for history rows
    const existing = new Map<string, { hash: string; price: number; promoPrice: number | null }>();
    for (const row of (
      await client.query(
        'SELECT sku_id, content_hash, price_cents, promo_price_cents FROM catalog.products WHERE chain_id = $1',
        [chainId]
      )
    ).rows) {
      existing.set(String(row.sku_id), {
        hash: String(row.content_hash),
        price: Number(row.price_cents),
        promoPrice: row.promo_price_cents === null ? null : Number(row.promo_price_cents),
      });
    }

    const seen = new Set<string>();
    const batch: (NormalizedProduct & { hash: string; aisle: number | null })[] = [];
    const priceRows: { skuId: string; priceCents: number; promo: unknown }[] = [];

    const flush = async () => {
      if (batch.length === 0) return;
      await client.query(
        `INSERT INTO catalog.products (
           chain_id, sku_id, ean, name, brand, pack_size_value, pack_size_unit,
           price_cents, unit_price_cents_per_std, std_unit, promo, promo_price_cents,
           promo_valid_to, category_path, aisle_group_id, image_url, product_url,
           available, content_hash, last_seen_at, updated_at
         )
         SELECT $1, u.sku_id, u.ean, u.name, u.brand, u.pack_size_value, u.pack_size_unit,
                u.price_cents, u.unit_price, u.std_unit, u.promo, u.promo_price_cents,
                u.promo_valid_to, u.category_path::text[], u.aisle_group_id, u.image_url, u.product_url,
                u.available, u.content_hash, now(), now()
         FROM unnest(
           $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[],
           $8::int[], $9::numeric[], $10::text[], $11::jsonb[], $12::int[], $13::timestamptz[],
           $14::text[], $15::smallint[], $16::text[], $17::text[], $18::boolean[], $19::text[]
         ) AS u(sku_id, ean, name, brand, pack_size_value, pack_size_unit, price_cents,
                unit_price, std_unit, promo, promo_price_cents, promo_valid_to, category_path,
                aisle_group_id, image_url, product_url, available, content_hash)
         ON CONFLICT (chain_id, sku_id) DO UPDATE SET
           -- Scraper-EAN wint (verser), maar een NULL van de scraper mag een
           -- OFF-verrijkte EAN (catalog.ean_enrichment, 0034) nooit wissen.
           ean = COALESCE(EXCLUDED.ean, catalog.products.ean),
           name = EXCLUDED.name, brand = EXCLUDED.brand,
           pack_size_value = EXCLUDED.pack_size_value, pack_size_unit = EXCLUDED.pack_size_unit,
           price_cents = EXCLUDED.price_cents, unit_price_cents_per_std = EXCLUDED.unit_price_cents_per_std,
           std_unit = EXCLUDED.std_unit, promo = EXCLUDED.promo,
           promo_price_cents = EXCLUDED.promo_price_cents, promo_valid_to = EXCLUDED.promo_valid_to,
           category_path = EXCLUDED.category_path, aisle_group_id = EXCLUDED.aisle_group_id,
           image_url = EXCLUDED.image_url, product_url = EXCLUDED.product_url,
           available = EXCLUDED.available, content_hash = EXCLUDED.content_hash,
           last_seen_at = now(),
           -- Keep updated_at semantic: price/name/content changed, not merely
           -- observed again. Text-embedding backfills use this to avoid paying
           -- to re-embed the complete catalog after every crawl.
           updated_at = CASE
             WHEN catalog.products.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now()
             ELSE catalog.products.updated_at
           END`,
        [
          chainId,
          batch.map((p) => p.skuId),
          batch.map((p) => p.ean ?? null),
          batch.map((p) => p.name),
          batch.map((p) => p.brand ?? null),
          batch.map((p) => p.packSizeValue ?? null),
          batch.map((p) => p.packSizeUnit ?? null),
          batch.map((p) => p.priceCents),
          batch.map((p) => p.unitPriceCentsPerStd ?? null),
          batch.map((p) => p.stdUnit ?? null),
          batch.map((p) => (p.promo ? JSON.stringify(p.promo) : null)),
          batch.map((p) => p.promo?.price_cents ?? null),
          batch.map((p) => p.promo?.valid_to ?? null),
          batch.map((p) => `{${p.categoryPath.map((c) => JSON.stringify(c)).join(',')}}`),
          batch.map((p) => p.aisle),
          batch.map((p) => p.imageUrl ?? null),
          batch.map((p) => p.productUrl ?? null),
          batch.map((p) => p.available),
          batch.map((p) => p.hash),
        ]
      );
      batch.length = 0;
    };

    await client.query('BEGIN');
    for await (const line of bronzeLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let product: NormalizedProduct | null;
      try {
        product = connector.parse(JSON.parse(trimmed));
      } catch {
        product = null;
      }
      if (!product || seen.has(product.skuId)) {
        result.skipped++;
        continue;
      }
      seen.add(product.skuId);
      result.parsed++;

      const hash = contentHash(product);
      const prev = existing.get(product.skuId);
      if (prev?.hash === hash) {
        result.unchanged++;
        continue; // last_seen bump happens in the sweep below
      }
      if (prev) result.updated++;
      else result.inserted++;

      const promoPrice = product.promo?.price_cents ?? null;
      if (!prev || prev.price !== product.priceCents || prev.promoPrice !== promoPrice) {
        result.priceChanges++;
        priceRows.push({ skuId: product.skuId, priceCents: product.priceCents, promo: product.promo ?? null });
      }
      batch.push({ ...product, hash, aisle: aisleFor(product.categoryPath, categoryMap) });
      if (batch.length >= 500) await flush();
    }
    await flush();

    // bump last_seen for unchanged-but-present rows, then sweep the missing
    const seenIds = [...seen];
    await client.query(
      'UPDATE catalog.products SET last_seen_at = now() WHERE chain_id = $1 AND sku_id = ANY($2)',
      [chainId, seenIds]
    );
    if ((options.sweep ?? true) && seenIds.length > 0) {
      const swept = await client.query(
        `UPDATE catalog.products SET available = false, updated_at = now()
         WHERE chain_id = $1 AND available = true AND NOT (sku_id = ANY($2))`,
        [chainId, seenIds]
      );
      result.markedUnavailable = swept.rowCount ?? 0;
    }

    for (let i = 0; i < priceRows.length; i += 500) {
      const chunk = priceRows.slice(i, i + 500);
      await client.query(
        `INSERT INTO catalog.price_history (chain_id, sku_id, valid_from, price_cents, promo)
         SELECT $1, u.sku_id, $2, u.price_cents, u.promo
         FROM unnest($3::text[], $4::int[], $5::jsonb[]) AS u(sku_id, price_cents, promo)
         ON CONFLICT DO NOTHING`,
        [
          chainId,
          startedAt.toISOString(),
          chunk.map((r) => r.skuId),
          chunk.map((r) => r.priceCents),
          chunk.map((r) => (r.promo ? JSON.stringify(r.promo) : null)),
        ]
      );
    }

    await client.query(
      `UPDATE catalog.chains SET last_ingest_at = now(), last_ingest_status = $2 WHERE id = $1`,
      [chainId, JSON.stringify({ ok: true, ...result, finished_at: new Date().toISOString() })]
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await client
      .query(`UPDATE catalog.chains SET last_ingest_status = $2 WHERE id = $1`, [
        chainId,
        JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      ])
      .catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
