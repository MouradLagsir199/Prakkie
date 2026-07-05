import {
  euroToCents,
  parsePackSize,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

/**
 * AH silver parser — bronze rows from scrapers/ah.py ("Appie" mobile API).
 * raw = { card: <search card>, detail: <detail/v4 payload | null> }.
 * The card carries price/bonus/images/nutriscore; detail (when hydrated)
 * carries the trade item (gtin/EAN) — the anchor chain for Bonus mechanics.
 */

interface AhCard {
  webshopId: number;
  title: string;
  salesUnitSize?: string | null;
  unitPriceDescription?: string | null;
  images?: { width: number; url: string }[];
  bonusStartDate?: string | null;
  bonusEndDate?: string | null;
  bonusMechanism?: string | null;
  promotionType?: string | null;
  currentPrice?: number | null;
  priceBeforeBonus?: number | null;
  mainCategory?: string | null;
  subCategory?: string | null;
  brand?: string | null;
  isBonus?: boolean;
  isStapelBonus?: boolean;
  orderAvailabilityStatus?: string | null;
  isOrderable?: boolean;
}

interface AhDetail {
  productCard?: unknown;
  tradeItem?: { gtin?: string; gtins?: string[] };
  [key: string]: unknown;
}

/** "prijs per kg €1.53" → { cents: 153, unit: 'kg' } */
function parseUnitPrice(desc: string | null | undefined): { cents: number | null; unit: string | null } {
  if (!desc) return { cents: null, unit: null };
  const m = desc.toLowerCase().match(/per\s+(kg|liter|l|stuk|100\s*g|100\s*ml)\s*[€]?\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return { cents: null, unit: null };
  let cents = euroToCents(m[2]!);
  let unit = m[1]!.replace(/\s/g, '');
  if (cents === null) return { cents: null, unit: null };
  if (unit === '100g') {
    cents *= 10;
    unit = 'kg';
  } else if (unit === '100ml') {
    cents *= 10;
    unit = 'l';
  } else if (unit === 'liter') {
    unit = 'l';
  } else if (unit === 'stuk') {
    unit = 'stuks';
  }
  return { cents, unit };
}

export const ahConnector: ChainConnector = {
  chainId: 'ah',
  capabilities: { promos: true, eans: true, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const card = (envelope.raw as { card?: AhCard }).card;
    if (!card?.webshopId || !card.title) return null;

    const priceCents = euroToCents(card.priceBeforeBonus ?? card.currentPrice);
    if (priceCents === null) return null; // unpriced rows are useless for comparison

    const bonusPriceCents = card.isBonus ? euroToCents(card.currentPrice) : null;
    const pack = parsePackSize(card.salesUnitSize);
    const unitPrice = parseUnitPrice(card.unitPriceDescription);
    const detail = (envelope.raw as { detail?: AhDetail | null }).detail;
    const gtin = detail?.tradeItem?.gtin ?? detail?.tradeItem?.gtins?.[0] ?? null;

    // largest square image the card offers
    const image = (card.images ?? []).reduce<{ width: number; url: string } | null>(
      (best, img) => (img.url && (!best || img.width > best.width) ? img : best),
      null
    );

    return {
      skuId: String(card.webshopId),
      ean: gtin,
      name: card.title,
      brand: card.brand ?? null,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: unitPrice.cents,
      stdUnit: unitPrice.unit,
      promo: card.isBonus
        ? {
            type: card.isStapelBonus ? 'stapelbonus' : 'bonus',
            price_cents: bonusPriceCents ?? undefined,
            mechanic: card.bonusMechanism ?? card.promotionType ?? undefined,
            valid_from: card.bonusStartDate ?? undefined,
            valid_to: card.bonusEndDate ?? undefined,
          }
        : null,
      categoryPath: [card.mainCategory, card.subCategory].filter((c): c is string => !!c),
      imageUrl: image?.url ?? null,
      productUrl: `https://www.ah.nl/producten/product/wi${card.webshopId}`,
      available: card.orderAvailabilityStatus !== 'OUT_OF_ASSORTMENT' && card.isOrderable !== false,
    };
  },
};
