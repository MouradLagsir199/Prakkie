import { extractJsonLdRecipe, type JsonLdRecipe } from '@prakkie/shared';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../lib/db';

/**
 * WS7 — config-driven discovery crawler: one crawl_sources row per site, zero
 * per-site code. Politeness: PrakkieBot UA, ≤1 req/s per domain, robots.txt
 * honoured, blocklist checked before every fetch (same-day takedown).
 * Reuses the WS3 JSON-LD extractor unchanged; validator rejects incomplete.
 */

const UA = 'PrakkieBot/1.0 (+https://prakkie.nl/bot; recepten-index; contact: bot@prakkie.nl)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CrawlStats {
  domain: string;
  discovered: number;
  fetched: number;
  saved: number;
  rejected: number;
  dead: number;
  errors: string[];
}

interface SourceRow {
  id: string;
  domain: string;
  name: string;
  sitemap_url: string | null;
  robots_config: { include?: string };
  enabled: boolean;
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml' }, signal: c.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** minimal robots.txt: Disallow lines for * or PrakkieBot */
async function disallowedPrefixes(domain: string): Promise<string[]> {
  const txt = await fetchText(`https://www.${domain}/robots.txt`, 8000).then((t) => t ?? fetchText(`https://${domain}/robots.txt`, 8000));
  if (!txt) return [];
  const out: string[] = [];
  let applies = false;
  for (const line of txt.split('\n')) {
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    const key = k?.trim().toLowerCase();
    if (key === 'user-agent') applies = v === '*' || v.toLowerCase().includes('prakkiebot');
    else if (applies && key === 'disallow' && v) out.push(v);
  }
  return out;
}

async function discoverUrls(source: SourceRow, cap: number): Promise<string[]> {
  const include = source.robots_config?.include ?? '';
  const seen = new Set<string>();
  const queue = [source.sitemap_url].filter((u): u is string => !!u);
  const urls: string[] = [];
  let sitemapFetches = 0;
  while (queue.length && urls.length < cap && sitemapFetches < 12) {
    const xml = await fetchText(queue.shift()!);
    sitemapFetches++;
    if (!xml) continue;
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const url = m[1]!;
      if (url.endsWith('.xml') || url.endsWith('.xml.gz')) {
        // sitemap index: prefer recipe-ish children
        if (queue.length < 20 && (/recip|recept|gerecht|post/i.test(url) || !include)) queue.push(url);
        continue;
      }
      if (include && !url.includes(include)) continue;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
        if (urls.length >= cap) break;
      }
    }
    await sleep(1000);
  }
  return urls;
}

function validate(recipe: JsonLdRecipe): boolean {
  return !!recipe.name && recipe.ingredients.length >= 2 && recipe.instructions.length >= 1;
}

function toCanonicalRecipe(r: JsonLdRecipe, url: string, siteName: string) {
  return {
    title: r.name,
    origin: 'crawled',
    source_url: url,
    source_author: r.author ?? siteName,
    images: r.images.slice(0, 3),
    servings_base: parseInt(r.recipeYield ?? '', 10) || 2,
    time_prep_min: r.prepMinutes,
    time_cook_min: r.cookMinutes ?? (r.totalMinutes && r.prepMinutes ? r.totalMinutes - r.prepMinutes : r.totalMinutes),
    ingredients: r.ingredients.map((raw) => ({ raw_text: raw, quantity: null, unit: null, item_normalised: null, note: null, confidence: 1 })),
    steps: r.instructions.map((text, i) => ({ order: i + 1, text })),
    nutrition: r.nutrition,
  };
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export async function crawlSource(domain: string, cap = 150): Promise<CrawlStats> {
  const pool = getPool();
  const client = await pool.connect();
  const stats: CrawlStats = { domain, discovered: 0, fetched: 0, saved: 0, rejected: 0, dead: 0, errors: [] };
  try {
    const src = (await client.query(`SELECT * FROM discovery.crawl_sources WHERE domain = $1`, [domain])).rows[0] as SourceRow | undefined;
    if (!src?.enabled) throw new Error(`source ${domain} missing or disabled`);
    const blocked = await client.query(`SELECT 1 FROM discovery.blocklist WHERE domain = $1`, [domain]);
    if (blocked.rowCount) throw new Error(`source ${domain} is blocklisted`);

    const disallow = await disallowedPrefixes(src.domain);
    const urls = (await discoverUrls(src, cap)).filter(
      (u) => !disallow.some((p) => { try { return new URL(u).pathname.startsWith(p); } catch { return false; } })
    );
    stats.discovered = urls.length;

    for (const url of urls) {
      // skip URLs we already have (delta crawl); refresh last_seen
      const existing = await client.query(`UPDATE discovery.crawled_recipes SET last_seen_at = now() WHERE source_url = $1 RETURNING 1`, [url]);
      if (existing.rowCount) continue;

      await sleep(1100); // ≤1 req/s politeness
      const html = await fetchText(url);
      stats.fetched++;
      if (!html) {
        stats.dead++;
        continue;
      }
      const recipe = extractJsonLdRecipe(html);
      if (!recipe || !validate(recipe)) {
        stats.rejected++;
        continue;
      }
      const canonical = toCanonicalRecipe(recipe, url, src.name);
      const contentHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      const dedupKey = createHash('sha256')
        .update(fold(recipe.name!) + '|' + recipe.ingredients.map((i) => fold(i)).sort().join(';'))
        .digest('hex');
      // cross-site syndication dedup: first site wins
      const dupe = await client.query(`SELECT 1 FROM discovery.crawled_recipes WHERE dedup_key = $1`, [dedupKey]);
      if (dupe.rowCount) {
        stats.rejected++;
        continue;
      }
      await client.query(
        `INSERT INTO discovery.crawled_recipes
           (source_id, source_url, title, author, site_name, image_url, recipe, tags, servings, time_total_min, content_hash, dedup_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', $8, $9, $10, $11)
         ON CONFLICT (source_url) DO NOTHING`,
        [
          src.id, url, recipe.name, recipe.author, src.name, recipe.images[0] ?? null,
          JSON.stringify(canonical), parseInt(recipe.recipeYield ?? '', 10) || null,
          recipe.totalMinutes ?? ((recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0) || null),
          contentHash, dedupKey,
        ]
      );
      stats.saved++;
    }
    await client.query(
      `UPDATE discovery.crawl_sources SET last_crawl_at = now(), last_crawl_stats = $2 WHERE id = $1`,
      [src.id, JSON.stringify(stats)]
    );
    return stats;
  } finally {
    client.release();
  }
}
