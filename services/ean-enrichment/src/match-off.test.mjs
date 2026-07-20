import { describe, expect, it } from 'vitest';
import {
  buildOffIndex,
  containedCandidates,
  containedMatch,
  matchProduct,
  normaliseEan,
  packCompatible,
  parseOffQuantity,
  chainPackBase,
  validEan,
} from './match-off.mjs';

const off = (overrides = {}) => ({
  ean: '8710398505392',
  name: 'Duopasta',
  brands: 'Duo Penotti,Penotti',
  quantity: '400 g',
  productQuantity: null,
  productQuantityUnit: null,
  ...overrides,
});

describe('parseOffQuantity', () => {
  it('parses simple, decimal-comma and multipack quantities to base units', () => {
    expect(parseOffQuantity('500 g')).toEqual({ value: 500, unit: 'g' });
    expect(parseOffQuantity('1,5 L')).toEqual({ value: 1500, unit: 'ml' });
    expect(parseOffQuantity('6 x 330 ml')).toEqual({ value: 1980, unit: 'ml' });
    expect(parseOffQuantity('ongeveer een pond')).toBeNull();
  });
});

describe('packCompatible', () => {
  it('accepts within 2%, rejects real differences, stays neutral when unknown', () => {
    const chain = chainPackBase(0.4, 'kg');
    expect(packCompatible(chain, parseOffQuantity('400 g'))).toBe(true);
    expect(packCompatible(chain, parseOffQuantity('750 g'))).toBe(false);
    expect(packCompatible(chain, null)).toBeNull();
    expect(packCompatible(chainPackBase(6, 'stuks'), parseOffQuantity('400 g'))).toBeNull();
  });
});

describe('ean validation', () => {
  it('accepts EAN-8/13 and GTIN-14, rejects junk codes', () => {
    expect(validEan('8710398505392')).toBe(true);
    expect(validEan('12345678')).toBe(true);
    expect(validEan('08710398505392')).toBe(true);
    expect(validEan('123')).toBe(false);
    expect(validEan('abc4567890123')).toBe(false);
    expect(normaliseEan('08710398505392')).toBe('8710398505392');
  });
});

describe('matchProduct', () => {
  it('matches the Penotti case: chain title carries the brand, OFF name does not', () => {
    const index = buildOffIndex([off()]);
    const hit = matchProduct(
      { name: 'Duo Penotti Duopasta', brand: null, pack_size_value: 400, pack_size_unit: 'g' },
      index
    );
    expect(hit).toMatchObject({ ean: '8710398505392', method: 'off_exact' });
  });

  it('matches on token-set when word order differs, with pack confirmation', () => {
    const index = buildOffIndex([off({ name: 'Halfvolle melk houdbaar', ean: '8712345678906', brands: 'Melkan', quantity: '1 l' })]);
    const hit = matchProduct(
      { name: 'Melkan houdbaar halfvolle melk', brand: 'Melkan', pack_size_value: 1, pack_size_unit: 'l' },
      index
    );
    expect(hit).toMatchObject({ ean: '8712345678906', method: 'off_tokens' });
  });

  it('refuses when the same name resolves to multiple EANs (variant ambiguity)', () => {
    const index = buildOffIndex([
      off({ ean: '8712345678906', name: 'Halfvolle melk', brands: null, quantity: null }),
      off({ ean: '8798765432106', name: 'Halfvolle melk', brands: null, quantity: null }),
    ]);
    expect(
      matchProduct({ name: 'Halfvolle melk', brand: null, pack_size_value: null, pack_size_unit: null }, index)
    ).toBeNull();
  });

  it('refuses when pack sizes contradict even though names are identical', () => {
    const index = buildOffIndex([off({ quantity: '750 g' })]);
    expect(
      matchProduct(
        { name: 'Duo Penotti Duopasta', brand: null, pack_size_value: 400, pack_size_unit: 'g' },
        index
      )
    ).toBeNull();
  });

  it('refuses when brands contradict', () => {
    const index = buildOffIndex([off({ name: 'Duopasta', brands: 'Ander Merk' })]);
    expect(
      matchProduct(
        { name: 'Duopasta', brand: 'Penotti', pack_size_value: 400, pack_size_unit: 'g' },
        index
      )
    ).toBeNull();
  });
});

describe('containedMatch', () => {
  it('accepts a subset name only with confirmed brand AND confirmed pack', () => {
    const index = buildOffIndex([off({ name: 'Duopasta hazelnoot' })]);
    const product = {
      name: 'Duo Penotti Duopasta hazelnoot pasta 400 gram pot',
      brand: 'Duo Penotti',
      pack_size_value: 400,
      pack_size_unit: 'g',
    };
    const candidates = containedCandidates(product, index);
    expect(containedMatch(product, candidates)).toMatchObject({ ean: '8710398505392', method: 'off_contained' });
    // zonder verpakkings-bevestiging: geen match
    expect(containedMatch({ ...product, pack_size_value: null }, candidates)).toBeNull();
  });

  it('refuses single-token subsets (too generic)', () => {
    const index = buildOffIndex([off({ name: 'Melk', brands: 'Campina', quantity: '1 l' })]);
    const product = { name: 'Campina magere melk', brand: 'Campina', pack_size_value: 1, pack_size_unit: 'l' };
    expect(containedMatch(product, containedCandidates(product, index))).toBeNull();
  });
});
