import { describe, expect, it } from 'vitest';
import { aldiConnector } from './aldi';
import type { BronzeEnvelope } from './types';

// @types/node is not a dependency of this package; declare the one API we need.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
import { readFileSync } from 'node:fs';

// vitest runs from services/functions-ingest (see package.json test script)
const SAMPLE_PATH = '../../scrapers/samples/aldi_bronze.sample.jsonl';

function loadSamples(): BronzeEnvelope[] {
  return readFileSync(SAMPLE_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as BronzeEnvelope);
}

describe('aldiConnector', () => {
  const envelopes = loadSamples();

  it('declares aldi chain id and partial-coverage capabilities', () => {
    expect(aldiConnector.chainId).toBe('aldi');
    expect(aldiConnector.capabilities).toEqual({
      promos: true,
      eans: false,
      deepLinks: true,
      fullAssortment: false,
    });
  });

  it('parses all sample lines', () => {
    expect(envelopes).toHaveLength(3);
    const results = envelopes.map((env) => aldiConnector.parse(env));
    // line 1 (Lays Oven Baked) has no structured currentPrice ("Elders 2.09."
    // prose only) — unpriceable, so the parser skips it.
    expect(results[0]).toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[2]).not.toBeNull();
  });

  it('extracts exact values for the first priced product (8-pack Coca-Cola)', () => {
    const product = aldiConnector.parse(envelopes[1]!);
    expect(product).toEqual({
      skuId: '91242742',
      ean: null,
      name: '8-pack Coca-Cola',
      brand: null,
      packSizeValue: 1200, // "8x15 cl" -> 120 cl -> 1200 ml
      packSizeUnit: 'ml',
      priceCents: 359,
      unitPriceCentsPerStd: null,
      stdUnit: null,
      promo: {
        type: 'promo',
        price_cents: 359,
        mechanic: 'OP=OP',
        valid_from: '2026-06-22T22:00:00.000Z', // epoch 1782165600
        valid_to: '2026-06-28T21:59:59.000Z', // epoch 1782683999
      },
      categoryPath: ['offer'],
      imageUrl: 'https://s7g10.scene7.com/is/image/aldinord/91242742_week27',
      productUrl: 'https://www.aldi.nl/product/8-pack-coca-cola-91242742.html',
      available: true,
    });
  });

  it('extracts brand and single pack size for the third sample (Summit cola)', () => {
    const product = aldiConnector.parse(envelopes[2]!);
    expect(product?.skuId).toBe('91242552');
    expect(product?.brand).toBe('SUMMIT');
    expect(product?.priceCents).toBe(149);
    expect(product?.packSizeValue).toBe(1); // "1 l-1.5 l" -> first match "1 l"
    expect(product?.packSizeUnit).toBe('l');
    expect(product?.promo?.mechanic).toBe('OP=OP');
    expect(product?.productUrl).toBe('https://www.aldi.nl/product/cola-of-energydrink-91242552.html');
  });

  it('returns null for rows missing id, name or price', () => {
    const base = envelopes[1]!;
    const without = (mutate: (raw: Record<string, unknown>) => void): BronzeEnvelope => {
      const clone = JSON.parse(JSON.stringify(base)) as BronzeEnvelope;
      mutate(clone.raw);
      return clone;
    };
    // without objectID the parser falls back to envelope.external_id
    expect(aldiConnector.parse(without((raw) => delete raw.objectID))).not.toBeNull();
    const noId = without((raw) => delete raw.objectID);
    noId.external_id = '';
    expect(aldiConnector.parse(noId)).toBeNull();
    expect(aldiConnector.parse(without((raw) => delete raw.name))).toBeNull();
    expect(aldiConnector.parse(without((raw) => delete raw.currentPrice))).toBeNull();
  });
});
