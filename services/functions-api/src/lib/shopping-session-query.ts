import { z } from 'zod';
import { HttpError } from './http';

/** Keeps the incremental URL comfortably below common proxy URL limits. */
export const MAX_SHOPPING_SESSION_ITEM_IDS = 100;

const itemIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(MAX_SHOPPING_SESSION_ITEM_IDS);

/**
 * Parse the optional comma-separated incremental projection. Omission means
 * the full list. A present-but-empty or malformed value is rejected rather
 * than accidentally falling back to an expensive full-list request.
 */
export function parseShoppingSessionItemIds(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;

  const parsed = itemIdsSchema.safeParse(raw.split(',').map((id) => id.trim()));
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_items',
      `items moet 1 tot ${MAX_SHOPPING_SESSION_ITEM_IDS} geldige UUID's bevatten`,
      parsed.error.flatten()
    );
  }

  return [...new Set(parsed.data)];
}
