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
