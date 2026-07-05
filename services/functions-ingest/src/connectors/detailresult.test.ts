import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { detailresultConnector } from './detailresult';
import type { BronzeEnvelope } from './types';

// vitest runs from services/functions-ingest; the sample lives at the repo root
const SAMPLE = resolve(process.cwd(), '../../scrapers/samples/dirk_bronze.sample.jsonl');

function loadSamples(): BronzeEnvelope[] {
  return readFileSync(SAMPLE, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BronzeEnvelope);
}

describe('detailresultConnector', () => {
  it('parses all sample bronze envelopes', () => {
    const envelopes = loadSamples();
    expect(envelopes.length).toBeGreaterThanOrEqual(1);
    const parsed = envelopes.map((e) => detailresultConnector.parse(e));
    expect(parsed.filter((p) => p !== null).length).toBeGreaterThanOrEqual(1);
    // this sample is fully hydrated: every line should parse
    expect(parsed.every((p) => p !== null)).toBe(true);
  });

  it('extracts exact literal values for the first sample product (69583)', () => {
    const first = loadSamples()[0]!;
    const p = detailresultConnector.parse(first);
    expect(p).not.toBeNull();
    expect(p!.skuId).toBe('69583');
    expect(p!.ean).toBe('8710871316514');
    expect(p!.name).toBe('1 de Beste Minikrieltjes kleinverpakking');
    expect(p!.brand).toBe('1 de Beste');
    expect(p!.packSizeValue).toBe(200);
    expect(p!.packSizeUnit).toBe('g');
    expect(p!.priceCents).toBe(69); // normalPrice 0.69
    expect(p!.promo).toBeNull(); // offerPrice 0.0 = no offer
    expect(p!.categoryPath).toEqual(['Aardappelen, groente & fruit', 'Aardappelen']);
    expect(p!.imageUrl).toBe(
      'https://web-fileserver.dirk.nl/artikelen/198647_1_423502_638605284553352669.png?width=500'
    );
    expect(p!.productUrl).toBeNull();
    expect(p!.available).toBe(true);
  });

  it('returns a promo when offerPrice is set and below normalPrice', () => {
    const first = loadSamples()[0]!;
    const raw = first.raw as { list: { offerPrice: number } };
    raw.list.offerPrice = 0.49;
    const p = detailresultConnector.parse(first);
    expect(p!.priceCents).toBe(69);
    expect(p!.promo).toEqual({
      type: 'offer',
      price_cents: 49,
      valid_from: '2026-06-22T00:00:00.000+02:00',
      valid_to: '2049-12-31T23:59:59.000+01:00',
    });
  });

  it('returns null for rows without id, name or price', () => {
    const base = loadSamples()[0]!;
    const clone = () => JSON.parse(JSON.stringify(base)) as BronzeEnvelope;

    const noId = clone();
    (noId.raw as { list: { productId: number | null } }).list.productId = null;
    expect(detailresultConnector.parse(noId)).toBeNull();

    const noName = clone();
    const nn = noName.raw as {
      list: { productInformation: { headerText: string | null } };
      detail: { headerText: string | null };
    };
    nn.list.productInformation.headerText = null;
    nn.detail.headerText = null;
    expect(detailresultConnector.parse(noName)).toBeNull();

    const noPrice = clone();
    (noPrice.raw as { list: { normalPrice: number | null } }).list.normalPrice = null;
    expect(detailresultConnector.parse(noPrice)).toBeNull();
  });
});
