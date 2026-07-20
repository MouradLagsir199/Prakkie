import { describe, expect, it } from 'vitest';
import { HttpError } from './http';
import {
  MAX_SHOPPING_SESSION_ITEM_IDS,
  parseShoppingSessionItemIds,
} from './shopping-session-query';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('parseShoppingSessionItemIds', () => {
  it('preserves full-list behavior when items is omitted', () => {
    expect(parseShoppingSessionItemIds(null)).toBeUndefined();
  });

  it('accepts comma-separated UUIDs and removes duplicates', () => {
    expect(parseShoppingSessionItemIds(`${uuid(1)}, ${uuid(2)},${uuid(1)}`)).toEqual([
      uuid(1),
      uuid(2),
    ]);
  });

  it.each(['', 'not-a-uuid', `${uuid(1)},`])('rejects malformed items=%j', (raw) => {
    expect(() => parseShoppingSessionItemIds(raw)).toThrowError(HttpError);
    try {
      parseShoppingSessionItemIds(raw);
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'invalid_items' });
    }
  });

  it('rejects a query larger than the URL-safe bound', () => {
    const raw = Array.from({ length: MAX_SHOPPING_SESSION_ITEM_IDS + 1 }, (_, index) => uuid(index)).join(',');
    expect(() => parseShoppingSessionItemIds(raw)).toThrowError(HttpError);
  });
});
