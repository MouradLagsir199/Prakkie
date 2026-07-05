import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plusConnector } from './plus';
import type { BronzeEnvelope, NormalizedProduct } from './types';

// repo-root sample; vitest runs with cwd = services/functions-ingest
const SAMPLE_PATH = resolve(process.cwd(), '../../scrapers/samples/plus_bronze.sample.jsonl');

function loadSamples(): BronzeEnvelope[] {
  return readFileSync(SAMPLE_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BronzeEnvelope);
}

describe('plusConnector', () => {
  it('declares the plus chain and capabilities', () => {
    expect(plusConnector.chainId).toBe('plus');
    expect(plusConnector.capabilities).toEqual({
      promos: true,
      eans: true,
      deepLinks: true,
      fullAssortment: true,
    });
  });

  it('parses every bronze sample line', () => {
    const parsed = loadSamples()
      .map((env) => plusConnector.parse(env))
      .filter((p): p is NormalizedProduct => p !== null);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed.length).toBe(3); // all sample rows are valid products
  });

  it('extracts exact fields for the first sample product (862259)', () => {
    const first = loadSamples()[0]!;
    const p = plusConnector.parse(first);
    expect(p).toEqual({
      skuId: '862259',
      ean: null,
      name: 'PLUS Runder hamburgers 5 stuks',
      brand: 'PLUS',
      packSizeValue: 500,
      packSizeUnit: 'g',
      priceCents: 499,
      unitPriceCentsPerStd: 998,
      stdUnit: 'kg',
      promo: null,
      categoryPath: ['Vlees, kip, vis, vega', 'Vlees voor BBQ, grill'],
      imageUrl:
        'https://images.ctfassets.net/s0lodsnpsezb/862259_M/16d3b6042bf90ef545a0ad053903eaba/862259.png',
      productUrl: 'https://www.plus.nl/product/plus-runder-hamburgers-5-stuks-stuk-500-g-862259',
      available: true,
    });
  });

  it('maps the free-delivery promo on the second sample (499047)', () => {
    const p = plusConnector.parse(loadSamples()[1]!);
    expect(p?.skuId).toBe('499047');
    expect(p?.priceCents).toBe(669);
    expect(p?.packSizeValue).toBe(1980);
    expect(p?.packSizeUnit).toBe('ml');
    expect(p?.unitPriceCentsPerStd).toBe(338);
    expect(p?.stdUnit).toBe('l');
    expect(p?.promo).toEqual({
      type: 'free_delivery',
      price_cents: undefined,
      mechanic: 'GRATIS BEZORGING BIJ 2 STUKS',
      valid_from: '2026-06-24',
      valid_to: '2026-06-30',
    });
  });

  it('maps the label-only promo on the third sample (270741)', () => {
    const p = plusConnector.parse(loadSamples()[2]!);
    expect(p?.skuId).toBe('270741');
    expect(p?.priceCents).toBe(469);
    expect(p?.promo).toEqual({
      type: 'promotion',
      price_cents: undefined,
      mechanic: '3+1 GRATIS',
      valid_from: '2026-06-10',
      valid_to: '2026-08-04',
    });
  });

  it('returns null for rows without id, name or price', () => {
    const base = loadSamples()[0]!;
    const noRaw = { ...base, raw: {} };
    expect(plusConnector.parse(noRaw)).toBeNull();

    const plp = (base.raw as { plp: Record<string, unknown> }).plp;
    const noName = { ...base, raw: { plp: { ...plp, Name: '', Slug: '' } } };
    expect(plusConnector.parse(noName)).toBeNull();

    const noPrice = { ...base, raw: { plp: { ...plp, OriginalPrice: '' } } };
    expect(plusConnector.parse(noPrice)).toBeNull();

    const noId = { ...base, raw: { plp: { ...plp, SKU: '', Slug: 'geen-nummer' } } };
    expect(plusConnector.parse(noId)).toBeNull();
  });
});
