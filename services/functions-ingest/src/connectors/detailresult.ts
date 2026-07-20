import {
  euroToCents,
  parsePackSize,
  unitPriceFromPack,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

/**
 * Detailresult silver parser — bronze rows from scrapers/dirk.py (web-gateway
 * GraphQL). ONE connector serves both Detailresult chains ('dirk' and
 * 'dekamarkt'); the gateway shape is identical, only the storefront differs.
 *
 * raw = { list: <ListWebGroupProducts assortment row>, detail: <ProductDetail | null> }.
 * The list row carries live store pricing (normalPrice/offerPrice in euros;
 * offerPrice 0.0 = no offer) plus productInformation (name/packaging/brand/
 * department/webgroup/image). The detail payload adds barcode (EAN), images
 * (with pre-built absolute image_url) and declarations.
 */

const FILESERVER_BASE = 'https://web-fileserver.dirk.nl/';

interface DirkProductInformation {
  productId?: number | null;
  headerText?: string | null;
  subText?: string | null;
  packaging?: string | null;
  image?: string | null;
  department?: string | null;
  webgroup?: string | null;
  brand?: string | null;
}

interface DirkListRow {
  productId?: number | null;
  productNumber?: number | null;
  normalPrice?: number | null;
  offerPrice?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  priceDate?: string | null;
  productInformation?: DirkProductInformation | null;
}

interface DirkDetailImage {
  image?: string | null;
  rankNumber?: number | null;
  mainImage?: boolean | null;
  image_url?: string | null;
}

interface DirkDetail {
  productId?: number | null;
  articleNumber?: number | null;
  barcode?: string | null;
  brand?: string | null;
  department?: string | null;
  headerText?: string | null;
  packaging?: string | null;
  webgroup?: string | null;
  images?: (DirkDetailImage | null)[] | null;
}

function imageUrl(listRow: DirkListRow, detail: DirkDetail | null | undefined): string | null {
  const images = detail?.images ?? [];
  const main = images.find((img) => img?.mainImage && img.image_url) ?? images.find((img) => img?.image_url);
  if (main?.image_url) return main.image_url;
  // fall back to the relative path on the list row, joined onto the fileserver
  const rel = listRow.productInformation?.image;
  if (!rel) return null;
  return `${FILESERVER_BASE}${rel.replace(/\\/g, '/').replace(/^\//, '')}?width=500`;
}

export const detailresultConnector: ChainConnector = {
  chainId: 'dirk',
  capabilities: { promos: true, eans: true, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as { list?: DirkListRow | null; detail?: DirkDetail | null };
    const list = raw.list;
    const detail = raw.detail ?? null;
    if (!list?.productId) return null;

    const info = list.productInformation ?? null;
    const name = info?.headerText ?? detail?.headerText ?? null;
    if (!name) return null;

    const priceCents = euroToCents(list.normalPrice);
    if (priceCents === null || priceCents <= 0) return null; // unpriced rows are useless for comparison

    // offerPrice 0.0 means "no offer running"; a positive value is the live offer
    const offerCents = euroToCents(list.offerPrice);
    const hasOffer = offerCents !== null && offerCents > 0 && offerCents < priceCents;

    const pack = parsePackSize(info?.packaging ?? detail?.packaging);
    const perUnit = unitPriceFromPack(priceCents, pack.value, pack.unit);

    return {
      skuId: String(list.productId),
      ean: detail?.barcode ?? null,
      name,
      brand: info?.brand ?? detail?.brand ?? null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: perUnit.cents,
      stdUnit: perUnit.unit,
      promo: hasOffer
        ? {
            type: 'offer',
            price_cents: offerCents,
            valid_from: list.startDate ?? undefined,
            valid_to: list.endDate ?? undefined,
          }
        : null,
      categoryPath: [info?.department ?? detail?.department, info?.webgroup ?? detail?.webgroup].filter(
        (c): c is string => !!c
      ),
      imageUrl: imageUrl(list, detail),
      productUrl: null, // dirk.nl product URLs use slugs not present in the payload
      available: true, // scraper only emits rows present in the store assortment
    };
  },
};
