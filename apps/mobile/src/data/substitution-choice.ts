export interface StoredChainChoice {
  sku_id?: string | null;
  user_pinned?: boolean;
  origin?: 'automatic' | 'bulk_accepted' | 'user_confirmed';
}

/**
 * A completed choice remains reusable after another supermarket becomes the
 * preferred chain. Only automatic, unconfirmed guesses must be reviewed again.
 */
export function reusableChainChoice<T extends StoredChainChoice>(
  matches: Record<string, T> | null | undefined,
  chain: string | null
): T | null {
  if (!chain) return null;
  const entry = matches?.[chain];
  if (!entry?.sku_id) return null;
  return entry.user_pinned || entry.origin === 'user_confirmed'
    ? entry
    : null;
}
