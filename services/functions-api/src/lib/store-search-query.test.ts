import { describe, expect, it } from 'vitest';
import {
  MAX_STORE_SEARCH_TOKENS,
  buildStorePrefixTsQuery,
  buildStorePrefixTsQueries,
  hasMoreStoreProducts,
  parseStorePage,
  parseStoreSearchTokens,
} from './store-search-query';

describe('store search query', () => {
  it('turns multiple partial words into an order-independent AND prefix query', () => {
    expect(parseStoreSearchTokens('  Bruin volko  ')).toEqual(['bruin', 'volko']);
    expect(buildStorePrefixTsQuery('Bruin volko')).toBe('bruin:* & volko:*');
  });

  it('also exposes a partial-coverage fallback instead of returning an empty list', () => {
    expect(buildStorePrefixTsQueries('Bruin volko')).toEqual({
      tokens: ['bruin', 'volko'],
      all: 'bruin:* & volko:*',
      any: 'bruin:* | volko:*',
    });
  });

  it('keeps short useful searches such as Fijn', () => {
    expect(buildStorePrefixTsQuery('Fijn')).toBe('fijn:*');
  });

  it('folds case and accents and ignores punctuation and duplicate terms', () => {
    expect(parseStoreSearchTokens('CRÈME, brulée — crème')).toEqual(['creme', 'brulee']);
  });

  it('bounds pathological input without emitting user-controlled tsquery syntax', () => {
    const words = Array.from({ length: MAX_STORE_SEARCH_TOKENS + 4 }, (_, index) => `woord${index}`);
    const tokens = parseStoreSearchTokens(`${words.join(' ')} %:* & !`);
    expect(tokens).toHaveLength(MAX_STORE_SEARCH_TOKENS);
    expect(buildStorePrefixTsQuery(`${words.join(' ')} %:* & !`)).toBe(
      tokens.map((token) => `${token}:*`).join(' & ')
    );
  });

  it('returns no query for blank or punctuation-only input', () => {
    expect(buildStorePrefixTsQuery('   ')).toBeNull();
    expect(buildStorePrefixTsQuery('% _ —')).toBeNull();
    expect(buildStorePrefixTsQueries('% _ —')).toBeNull();
  });
});

describe('store product pagination', () => {
  it('uses stable defaults and clamps unsafe values', () => {
    expect(parseStorePage(null, null)).toEqual({ limit: 60, offset: 0 });
    expect(parseStorePage('999', '-4')).toEqual({ limit: 300, offset: 0 });
    expect(parseStorePage('2.9', '60.8')).toEqual({ limit: 2, offset: 60 });
    expect(parseStorePage('oops', 'Infinity')).toEqual({ limit: 60, offset: 0 });
  });

  it('reports a next page only while unseen rows remain', () => {
    expect(hasMoreStoreProducts({ limit: 60, offset: 0 }, 60, 121)).toBe(true);
    expect(hasMoreStoreProducts({ limit: 60, offset: 60 }, 60, 120)).toBe(false);
    expect(hasMoreStoreProducts({ limit: 60, offset: 120 }, 1, 121)).toBe(false);
  });
});
