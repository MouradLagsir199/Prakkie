import { describe, expect, it } from 'vitest';
import { connectorFor } from './index';
import type { BronzeEnvelope } from './types';

function envelope(store: string, externalId: string, raw: Record<string, unknown>): BronzeEnvelope {
  return {
    store,
    external_id: externalId,
    scraped_at: '2026-07-16T12:00:00.000Z',
    raw,
  };
}

describe('new supermarket connectors', () => {
  it('registers all five chains and reuses the proven Detailresult parser for DekaMarkt', () => {
    for (const chain of ['dekamarkt', 'vomar', 'hoogvliet', 'picnic', 'ekoplaza']) {
      expect(connectorFor(chain), chain).toBeDefined();
    }

    const parsed = connectorFor('dekamarkt')!.parse(
      envelope('dekamarkt', '14759', {
        list: {
          productId: 14759,
          normalPrice: 1.69,
          offerPrice: 0,
          productInformation: {
            headerText: 'Aardappelpuree',
            packaging: '500 g',
            department: 'Aardappelen, groente & fruit',
            webgroup: 'Aardappelen',
          },
        },
        detail: { productId: 14759, barcode: '8718989051204', headerText: 'Aardappelpuree' },
      })
    );

    expect(parsed).toMatchObject({
      skuId: '14759',
      ean: '8718989051204',
      name: 'Aardappelpuree',
      packSizeValue: 500,
      packSizeUnit: 'g',
      priceCents: 169,
      unitPriceCentsPerStd: 338,
      stdUnit: 'kg',
    });
  });

  it('normalises Vomar price, pack, EAN and image without inventing values', () => {
    const parsed = connectorFor('vomar')!.parse(
      envelope('vomar', '151409', {
        product: {
          articleNumber: 151409,
          description: 'Kleine Keuken Rozijntjes',
          contents: '140',
          unit: 'gram',
          price: 3.39,
          inWebshop: true,
          primaryEan: '8718734490470',
          brand: 'Kleine Keuken',
          images: [{ fileName: 'product-images/rozijntjes.png', imageType: 'PackShot' }],
        },
        category_path: ['Baby & Kind', 'Koekjes & Tussendoortjes'],
        files_base: 'https://images.example',
      })
    );

    expect(parsed).toMatchObject({
      skuId: '151409',
      ean: '8718734490470',
      packSizeValue: 140,
      packSizeUnit: 'g',
      priceCents: 339,
      unitPriceCentsPerStd: 2421,
      stdUnit: 'kg',
      imageUrl: 'https://images.example/product-images/rozijntjes.png',
    });
  });

  it('keeps Hoogvliet EAN null when the public catalog does not explicitly provide one', () => {
    const parsed = connectorFor('hoogvliet')!.parse(
      envelope('hoogvliet', '064786000', {
        item: {
          itemno: '064786000',
          title: 'Komkommer',
          price: 0.79,
          attributes: [
            { name: 'BaseUnit', values: ['stuk'] },
            { name: 'RatioBasePackingUnit', values: ['1.0'] },
          ],
        },
        detail: {
          sku: '064786000',
          listPrice: '0.99',
          availability: true,
          inStock: true,
          baseUnit: 'stuk',
          ratioBasePackingUnit: '1',
          categoryHierarchy: 'Aardappelen, groente, fruit/Groente/Komkommer, avocado',
        },
      })
    );

    expect(parsed).toMatchObject({
      skuId: '064786000',
      ean: null,
      priceCents: 99,
      packSizeValue: 1,
      packSizeUnit: 'stuks',
      unitPriceCentsPerStd: 99,
      stdUnit: 'stuks',
      promo: { type: 'offer', price_cents: 79 },
    });
  });

  it('normalises Ekoplaza and only accepts its explicit DefaultScanCode as EAN', () => {
    const parsed = connectorFor('ekoplaza')!.parse(
      envelope('ekoplaza', '198711', {
        product: {
          Id: 198711,
          State: 'Active',
          Number: '0001198711',
          OnlineDescription: 'Truffelboter',
          PriceInclTax: 4.59,
          ListPrice: 5.19,
          Brand: { Description: 'Van de Koe' },
          DefaultScanCode: { Code: '8719689828578' },
          Fields: [
            { Code: 'EENHEID', Value: 'Gram' },
            { Code: 'INHOUD', Value: '75' },
            { Code: 'STOCKCODE', Value: 'in_stock' },
            { Code: 'IMAGEURLHUGE', Value: '//cdn.ekoplaza.nl/product.jpg' },
          ],
        },
        category_path: ['Zuivel en eieren', 'Boter'],
      })
    );

    expect(parsed).toMatchObject({
      skuId: '198711',
      ean: '8719689828578',
      priceCents: 519,
      packSizeValue: 75,
      packSizeUnit: 'g',
      unitPriceCentsPerStd: 6920,
      stdUnit: 'kg',
      promo: { type: 'offer', price_cents: 459 },
      imageUrl: 'https://cdn.ekoplaza.nl/product.jpg',
    });
  });

  it('parses Picnic prices in cents and never derives an EAN from its internal id', () => {
    const parsed = connectorFor('picnic')!.parse(
      envelope('picnic', 'picnic-internal-42', {
        selling_unit: {
          id: 'picnic-internal-42',
          name: 'Volle melk',
          display_price: 149,
          unit_quantity: '1 l',
          image_id: 'abc123',
          max_count: 10,
        },
        category_path: ['Zuivel', 'Melk'],
      })
    );

    expect(parsed).toMatchObject({
      skuId: 'picnic-internal-42',
      ean: null,
      priceCents: 149,
      packSizeValue: 1,
      packSizeUnit: 'l',
      unitPriceCentsPerStd: 149,
      stdUnit: 'l',
      imageUrl:
        'https://storefront-prod.nl.picnicinternational.com/static/images/abc123/medium.png',
    });
  });
});
