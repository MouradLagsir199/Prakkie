import { app, type InvocationContext } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { QueueServiceClient } from '@azure/storage-queue';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { consumeAiQuota, getAiQuota, tierOf } from '../lib/ai-quota';
import { query } from '../lib/db';
import { env } from '../lib/env';
import { HttpError, handler, json, parseBody, requireAuth } from '../lib/http';
import { detectPlatform, failureKind, hasUsableRecipeSignal, sourceCaptureOf, type LinkContext } from '../lib/import/context';
import { collectLinkContext, isSlowPath } from '../lib/import/platforms';
import { EnrichInput, enrichRecipe } from '../lib/import/enrich-recipe';
import { generateRecipe } from '../lib/import/generate-recipe';
import { parseRecipe } from '../lib/import/parse-recipe';

/**
 * WS3 — POST /v1/import + GET /v1/import/{id} + queue worker (docs/06 §1).
 * Blog JSON-LD and cache hits answer synchronously; every social/video import
 * collects metadata, post text and transcript via the queue before parsing
 * (queue instead of Durable Functions: same 202+poll contract, one less
 * dependency on the Consumption plan).
 */

// v4 invalidates imports with generic social titles/missing thumbnails and the
// old transcript fallback input. Corrected source data must not be hidden by
// an older successful cache entry.
const urlHash = (url: string) => createHash('sha256').update(`metric-nl-v7:${url.trim()}`).digest('hex');

function cacheBlob(hash: string) {
  return BlobServiceClient.fromConnectionString(env.storageConnection)
    .getContainerClient('import-cache')
    .getBlockBlobClient(`${hash}.json`);
}

async function readCache(hash: string): Promise<{ recipe: unknown; warnings: string[] } | null> {
  try {
    const buf = await cacheBlob(hash).downloadToBuffer();
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

async function writeCache(hash: string, payload: { recipe: unknown; warnings: string[] }): Promise<void> {
  const body = JSON.stringify(payload);
  await cacheBlob(hash).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });
}

async function setJob(
  id: string,
  fields: Record<string, unknown>
): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`UPDATE app.import_jobs SET ${sets}, updated_at = now() WHERE id = $1`, [
    id,
    ...keys.map((k) => (typeof fields[k] === 'object' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k])),
  ]);
}

async function finishJob(id: string, ctx: LinkContext): Promise<{ status: number; body: unknown }> {
  if (!hasUsableRecipeSignal(ctx)) {
    const kind = failureKind(ctx.warnings);
    await setJob(id, { status: 'failed', failure_kind: kind, warnings: ctx.warnings });
    return kind === 'transient_503'
      ? { status: 503, body: { error: 'transient', message: 'Bron tijdelijk niet bereikbaar, probeer het zo weer', import_id: id } }
      : { status: 422, body: { error: 'unusable_link', message: 'Geen openbaar recept gevonden op deze link', import_id: id } };
  }
  await setJob(id, { status: 'parsing' });
  // quotum pas hier: mislukte scrapes en cache-hits kosten geen tik — alleen
  // een échte parse-LLM-call telt (lib/ai-quota.ts). De queue-worker heeft
  // geen claims, dus user + tier komen uit de job-rij.
  const owner = await query<{ user_id: string }>(`SELECT user_id FROM app.import_jobs WHERE id = $1`, [id]);
  const userId = owner.rows[0]!.user_id;
  try {
    await consumeAiQuota(userId, await tierOf(userId), 'import');
  } catch (err) {
    if (err instanceof HttpError && err.status === 402) {
      await setJob(id, {
        status: 'failed',
        failure_kind: err.code === 'trial_expired' ? 'trial_expired' : 'quota_exceeded',
        warnings: [err.message],
      });
    }
    throw err;
  }
  const parsed = await parseRecipe(ctx);
  const recipe = { ...parsed, source_capture: sourceCaptureOf(ctx) };
  await setJob(id, { status: 'ready', result_recipe: recipe, warnings: ctx.warnings });
  await writeCache(urlHash(ctx.url), { recipe, warnings: ctx.warnings });
  return { status: 200, body: { import_id: id, recipe, warnings: ctx.warnings } };
}

app.http('import-recipe', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/import',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const body = await parseBody(req, z.object({ url: z.string().url() }));
    const hash = urlHash(body.url);

    // URL-hash cache: re-import of a viral reel = €0 Apify, instant (docs/06 §1)
    const cached = await readCache(hash);
    const id = randomUUID();
    await query(
      `INSERT INTO app.import_jobs (id, user_id, source_url, url_hash, platform, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [id, claims.userId, body.url, hash, null]
    );
    if (cached) {
      await setJob(id, { status: 'ready', result_recipe: cached.recipe, warnings: cached.warnings });
      return json(200, { import_id: id, recipe: cached.recipe, warnings: cached.warnings, cached: true });
    }

    const platform = detectPlatform(body.url);
    await setJob(id, { platform, status: 'scraping' });

    if (isSlowPath(platform)) {
      // 202 + poll; the queue worker owns the slow video tail
      const queueService = QueueServiceClient.fromConnectionString(env.storageConnection);
      await queueService
        .getQueueClient('import-jobs')
        .sendMessage(Buffer.from(JSON.stringify({ importId: id, url: body.url })).toString('base64'));
      return json(202, { import_id: id, status: 'queued' });
    }

    // fast path: ordinary webpages; social/video sources always use the queue
    const ctx = await collectLinkContext(body.url);
    const result = await finishJob(id, ctx);
    if (result.status >= 400) {
      const b = result.body as { error: string; message: string };
      throw new HttpError(result.status, b.error, b.message, { import_id: id });
    }
    return json(result.status, result.body);
  }),
});

app.http('import-status', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'v1/import/{id}',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const r = await query(
      `SELECT id, source_url, platform, status, failure_kind, warnings, result_recipe, created_at
       FROM app.import_jobs WHERE id = $1 AND user_id = $2`,
      [req.params.id, claims.userId]
    );
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Import niet gevonden');
    const job = r.rows[0] as Record<string, unknown>;
    return json(200, {
      import_id: job.id, status: job.status, failure_kind: job.failure_kind,
      warnings: job.warnings, recipe: job.result_recipe, source_url: job.source_url, platform: job.platform,
    });
  }),
});

/**
 * POST /v1/recipes/enrich — "Vul het recept aan" (owner 2026-07-10). De derde
 * AI-actie: de gebruiker drukt zelf op de knop als een geïmporteerd recept nog
 * gaten heeft (hoeveelheden, dun stappenplan). Recepten zijn local-first, dus
 * de huidige recept-staat komt mee in de body en het verrijkte recept gaat
 * terug — de server bewaart niets.
 */
app.http('recipe-enrich', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/recipes/enrich',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const body = await parseBody(req, z.object({ recipe: EnrichInput }));
    await consumeAiQuota(claims.userId, claims.tier, 'enrich');
    const recipe = await enrichRecipe(body.recipe);
    const { quotas } = await getAiQuota(claims.userId, claims.tier);
    return json(200, { recipe, quota: quotas.enrich });
  }),
});

/**
 * POST /v1/recipes/generate — "Genereer recept" (owner 2026-07-10). Vierde
 * AI-actie: bij lege zoekresultaten in Recepten schrijft de AI een compleet
 * recept voor de zoekterm. De client zet het resultaat in het review-scherm;
 * bewaren blijft een bewuste gebruikershandeling.
 */
app.http('recipe-generate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/recipes/generate',
  handler: handler(async (req) => {
    const claims = await requireAuth(req);
    const body = await parseBody(req, z.object({ query: z.string().trim().min(2).max(120) }));
    await consumeAiQuota(claims.userId, claims.tier, 'generate');
    const recipe = await generateRecipe(body.query);
    const { quotas } = await getAiQuota(claims.userId, claims.tier);
    return json(200, { recipe, quota: quotas.generate });
  }),
});

app.storageQueue('import-worker', {
  queueName: 'import-jobs',
  connection: 'AzureWebJobsStorage',
  handler: async (message: unknown, invocation: InvocationContext) => {
    const { importId, url } = message as { importId: string; url: string };
    try {
      await setJob(importId, { status: 'scraping' });
      const ctx = await collectLinkContext(url);
      if (ctx.transcript) await setJob(importId, { status: 'transcribing' });
      await finishJob(importId, ctx);
    } catch (err) {
      invocation.error(`import-worker ${importId}: ${err instanceof Error ? err.message : err}`);
      // op-quotum is al eerlijk op de job gezet door finishJob — niet
      // overschrijven met een misleidende "tijdelijk niet bereikbaar"
      if (err instanceof HttpError && err.status === 402) return;
      await setJob(importId, {
        status: 'failed',
        failure_kind: 'transient_503',
        warnings: [String(err instanceof Error ? err.message : err)],
      }).catch(() => {});
    }
  },
});
