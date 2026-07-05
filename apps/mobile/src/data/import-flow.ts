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

export async function importUrl(url: string, onStatus?: (s: string) => void): Promise<ImportOutcome> {
  onStatus?.('Link ophalen…');
  const res = await authedRequest('/v1/import', { method: 'POST', body: JSON.stringify({ url }) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status === 200) {
    return { recipe: body.recipe as RecipeRowData, warnings: (body.warnings as string[]) ?? [], importId: String(body.import_id) };
  }
  if (res.status === 202) {
    const id = String(body.import_id);
    onStatus?.('Video wordt uitgeschreven…');
    // poll up to ~3 min (docs/06: common video <15 s, tail up to minutes)
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const poll = await authedRequest(`/v1/import/${id}`);
      const job = (await poll.json()) as Record<string, unknown>;
      const status = String(job.status);
      if (status === 'ready') {
        return { recipe: job.recipe as RecipeRowData, warnings: (job.warnings as string[]) ?? [], importId: id };
      }
      if (status === 'failed') {
        throw new ImportError(
          String(job.failure_kind ?? 'failed'),
          job.failure_kind === 'unusable_422'
            ? 'Geen openbaar recept gevonden op deze link.'
            : 'Bron tijdelijk niet bereikbaar. Probeer het zo nog eens.'
        );
      }
      if (status === 'parsing') onStatus?.('Recept samenstellen…');
    }
    throw new ImportError('timeout', 'Import duurt te lang — probeer het later opnieuw.');
  }
  throw new ImportError(
    String(body.error ?? res.status),
    String(body.message ?? 'Import mislukt. Controleer de link en probeer opnieuw.')
  );
}
