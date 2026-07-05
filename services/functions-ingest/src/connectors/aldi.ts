import {
  euroToCents,
  parsePackSize,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
  type PromoInfo,
} from './types';

/**
 * Aldi NL silver parser — bronze rows from scrapers/aldi.py.
 * raw = <Algolia search hit> + optional { detail: <Next.js PRODUCT_DETAIL_GET product> }.
 * The Algolia hit carries name/brand/salesUnit/currentPrice/assets/categoryIDs;
 * EAN / nutrition are genuinely sparse at Aldi even on the detail page, so
 * coverage is honestly partial (capabilities.eans = false, fullAssortment = false).
 * Weekly offers may have no currentPrice at all (price only in prose, e.g.
 * "Elders 2.09.") — those rows are unpriceable and skipped.
 */

interface AldiPrice {
  priceValue?: number | null;
  priceTagLabels?: { promoText1?: string | null } | null;
  validFrom?: number | null; // epoch seconds
  validUntil?: number | null; // epoch seconds
  validFromLocalDate?: string | null;
  validUntilLocalDate?: string | null;
}

interface AldiAsset {
  type?: string | null;
  url?: string | null;
}

interface AldiHit {
  objectID?: string | null;
  name?: string | null;
  brandName?: string | null;
  salesUnit?: string | null;
  productSlug?: string | null;
  isAvailable?: boolean | null;
  categoryIDs?: string[] | null;
  mainCategoryID?: string | null;
  assets?: AldiAsset[] | null;
  currentPrice?: AldiPrice | null;
  promotionPrices?: AldiPrice[] | null;
  detail?: {
    gtin?: string | null;
    ean?: string | null;
    assets?: AldiAsset[] | null;
  } | null;
}

function epochToIso(seconds: number | null | undefined): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** prefer the 'primary' asset, else the first one with a url */
function pickImage(assets: AldiAsset[] | null | undefined): string | null {
  if (!assets?.length) return null;
  const primary = assets.find((a) => a.type === 'primary' && a.url);
  return primary?.url ?? assets.find((a) => !!a.url)?.url ?? null;
}

export const aldiConnector: ChainConnector = {
  chainId: 'aldi',
  capabilities: { promos: true, eans: false, deepLinks: true, fullAssortment: false },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const hit = envelope.raw as AldiHit;
    const skuId = hit.objectID ?? envelope.external_id;
    if (!skuId || !hit.name) return null;

    const priceCents = euroToCents(hit.currentPrice?.priceValue);
    if (priceCents === null) return null; // unpriced rows are useless for comparison

    const pack = parsePackSize(hit.salesUnit);

    // A currentPrice with promo tag labels (e.g. "OP=OP") or entries in
    // promotionPrices marks a weekly-offer price; Aldi exposes no structured
    // pre-promo base price, so price_cents mirrors the offer price.
    const mechanic = hit.currentPrice?.priceTagLabels?.promoText1 ?? undefined;
    const isPromo = !!mechanic || !!hit.promotionPrices?.length;
    const promo: PromoInfo | null = isPromo
      ? {
          type: 'promo',
          price_cents: priceCents,
          mechanic,
          valid_from: epochToIso(hit.currentPrice?.validFrom),
          valid_to: epochToIso(hit.currentPrice?.validUntil),
        }
      : null;

    return {
      skuId: String(skuId),
      ean: hit.detail?.gtin ?? hit.detail?.ean ?? null, // sparse at Aldi; usually null
      name: hit.name,
      brand: hit.brandName ?? null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: null, // Aldi exposes no structured unit price
      stdUnit: null,
      promo,
      categoryPath: (hit.categoryIDs ?? []).filter((c): c is string => !!c),
      imageUrl: pickImage(hit.assets) ?? pickImage(hit.detail?.assets),
      productUrl: hit.productSlug ? `https://www.aldi.nl/product/${hit.productSlug}.html` : null,
      available: hit.isAvailable !== false,
    };
  },
};
