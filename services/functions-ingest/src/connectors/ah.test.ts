import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ahConnector } from './ah';
import { contentHash } from '../lib/ingest';

const samplePath = join(__dirname, '../../../../scrapers/samples/ah_bronze.sample.jsonl');
const lines = readFileSync(samplePath, 'utf8').trim().split('\n');

describe('ah connector', () => {
  it('parses every sample bronze row', () => {
    const products = lines.map((l) => ahConnector.parse(JSON.parse(l)));
    expect(products.filter(Boolean).length).toBe(lines.length);
  });

  it('extracts the verified fields of the first sample (AH Elstar zak)', () => {
    const p = ahConnector.parse(JSON.parse(lines[0]!))!;
    expect(p.skuId).toBe('123209');
    expect(p.name).toBe('AH Elstar zak');
    expect(p.brand).toBe('AH');
    expect(p.priceCents).toBe(229); // priceBeforeBonus 2.29, not on bonus
    expect(p.promo).toBeNull();
    expect(p.packSizeValue).toBe(1.5);
    expect(p.packSizeUnit).toBe('kg');
    expect(p.unitPriceCentsPerStd).toBe(153); // "prijs per kg €1.53"
    expect(p.stdUnit).toBe('kg');
    expect(p.categoryPath).toEqual(['Fruit, verse sappen', 'Zakken']);
    expect(p.productUrl).toBe('https://www.ah.nl/producten/product/wi123209');
    expect(p.available).toBe(true);
    expect(p.imageUrl).toContain('static.ah.nl');
  });

  it('content hash is stable and change-sensitive', () => {
    const p = ahConnector.parse(JSON.parse(lines[0]!))!;
    expect(contentHash(p)).toBe(contentHash({ ...p }));
    expect(contentHash(p)).not.toBe(contentHash({ ...p, priceCents: p.priceCents + 1 }));
  });
});
