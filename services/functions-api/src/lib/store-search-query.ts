export const MAX_STORE_SEARCH_TOKENS = 8;
export const MAX_STORE_SEARCH_TOKEN_LENGTH = 48;

/**
 * Normalises a human search to safe PostgreSQL prefix-tsquery lexemes.
 *
 * Search is intentionally token based: `Bruin volko` becomes
 * `bruin:* & volko:*`, so every term must prefix a word but their order does
 * not matter. Keeping tsquery syntax out of user input also prevents `%`, `_`
 * and punctuation from changing the meaning of a search.
 */
export function parseStoreSearchTokens(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];

  const folded = raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('nl-NL');
  const words = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const word of words) {
    const token = word.slice(0, MAX_STORE_SEARCH_TOKEN_LENGTH);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
    if (unique.length === MAX_STORE_SEARCH_TOKENS) break;
  }
  return unique;
}

export function buildStorePrefixTsQuery(raw: string | null | undefined): string | null {
  const tokens = parseStoreSearchTokens(raw);
  return tokens.length ? tokens.map((token) => `${token}:*`).join(' & ') : null;
}

export interface StorePrefixTsQueries {
  tokens: string[];
  /** Exact intent: every typed word prefix occurs, in any order. */
  all: string;
  /** Recall fallback: at least one word prefix occurs; rank by token coverage. */
  any: string;
}

/**
 * Returns both search layers. The API should prefer `all`; when that set is
 * empty it can use `any` and rank by matched token count/ratio. This matters
 * for natural incomplete searches such as `Bruin volko`: the current catalog
 * may contain good results for each word without one product containing both.
 */
export function buildStorePrefixTsQueries(
  raw: string | null | undefined
): StorePrefixTsQueries | null {
  const tokens = parseStoreSearchTokens(raw);
  if (!tokens.length) return null;
  const lexemes = tokens.map((token) => `${token}:*`);
  return {
    tokens,
    all: lexemes.join(' & '),
    any: lexemes.join(' | '),
  };
}

export interface StorePage {
  limit: number;
  offset: number;
}

/** One pagination policy for both category and department-wide product lists. */
export function parseStorePage(
  rawLimit: string | null | undefined,
  rawOffset: string | null | undefined,
  defaults: { limit?: number; maxLimit?: number } = {}
): StorePage {
  const defaultLimit = defaults.limit ?? 60;
  const maxLimit = defaults.maxLimit ?? 300;
  const requestedLimit = rawLimit?.trim() ? Number(rawLimit) : defaultLimit;
  const requestedOffset = rawOffset?.trim() ? Number(rawOffset) : 0;

  return {
    limit: Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.floor(requestedLimit), maxLimit))
      : defaultLimit,
    offset: Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0,
  };
}

export function hasMoreStoreProducts(page: StorePage, returned: number, total: number): boolean {
  return page.offset + returned < total;
}
