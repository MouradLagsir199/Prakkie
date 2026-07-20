import {
  euroToCents,
  parsePackSize,
  unitPriceFromPack,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

interface EkoplazaField {
  Code?: string | null;
  Value?: string | null;
}

interface EkoplazaImage {
  Url?: string | null;
  FilePath?: string | null;
  ImageUrl?: string | null;
}

interface EkoplazaProduct {
  Id?: number | string | null;
  Number?: string | null;
  State?: string | null;
  Description?: string | null;
  OnlineDescription?: string | null;
  PriceInclTax?: number | null;
  ListPrice?: number | null;
  Brand?: { Description?: string | null } | null;
  DefaultScanCode?: { Code?: string | null } | null;
  Fields?: EkoplazaField[] | null;
  Images?: EkoplazaImage[] | null;
  Url?: string | null;
}

interface EkoplazaRaw {
  product?: EkoplazaProduct | null;
  category_path?: string[] | null;
  extra_fields?: Record<string, unknown> | null;
}

const validEan = (value: unknown): string | null => {
  const ean = String(value ?? '').trim();
  return /^(?:\d{8}|\d{12,14})$/.test(ean) ? ean : null;
};

function fieldMap(product: EkoplazaProduct): Map<string, string> {
  return new Map(
    (product.Fields ?? [])
      .filter((field) => !!field.Code && field.Value !== null && field.Value !== undefined)
      .map((field) => [field.Code!.toUpperCase(), String(field.Value)])
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normaliseImage(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://www.ekoplaza.nl${value}`;
  return value;
}

function pickImage(product: EkoplazaProduct, fields: Map<string, string>): string | null {
  const explicit = fields.get('IMAGEURLHUGE') ?? fields.get('IMAGEURL');
  if (explicit) return normaliseImage(explicit);
  const image = product.Images?.find((entry) => entry.ImageUrl || entry.Url || entry.FilePath);
  return normaliseImage(image?.ImageUrl ?? image?.Url ?? image?.FilePath);
}

export const ekoplazaConnector: ChainConnector = {
  chainId: 'ekoplaza',
  capabilities: { promos: true, eans: true, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as EkoplazaRaw;
    const product = raw.product;
    if (!product) return null;
    const skuId = product.Id ?? envelope.external_id;
    if (!skuId) return null;
    const fields = fieldMap(product);
    const name =
      product.OnlineDescription || fields.get('LABELOMSCHRIJVING') || product.Description;
    if (!name) return null;

    const currentPrice = euroToCents(product.PriceInclTax);
    if (currentPrice === null || currentPrice <= 0) return null;
    const listPrice = euroToCents(product.ListPrice);
    const hasPromo = listPrice !== null && listPrice > currentPrice;
    const priceCents = hasPromo ? listPrice : currentPrice;

    const pack = parsePackSize(
      `${fields.get('INHOUD') ?? fields.get('PFC_SIZE') ?? ''} ${
        fields.get('EENHEID') ?? fields.get('PFC_UNIT') ?? ''
      }`
        .toLowerCase()
        .replace(/milliliter/g, 'ml')
        .replace(/kilogram/g, 'kg')
        .replace(/gram/g, 'g')
        .replace(/liter/g, 'l')
    );
    const perUnit = unitPriceFromPack(priceCents, pack.value, pack.unit);
    const number = product.Number ?? String(skuId).padStart(10, '0');
    const stockCode = fields.get('STOCKCODE')?.toLowerCase();

    return {
      skuId: String(skuId),
      ean: validEan(product.DefaultScanCode?.Code),
      name,
      brand: product.Brand?.Description || null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: perUnit.cents,
      stdUnit: perUnit.unit,
      promo: hasPromo ? { type: 'offer', price_cents: currentPrice } : null,
      categoryPath: (raw.category_path ?? []).filter((part): part is string => !!part),
      imageUrl: pickImage(product, fields),
      productUrl:
        product.Url ??
        `https://www.ekoplaza.nl/nl/producten/product/${slugify(name)}-${number}`,
      available: product.State === 'Active' && stockCode !== 'out_of_stock',
    };
  },
};
