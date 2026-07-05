import { env } from '../env';

/**
 * Shared Apify wrapper (docs/06 §2, verbatim semantics): run-sync-get-dataset-items,
 * format=json&clean=true, ALWAYS maxPaidDatasetItems=1, optional per-actor
 * maxTotalChargeUsd, 120 s default timeout. Single-post imports only — never
 * search/batch from this path.
 */

export class ApifyError extends Error {
  constructor(
    public readonly kind: 'transient' | 'unusable',
    message: string,
    public readonly status?: number
  ) {
    super(message);
  }
}

export interface ApifyOptions {
  timeoutMs?: number;
  maxTotalChargeUsd?: number;
}

export async function runApifyActor(
  actorId: string,
  input: Record<string, unknown>,
  options: ApifyOptions = {}
): Promise<unknown[]> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const params = new URLSearchParams({
    token: env.apifyToken,
    format: 'json',
    clean: 'true',
    maxItems: '1',
  });
  if (options.maxTotalChargeUsd !== undefined) {
    params.set('maxTotalChargeUsd', String(options.maxTotalChargeUsd));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?${params}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, maxPaidDatasetItems: 1 }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const kind = res.status >= 500 || res.status === 429 ? 'transient' : 'unusable';
      throw new ApifyError(kind, `Apify ${actorId} → HTTP ${res.status}`, res.status);
    }
    const items = (await res.json()) as unknown;
    return Array.isArray(items) ? items : [];
  } catch (err) {
    if (err instanceof ApifyError) throw err;
    // abort/timeout/network = transient infra trouble (503 semantics, docs/06 §5)
    throw new ApifyError('transient', `Apify ${actorId} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}
