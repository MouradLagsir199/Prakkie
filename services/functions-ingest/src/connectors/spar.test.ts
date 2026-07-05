import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sparConnector } from './spar';

const samplePath = join(__dirname, '../../../../scrapers/samples/spar_bronze.sample.jsonl');
const lines = readFileSync(samplePath, 'utf8').trim().split('\n');

describe('spar connector', () => {
  it('parses every sample bronze row (all three carry a JSON-LD price)', () => {
    const products = lines.map((l) => sparConnector.parse(JSON.parse(l)));
    expect(products.filter(Boolean).length).toBe(lines.length);
  });

  it('extracts the verified fields of the first sample (White Rock rootbier)', () => {
    const p = sparConnector.parse(JSON.parse(lines[0]!))!;
    expect(p.skuId).toBe('1295691');
    expect(p.ean).toBe('72063013129');
    expect(p.name).toBe('White Rock softdrink rootbier');
    expect(p.brand).toBe('White Rock');
    expect(p.priceCents).toBe(119); // offers.price "1.19"
    expect(p.packSizeValue).toBe(355); // package "355 Milliliter"
    expect(p.packSizeUnit).toBe('ml');
    expect(p.promo).toBeNull();
    expect(p.categoryPath).toEqual([
      'frisdrank, koffie, thee, sappen',
      'frisdrank',
      'frisdrank fruit',
    ]);
    expect(p.imageUrl).toBe(
      'https://media.spar.nl/productdetail/white-rock-softdrink-rootbier-355-Milliliter-1295691-140813.jpg'
    );
    expect(p.productUrl).toBe('https://www.spar.nl/white-rock-softdrink-rootbier-1295691/');
    expect(p.available).toBe(true); // schema.org/InStock
  });

  it('extracts the verified fields of the second sample (Hak wijnzuurkool)', () => {
    const p = sparConnector.parse(JSON.parse(lines[1]!))!;
    expect(p.skuId).toBe('1297392');
    expect(p.ean).toBe('8720600609053');
    expect(p.brand).toBe('Hak');
    expect(p.priceCents).toBe(219);
    expect(p.packSizeValue).toBe(340); // "340 Gram"
    expect(p.packSizeUnit).toBe('g');
    expect(p.categoryPath).toEqual([
      'soepen, conserven, smaakmakers',
      'groenteconserven',
      'overige groenteconserven',
    ]);
  });

  it('third sample (sperziebonen) has empty JSON-LD brand → null', () => {
    const p = sparConnector.parse(JSON.parse(lines[2]!))!;
    expect(p.skuId).toBe('1297503');
    expect(p.ean).toBe('8710401991495');
    expect(p.name).toBe('sperziebonen');
    expect(p.brand).toBeNull(); // jsonld brand "" and raw brand null
    expect(p.priceCents).toBe(199);
    expect(p.packSizeValue).toBe(500);
    expect(p.packSizeUnit).toBe('g');
    expect(p.available).toBe(true);
  });

  it('skips rows without any price', () => {
    const raw = JSON.parse(lines[0]!) as { raw: Record<string, unknown> };
    const offers = (raw.raw.json_ld_product as { offers: Record<string, unknown> }).offers;
    delete offers.price;
    delete raw.raw.json_ld_offer;
    delete raw.raw.price_jsonld;
    delete raw.raw.price_visible;
    delete raw.raw.price_data_layer;
    expect(sparConnector.parse(raw as never)).toBeNull();
  });
});
