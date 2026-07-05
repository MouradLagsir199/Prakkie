import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jumboConnector } from './jumbo';

const samplePath = join(__dirname, '../../../../scrapers/samples/jumbo_bronze.sample.jsonl');
const lines = readFileSync(samplePath, 'utf8').trim().split('\n');

describe('jumbo connector', () => {
  it('parses every sample bronze row', () => {
    const products = lines.map((l) => jumboConnector.parse(JSON.parse(l)));
    expect(products.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(products.filter(Boolean).length).toBe(lines.length);
  });

  it('extracts the verified fields of the first sample (Hertog Jan krat)', () => {
    const p = jumboConnector.parse(JSON.parse(lines[0]!))!;
    expect(p.skuId).toBe('865788KRT');
    expect(p.name).toBe('Hertog Jan - Pils - Krat - 24 x 300ML');
    expect(p.brand).toBe('Hertog Jan');
    expect(p.ean).toBe('8710956101158');
    expect(p.priceCents).toBe(2132); // GraphQL price is already cents (€21.32)
    expect(p.promo).toBeNull(); // promoPrice: null
    expect(p.packSizeValue).toBe(7200); // "24 x 300ML" from the title
    expect(p.packSizeUnit).toBe('ml');
    expect(p.unitPriceCentsPerStd).toBe(296); // €2.96 per l, already cents
    expect(p.stdUnit).toBe('l');
    expect(p.categoryPath).toEqual(['Bier en wijn', 'Bier, pils', 'Krat']);
    expect(p.productUrl).toBe(
      'https://www.jumbo.com/producten/hertog-jan-pils-krat-24-x-300ml-865788KRT'
    );
    expect(p.available).toBe(true);
    expect(p.imageUrl).toContain('jumbo.com/dam-images');
  });

  it('maps "pieces" unit prices to stuks (Dole bananen)', () => {
    const p = jumboConnector.parse(JSON.parse(lines[1]!))!;
    expect(p.skuId).toBe('532148ZK');
    expect(p.priceCents).toBe(199);
    expect(p.ean).toBeNull(); // detail carries ean: null for this row
    expect(p.packSizeValue).toBe(5); // "... Bananen 5 Stuks"
    expect(p.packSizeUnit).toBe('stuks');
    expect(p.unitPriceCentsPerStd).toBe(40);
    expect(p.stdUnit).toBe('stuks');
  });
});
