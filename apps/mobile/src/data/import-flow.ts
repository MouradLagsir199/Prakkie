import { authedRequest } from './api';
import type { RecipeRowData } from './recipes';

/**
 * Live import flow (WS3 client): POST /v1/import; poll on 202. The parsed
 * recipe is handed to the review screen via this module (too big for params).
 */

export interface ImportOutcome {
  recipe: RecipeRowData;
  warnings: string[];
  importId: string;
}

let pendingReview: ImportOutcome | null = null;
export const setPendingReview = (o: ImportOutcome | null) => (pendingReview = o);
export const takePendingReview = (): ImportOutcome | null => {
  const p = pendingReview;
  pendingReview = null;
  return p;
};

export class ImportError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function importUrl(
  url: string,
  onStatus?: (status: string, progress: number) => void
): Promise<ImportOutcome> {
  onStatus?.('Link ophalen…', 6);
  const res = await authedRequest('/v1/import', { method: 'POST', body: JSON.stringify({ url }) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status === 200) {
    onStatus?.('Klaar', 100);
    return { recipe: body.recipe as RecipeRowData, warnings: (body.warnings as string[]) ?? [], importId: String(body.import_id) };
  }
  if (res.status === 202) {
    const id = String(body.import_id);
    onStatus?.('Video en receptgegevens ophalen…', 18);
    // Fast actors often finish in a few seconds. Poll responsively at first,
    // then ease off while retaining an approximately three-minute tail.
    for (let i = 0; i < 110; i++) {
      await sleep(i < 20 ? 750 : 1750);
      const poll = await authedRequest(`/v1/import/${id}`);
      const job = (await poll.json()) as Record<string, unknown>;
      const status = String(job.status);
      if (status === 'ready') {
        onStatus?.('Klaar', 100);
        return { recipe: job.recipe as RecipeRowData, warnings: (job.warnings as string[]) ?? [], importId: id };
      }
      if (status === 'failed') {
        const kind = String(job.failure_kind ?? 'failed');
        // op-quotum: de server zet zijn eigen nette uitleg in warnings[0]
        const warn = Array.isArray(job.warnings) && job.warnings.length ? String(job.warnings[0]) : null;
        throw new ImportError(
          kind,
          kind === 'unusable_422'
            ? 'Geen openbaar recept gevonden op deze link.'
            : kind === 'quota_exceeded' || kind === 'trial_expired'
              ? warn ?? 'Je import-tegoed voor deze maand is op.'
              : 'Bron tijdelijk niet bereikbaar. Probeer het zo nog eens.'
        );
      }
      if (status === 'parsing') onStatus?.('Recept samenstellen…', 76);
    }
    throw new ImportError('timeout', 'Import duurt te lang — probeer het later opnieuw.');
  }
  throw new ImportError(
    String(body.error ?? res.status),
    String(body.message ?? 'Import mislukt. Controleer de link en probeer opnieuw.')
  );
}
