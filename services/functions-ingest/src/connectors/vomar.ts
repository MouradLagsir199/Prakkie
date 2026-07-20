import {
  euroToCents,
  parsePackSize,
  unitPriceFromPack,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

interface VomarImage {
  fileName?: string | null;
  imageType?: string | null;
}

interface VomarProduct {
  id?: string | null;
  articleNumber?: number | string | null;
  description?: string | null;
  contents?: number | string | null;
  unit?: string | null;
  price?: number | null;
  inWebshop?: boolean | null;
  primaryEan?: string | null;
  brand?: string | null;
  images?: VomarImage[] | null;
}

interface VomarRaw {
  product?: VomarProduct | null;
  category_path?: string[] | null;
  product_url?: string | null;
  files_base?: string | null;
}

const validEan = (value: unknown): string | null => {
  const ean = String(value ?? '').trim();
  return /^(?:\d{8}|\d{12,14})$/.test(ean) ? ean : null;
};

function imageUrl(raw: VomarRaw, product: VomarProduct): string | null {
  const image =
    product.images?.find((item) => item.imageType?.toLowerCase() === 'packshot' && item.fileName) ??
    product.images?.find((item) => !!item.fileName);
  if (!image?.fileName) return null;
  return `${(raw.files_base ?? 'https://d3vricquk1sjgf.cloudfront.net').replace(/\/$/, '')}/${image.fileName.replace(/^\//, '')}`;
}

export const vomarConnector: ChainConnector = {
  chainId: 'vomar',
  capabilities: { promos: false, eans: true, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as VomarRaw;
    const product = raw.product;
    if (!product) return null;
    const skuId = product.articleNumber ?? product.id ?? envelope.external_id;
    if (!skuId || !product.description) return null;
    const priceCents = euroToCents(product.price);
    if (priceCents === null || priceCents <= 0) return null;

    const unitText = String(product.unit ?? '')
      .toLowerCase()
      .replace(/^gram$/, 'g')
      .replace(/^milliliter$/, 'ml')
      .replace(/^liter$/, 'l')
      .replace(/^stuk$/, 'stuks');
    const pack = parsePackSize(`${product.contents ?? ''} ${unitText}`);
    const perUnit = unitPriceFromPack(priceCents, pack.value, pack.unit);

    return {
      skuId: String(skuId),
      ean: validEan(product.primaryEan),
      name: product.description,
      brand: product.brand || null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: perUnit.cents,
      stdUnit: perUnit.unit,
      promo: null,
      categoryPath: (raw.category_path ?? []).filter((value): value is string => !!value),
      imageUrl: imageUrl(raw, product),
      productUrl: raw.product_url ?? null,
      available: product.inWebshop !== false,
    };
  },
};
