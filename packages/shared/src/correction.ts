import { z } from 'zod';
import { ChainId } from './chains';

/** Per-user match corrections — the E5 learning loop. */

export const MatchCorrection = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  chain_id: ChainId,
  item_normalised: z.string(),
  chosen_sku_id: z.string(),
  rejected_sku_id: z.string().nullable().default(null),
  created_at: z.string().datetime(),
});
export type MatchCorrection = z.infer<typeof MatchCorrection>;
