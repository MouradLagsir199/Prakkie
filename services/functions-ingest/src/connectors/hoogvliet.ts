import {
  euroToCents,
  parsePackSize,
  unitPriceFromPack,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

interface HoogvlietAttribute {
  name?: string | null;
  values?: string[] | null;
}

interface HoogvlietItem {
  itemno?: string | null;
  title?: string | null;
  price?: number | null;
  brand?: string | null;
  image?: string | null;
  url?: string | null;
  attributes?: HoogvlietAttribute[] | null;
}

interface HoogvlietDetail {
  listPrice?: string | number | null;
  availability?: boolean | null;
  inStock?: boolean | null;
  categoryHierarchy?: string | null;
  baseUnit?: string | null;
  ratioBasePackingUnit?: string | number | null;
  sku?: string | null;
}

const validEan = (value: unknown): string | null => {
  const ean = String(value ?? '').trim();
  return /^(?:\d{8}|\d{12,14})$/.test(ean) ? ean : null;
};

function attributes(item: HoogvlietItem): Map<string, string> {
  return new Map(
    (item.attributes ?? [])
      .filter((entry) => !!entry.name && !!entry.values?.[0])
      .map((entry) => [entry.name!.toLowerCase(), entry.values![0]!])
  );
}

function packText(baseUnit: string | null | undefined, ratio: string | number | null | undefined): string {
  const unit = String(baseUnit ?? '')
    .toLowerCase()
    .replace(/^gram$/, 'g')
    .replace(/^milliliter$/, 'ml')
    .replace(/^liter$/, 'l')
    .replace(/^stuk$/, 'stuks');
  return `${ratio ?? ''} ${unit}`;
}

export const hoogvlietConnector: ChainConnector = {
  chainId: 'hoogvliet',
  capabilities: { promos: true, eans: false, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as { item?: HoogvlietItem | null; detail?: HoogvlietDetail | null };
    const item = raw.item;
    const detail = raw.detail;
    const skuId = detail?.sku ?? item?.itemno ?? envelope.external_id;
    if (!skuId || !item?.title) return null;
    const currentPrice = euroToCents(item.price);
    if (currentPrice === null || currentPrice <= 0) return null;

    const attr = attributes(item);
    const listPrice = euroToCents(detail?.listPrice);
    const hasPromo = listPrice !== null && listPrice > currentPrice;
    const priceCents = hasPromo ? listPrice : currentPrice;
    const pack = parsePackSize(
      packText(
        detail?.baseUnit ?? attr.get('baseunit'),
        detail?.ratioBasePackingUnit ?? attr.get('ratiobasepackingunit')
      )
    );
    const perUnit = unitPriceFromPack(priceCents, pack.value, pack.unit);
    const explicitEan =
      attr.get('ean') ?? attr.get('gtin') ?? attr.get('barcode') ?? null;

    return {
      skuId: String(skuId),
      ean: validEan(explicitEan),
      name: item.title,
      brand: item.brand || null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: perUnit.cents,
      stdUnit: perUnit.unit,
      promo: hasPromo ? { type: 'offer', price_cents: currentPrice } : null,
      categoryPath: String(detail?.categoryHierarchy ?? '')
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean),
      imageUrl: item.image ?? null,
      productUrl: item.url ?? null,
      available: detail ? detail.availability !== false && detail.inStock !== false : true,
    };
  },
};
