import {
  parsePackSize,
  unitPriceFromPack,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

interface PicnicSellingUnit {
  id?: string | null;
  name?: string | null;
  brand?: string | null;
  image_id?: string | null;
  display_price?: number | null;
  unit_quantity?: string | null;
  max_count?: number | null;
  ean?: string | null;
  gtin?: string | null;
  barcode?: string | null;
}

interface PicnicRaw {
  selling_unit?: PicnicSellingUnit | null;
  category_path?: string[] | null;
}

const validEan = (value: unknown): string | null => {
  const ean = String(value ?? '').trim();
  return /^(?:\d{8}|\d{12,14})$/.test(ean) ? ean : null;
};

export const picnicConnector: ChainConnector = {
  chainId: 'picnic',
  capabilities: { promos: false, eans: false, deepLinks: false, fullAssortment: false },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as PicnicRaw;
    const unit = raw.selling_unit;
    const skuId = unit?.id ?? envelope.external_id;
    if (!skuId || !unit?.name) return null;
    const priceCents = unit.display_price;
    if (priceCents === null || priceCents === undefined || priceCents <= 0) return null;
    const pack = parsePackSize(unit.unit_quantity);
    const perUnit = unitPriceFromPack(Math.round(priceCents), pack.value, pack.unit);

    return {
      skuId: String(skuId),
      ean: validEan(unit.ean ?? unit.gtin ?? unit.barcode),
      name: unit.name,
      brand: unit.brand || null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents: Math.round(priceCents),
      unitPriceCentsPerStd: perUnit.cents,
      stdUnit: perUnit.unit,
      promo: null,
      categoryPath: (raw.category_path ?? []).filter((part): part is string => !!part),
      imageUrl: unit.image_id
        ? `https://storefront-prod.nl.picnicinternational.com/static/images/${unit.image_id}/medium.png`
        : null,
      productUrl: null,
      available: (unit.max_count ?? 1) > 0,
    };
  },
};
