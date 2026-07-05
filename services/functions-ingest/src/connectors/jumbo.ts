import {
  parsePackSize,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

/**
 * Jumbo silver parser — bronze rows from scrapers/jumbo.py (web GraphQL edge).
 * raw = { listing: <SearchMobileProducts card>, detail: <ProductsBatch row | null> }.
 * The listing carries price/link/image; detail (when hydrated) carries the EAN
 * and category tree. All GraphQL prices arrive in CENTS already (price: 2132
 * = €21.32) — no euro conversion.
 */

interface JumboPrice {
  price?: number | null; // cents
  promoPrice?: number | null; // cents
  pricePerUnit?: { price?: number | null; unit?: string | null } | null;
}

interface JumboListing {
  id?: string | null;
  title?: string | null;
  brand?: string | null;
  image?: string | null;
  link?: string | null; // "/producten/<slug>-<sku>"
  price?: JumboPrice | null;
  availability?: { isAvailable?: boolean | null } | null;
  packSizeDisplay?: string | null;
}

interface JumboDetail {
  sku?: string | null;
  ean?: string | null;
  title?: string | null;
  brand?: string | null;
  categories?: { name?: string | null }[] | null;
  image?: string | null;
  price?: JumboPrice | null;
  availability?: { isAvailable?: boolean | null } | null;
}

/** Jumbo unit names → our std units ("pieces" → "stuks"). */
function stdUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const u = unit.toLowerCase();
  if (u === 'pieces' || u === 'piece' || u === 'stuk' || u === 'stuks') return 'stuks';
  if (u === 'liter') return 'l';
  return u; // kg | l already canonical
}

export const jumboConnector: ChainConnector = {
  chainId: 'jumbo',
  capabilities: { promos: true, eans: true, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as { listing?: JumboListing | null; detail?: JumboDetail | null };
    const listing = raw.listing;
    const detail = raw.detail;

    const skuId = detail?.sku ?? listing?.id ?? null;
    const name = listing?.title ?? detail?.title ?? null;
    if (!skuId || !name) return null;

    const price = listing?.price ?? detail?.price;
    const priceCents = price?.price ?? null; // already cents
    if (priceCents === null || priceCents === undefined) return null;

    const promoPriceCents = price?.promoPrice ?? null; // already cents

    // Cards rarely fill packSizeDisplay; the size usually lives in the title
    // ("... Krat - 24 x 300ML", "... Bananen 5 Stuks").
    const pack = parsePackSize(listing?.packSizeDisplay ?? name);

    const perUnit = price?.pricePerUnit;
    const link = listing?.link; // already includes the /producten/ prefix

    return {
      skuId: String(skuId),
      ean: detail?.ean ?? null,
      name,
      brand: listing?.brand ?? detail?.brand ?? null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: perUnit?.price ?? null,
      stdUnit: stdUnit(perUnit?.unit),
      promo:
        promoPriceCents !== null
          ? {
              type: 'promo',
              price_cents: promoPriceCents,
            }
          : null,
      categoryPath: (detail?.categories ?? [])
        .map((c) => c?.name)
        .filter((n): n is string => !!n),
      imageUrl: listing?.image ?? detail?.image ?? null,
      productUrl: link
        ? `https://www.jumbo.com${link}`
        : `https://www.jumbo.com/producten/${skuId}`,
      available:
        (listing?.availability?.isAvailable ?? detail?.availability?.isAvailable) !== false,
    };
  },
};
