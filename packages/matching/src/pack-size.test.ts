import { describe, expect, it } from 'vitest';
import { applyPromo, parsePackSizeText, reconcilePackSize } from './pack-size';
import { normaliseUnit } from './units';

describe('reconcilePackSize', () => {
  it('mockup 06: kipdijfilet 600 g in 2 × 300 g — restje van 0 g, pakt precies', () => {
    const r = reconcilePackSize({ neededValue: 600, packValue: 300, packPriceCents: 349 });
    expect(r.packsToBuy).toBe(2);
    expect(r.leftoverValue).toBe(0);
    expect(r.fitsExactly).toBe(true);
    expect(r.totalPriceCents).toBe(698);
  });

  it('computes leftover when packs overshoot (200 g needed, 400 g tin)', () => {
    const r = reconcilePackSize({ neededValue: 200, packValue: 400, packPriceCents: 189 });
    expect(r.packsToBuy).toBe(1);
    expect(r.leftoverValue).toBe(200);
    expect(r.fitsExactly).toBe(false);
    expect(r.fractionalCostCents).toBe(95); // half the tin drives the recipe cost
  });

  it('never buys zero packs and never returns negative leftover', () => {
    for (const needed of [1, 149, 150, 151, 299, 450]) {
      const r = reconcilePackSize({ neededValue: needed, packValue: 150, packPriceCents: 100 });
      expect(r.packsToBuy).toBeGreaterThanOrEqual(1);
      expect(r.packsToBuy * 150).toBeGreaterThanOrEqual(needed);
      expect(r.leftoverValue).toBeGreaterThanOrEqual(0);
      expect(r.totalPriceCents).toBe(r.packsToBuy * 100);
    }
  });

  it('treats float noise as an exact fit (3 × 0.2 ≈ 0.6)', () => {
    const r = reconcilePackSize({ neededValue: 0.2 * 3, packValue: 0.6, packPriceCents: 100 });
    expect(r.fitsExactly).toBe(true);
  });
});

describe('parsePackSizeText', () => {
  it('treats 2 x 180 g as one 360 g purchasable multipack', () => {
    expect(parsePackSizeText('Mekkafood Lahmacun Turkse Pizza 2x180g')).toEqual({ value: 360, unit: 'g' });
    expect(parsePackSizeText('Consenza Kiploempia 2 × 180 gr')).toEqual({ value: 360, unit: 'g' });
  });

  it('normalises ordinary metric sizes and decimal litres', () => {
    expect(parsePackSizeText('Iglo Spinazie fijn gehakt 750 gram')).toEqual({ value: 750, unit: 'g' });
    expect(parsePackSizeText('Frisdrank 6 x 1,5 l')).toEqual({ value: 9000, unit: 'ml' });
  });

  it('reads a piece count from the title instead of deriving a fractional count from price', () => {
    expect(parsePackSizeText('Jumbo Fuji Appels 4 Stuks')).toEqual({ value: 4, unit: 'st' });
  });

  it('returns null when a title has no measurable pack size', () => {
    expect(parsePackSizeText('Beemster Oud 48+ plakken')).toBeNull();
  });
});

describe('applyPromo', () => {
  it('mockup 06: Bonus 25% — € 2,49 → € 1,87', () => {
    expect(applyPromo(1, 249, { kind: 'percent_off', percent: 25 })).toBe(187);
  });

  it('1 + 1 gratis pays half on even packs, favourably on odd', () => {
    expect(applyPromo(2, 200, { kind: 'x_plus_y_free', buy: 1, free: 1 })).toBe(200);
    expect(applyPromo(3, 200, { kind: 'x_plus_y_free', buy: 1, free: 1 })).toBe(400);
    expect(applyPromo(4, 200, { kind: 'x_plus_y_free', buy: 1, free: 1 })).toBe(400);
  });

  it('fixed promo price replaces the pack price', () => {
    expect(applyPromo(2, 249, { kind: 'fixed_price', priceCents: 187 })).toBe(374);
  });
});

describe('normaliseUnit', () => {
  it('converts Dutch kitchen abbreviations (spec §E1)', () => {
    expect(normaliseUnit('el', 2)).toEqual({ value: 30, unit: 'ml', approximate: true });
    expect(normaliseUnit('tl', 1)).toEqual({ value: 5, unit: 'ml', approximate: true });
    expect(normaliseUnit('kg', 1.5)).toEqual({ value: 1500, unit: 'g', approximate: false });
    expect(normaliseUnit('teentjes', 2)).toEqual({ value: 2, unit: 'st', approximate: false });
  });

  it('returns null for unknown units instead of guessing', () => {
    expect(normaliseUnit('handjevol', 1)).toBeNull();
  });
});
