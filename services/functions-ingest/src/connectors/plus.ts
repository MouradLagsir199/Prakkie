import {
  euroToCents,
  parsePackSize,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
  type PromoInfo,
} from './types';

/**
 * PLUS silver parser — bronze rows from scrapers/plus.py (OutSystems screen
 * services). raw = { plp: <PLP listing card | absent>, pdp: <PDP data block | absent> }.
 * The PLP card carries price/promo/image/categories in flat PascalCase fields
 * (euro amounts as strings, e.g. OriginalPrice "4.99", NewPrice "0.0" when no
 * promo price); the PDP block nests the rich product under ProductOut.Overview
 * (Price/BaseUnitPrice euro strings, Subtitle like
 * "Per Stuk 500 g  (per kilo €9.98)"). EANs are sparse: the PLP EAN field is
 * usually "" — Medicine.EAN on the PDP is the only other carrier.
 */

interface PlusLogoList {
  List?: { Name?: string; URL?: string }[];
}

interface PlusPlp {
  SKU?: string;
  Brand?: string;
  Name?: string;
  Product_Subtitle?: string;
  Slug?: string;
  ImageURL?: string;
  OriginalPrice?: string;
  NewPrice?: string;
  EAN?: string;
  Packging?: string;
  Categories?: { List?: { Name?: string }[] };
  IsAvailable?: boolean;
  PromotionLabel?: string;
  PromotionBasedLabel?: string;
  PromotionStartDate?: string;
  PromotionEndDate?: string;
  IsFreeDeliveryOffer?: boolean;
  IsOfflineSaleOnly?: boolean;
  Logos?: Record<string, PlusLogoList>;
}

interface PlusPdpOverview {
  Name?: string;
  Subtitle?: string;
  Brand?: string;
  Slug?: string;
  Image?: { Label?: string; URL?: string };
  Price?: string;
  BaseUnitPrice?: string;
  IsAvailableInStore?: boolean;
  IsOfflineSaleOnly?: boolean;
}

interface PlusPdp {
  ProductOut?: {
    Overview?: PlusPdpOverview;
    Categories?: { List?: { Name?: string }[] };
    Medicine?: { EAN?: string };
  };
  ImageURL?: string;
}

const DATE_SENTINEL = '1900-01-01'; // OutSystems null-date

function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t.length > 0 ? t : null;
}

function promoDate(s: string | null | undefined): string | undefined {
  const t = nonEmpty(s);
  return t && t !== DATE_SENTINEL ? t : undefined;
}

/** "Per Stuk 500 g  (per kilo €9.98)" → 'kg' | 'l' | 'stuks' | null */
function stdUnitFromSubtitle(subtitle: string | null | undefined): string | null {
  const m = (subtitle ?? '').toLowerCase().match(/\(per\s+(kilo|kg|liter|l|stuk)\b/);
  if (!m) return null;
  switch (m[1]) {
    case 'kilo':
    case 'kg':
      return 'kg';
    case 'liter':
    case 'l':
      return 'l';
    default:
      return 'stuks';
  }
}

function skuFromSlug(slug: string | null | undefined): string | null {
  const m = (slug ?? '').match(/-(\d+)$/);
  return m ? m[1]! : null;
}

export const plusConnector: ChainConnector = {
  chainId: 'plus',
  capabilities: { promos: true, eans: true, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as { plp?: PlusPlp | null; pdp?: PlusPdp | null };
    const plp = raw.plp ?? null;
    const overview = raw.pdp?.ProductOut?.Overview ?? null;
    if (!plp && !overview) return null;

    const slug = nonEmpty(plp?.Slug) ?? nonEmpty(overview?.Slug);
    const skuId = nonEmpty(plp?.SKU) ?? skuFromSlug(slug);
    const name = nonEmpty(plp?.Name) ?? nonEmpty(overview?.Name);
    if (!skuId || !name) return null;

    // Regular shelf price: PLP OriginalPrice, falling back to the PDP Price.
    const priceCents = euroToCents(nonEmpty(plp?.OriginalPrice) ?? nonEmpty(overview?.Price));
    if (priceCents === null || priceCents <= 0) return null; // unpriced rows are useless for comparison

    // Promo: NewPrice > 0 carries a discounted price; label-only mechanics
    // ("3+1 GRATIS", free-delivery offers) come without one.
    const newPriceCents = euroToCents(nonEmpty(plp?.NewPrice));
    const promoLabel = nonEmpty(plp?.PromotionLabel) ?? nonEmpty(plp?.PromotionBasedLabel);
    let promo: PromoInfo | null = null;
    if ((newPriceCents !== null && newPriceCents > 0) || promoLabel) {
      promo = {
        type: plp?.IsFreeDeliveryOffer ? 'free_delivery' : 'promotion',
        price_cents: newPriceCents !== null && newPriceCents > 0 ? newPriceCents : undefined,
        mechanic: promoLabel ?? undefined,
        valid_from: promoDate(plp?.PromotionStartDate),
        valid_to: promoDate(plp?.PromotionEndDate),
      };
    }

    // "Per 500 g" (PLP) / "Per Stuk 500 g  (per kilo €9.98)" (PDP)
    const pack = parsePackSize(nonEmpty(plp?.Product_Subtitle) ?? nonEmpty(overview?.Subtitle));

    // Unit price: PDP BaseUnitPrice euro amount + unit named in the Subtitle.
    const stdUnit = stdUnitFromSubtitle(overview?.Subtitle);
    const unitPriceCents = stdUnit ? euroToCents(nonEmpty(overview?.BaseUnitPrice)) : null;

    const ean = nonEmpty(plp?.EAN) ?? nonEmpty(raw.pdp?.ProductOut?.Medicine?.EAN);

    const categorySource = plp?.Categories?.List?.length
      ? plp.Categories.List
      : raw.pdp?.ProductOut?.Categories?.List ?? [];
    const categoryPath: string[] = [];
    for (const c of categorySource) {
      const n = nonEmpty(c?.Name);
      if (n && !categoryPath.includes(n)) categoryPath.push(n);
    }

    const imageUrl =
      nonEmpty(plp?.ImageURL) ?? nonEmpty(overview?.Image?.URL) ?? nonEmpty(raw.pdp?.ImageURL);

    return {
      skuId,
      ean,
      name,
      brand: nonEmpty(plp?.Brand) ?? nonEmpty(overview?.Brand),
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: unitPriceCents,
      stdUnit: unitPriceCents !== null ? stdUnit : null,
      promo,
      categoryPath,
      imageUrl,
      productUrl: slug ? `https://www.plus.nl/product/${slug}` : null,
      available: (plp?.IsAvailable ?? overview?.IsAvailableInStore) !== false,
    };
  },
};
