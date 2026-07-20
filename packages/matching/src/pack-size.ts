/**
 * Pack-size reconciliation (spec §E3): a recipe needs 600 g; the product is sold
 * per 300 g → buy 2, leftover 0 → "pakt precies" (mockup 06). Fractional-cost
 * insight is derived from the same numbers.
 */

export interface PackFitInput {
  /** Amount the recipe/list needs, in a base unit (g | ml | st). */
  neededValue: number;
  /** Pack size of the product, in the same base unit. */
  packValue: number;
  /** Price of one pack, in cents (promo price when active). */
  packPriceCents: number;
}

export interface PackFitResult {
  packsToBuy: number;
  totalPriceCents: number;
  /** Leftover after covering the need; 0 ⇒ "pakt precies". */
  leftoverValue: number;
  /** Cost attributable to the recipe itself (fractional; for price-per-portion honesty). */
  fractionalCostCents: number;
  fitsExactly: boolean;
}

export interface ParsedPackSize {
  /** Total contents of one purchasable package, in a base unit. */
  value: number;
  unit: 'g' | 'ml' | 'st';
}

/**
 * Read a pack size from a product title. Multipacks are returned as
 * their total purchasable contents: `2 x 180 g` is one 360 g package, not a
 * 180 g package and not two packages in the basket.
 */
export function parsePackSizeText(text: string | null | undefined): ParsedPackSize | null {
  if (!text) return null;
  const matches = [...text.matchAll(
    /\b(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kilo(?:gram)?|g|gr|gram|ml|cl|dl|l|liter|litre|stuks?|st)\b/gi
  )];
  const match = matches.at(-1);
  if (!match) return null;

  const multiplier = match[1] ? Number(match[1]) : 1;
  const amount = Number(match[2]!.replace(',', '.'));
  const rawUnit = match[3]!.toLowerCase();
  const units: Record<string, ParsedPackSize> = {
    kg: { value: 1000, unit: 'g' },
    kilo: { value: 1000, unit: 'g' },
    kilogram: { value: 1000, unit: 'g' },
    g: { value: 1, unit: 'g' },
    gr: { value: 1, unit: 'g' },
    gram: { value: 1, unit: 'g' },
    ml: { value: 1, unit: 'ml' },
    cl: { value: 10, unit: 'ml' },
    dl: { value: 100, unit: 'ml' },
    l: { value: 1000, unit: 'ml' },
    liter: { value: 1000, unit: 'ml' },
    litre: { value: 1000, unit: 'ml' },
    st: { value: 1, unit: 'st' },
    stuk: { value: 1, unit: 'st' },
    stuks: { value: 1, unit: 'st' },
  };
  const unit = units[rawUnit];
  if (!unit || multiplier <= 0 || amount <= 0) return null;
  return { value: multiplier * amount * unit.value, unit: unit.unit };
}

export function reconcilePackSize(input: PackFitInput): PackFitResult {
  const { neededValue, packValue, packPriceCents } = input;
  if (neededValue <= 0 || packValue <= 0 || packPriceCents < 0) {
    throw new RangeError('reconcilePackSize: values must be positive (price may be 0)');
  }
  const packsToBuy = Math.max(1, Math.ceil(neededValue / packValue - 1e-9));
  const totalPriceCents = packsToBuy * packPriceCents;
  const leftoverRaw = packsToBuy * packValue - neededValue;
  // Guard float noise: treat < one-millionth of a pack as an exact fit.
  const leftoverValue = leftoverRaw < packValue * 1e-6 ? 0 : leftoverRaw;
  const fractionalCostCents = Math.round((neededValue / packValue) * packPriceCents);
  return {
    packsToBuy,
    totalPriceCents,
    leftoverValue,
    fractionalCostCents,
    fitsExactly: leftoverValue === 0,
  };
}

/** Promo mechanics applied to a multi-pack purchase (spec §F3 mechanics). */
export function applyPromo(
  packsToBuy: number,
  packPriceCents: number,
  mechanic: { kind: 'percent_off'; percent: number } | { kind: 'x_plus_y_free'; buy: number; free: number } | { kind: 'fixed_price'; priceCents: number },
): number {
  switch (mechanic.kind) {
    case 'percent_off':
      return Math.round(packsToBuy * packPriceCents * (1 - mechanic.percent / 100));
    case 'x_plus_y_free': {
      const groupSize = mechanic.buy + mechanic.free;
      const fullGroups = Math.floor(packsToBuy / groupSize);
      const remainder = packsToBuy % groupSize;
      const paidPacks = fullGroups * mechanic.buy + Math.min(remainder, mechanic.buy);
      return paidPacks * packPriceCents;
    }
    case 'fixed_price':
      return packsToBuy * mechanic.priceCents;
  }
}
