import { describe, expect, it } from 'vitest';
import { matchesPackQuantity, parsePackQuantityQuery, productPackQuantity } from './pack-query';

describe('parsePackQuantityQuery', () => {
  it.each([
    ['kipfilet 500g', 'kipfilet', 500, 'g'],
    ['300 gr', '', 300, 'g'],
    ['appelsap 1L', 'appelsap', 1000, 'ml'],
    ['yoghurt 1,5 kg biologisch', 'yoghurt biologisch', 1500, 'g'],
    ['sap 75 cl', 'sap', 750, 'ml'],
    ['melk 6 x 200 ml', 'melk', 1200, 'ml'],
  ])('parses %s', (raw, text, value, unit) => {
    expect(parsePackQuantityQuery(raw)).toEqual({ text, quantity: { value, unit } });
  });

  it('does not reinterpret product numbers without a package unit', () => {
    expect(parsePackQuantityQuery('7UP zero 1010')).toEqual({
      text: '7UP zero 1010', quantity: null,
    });
  });
});

describe('product pack matching', () => {
  it('uses the explicit title amount before inconsistent metadata', () => {
    expect(productPackQuantity({
      name: 'Kipfilet voordeelpak 800 g', pack_size_value: 600, pack_size_unit: 'g',
    })).toEqual({ value: 800, unit: 'g' });
  });

  it('matches only the same amount and unit family', () => {
    const wanted = parsePackQuantityQuery('500gr').quantity;
    expect(matchesPackQuantity({ name: 'Kwark 500 g' }, wanted)).toBe(true);
    expect(matchesPackQuantity({ name: 'Kwark 0,5 kg' }, wanted)).toBe(true);
    expect(matchesPackQuantity({ name: 'Kwark 450 g' }, wanted)).toBe(false);
    expect(matchesPackQuantity({ name: 'Water 500 ml' }, wanted)).toBe(false);
  });
});
