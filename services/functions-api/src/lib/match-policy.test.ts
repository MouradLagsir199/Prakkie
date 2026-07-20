import { describe, expect, it } from 'vitest';
import type { MatchCandidate } from './match';
import { assessCandidate, type MatchAnchor } from './match-policy';

const candidate = (overrides: Partial<MatchCandidate> = {}): MatchCandidate => ({
  chain_id: 'jumbo', sku_id: 'candidate', name: 'Jumbo Halfvolle melk 1L', brand: 'Jumbo',
  price_cents: 109, promo_price_cents: null, promo: null, unit_price_cents_per_std: 109,
  std_unit: 'l', pack_size_value: 1, pack_size_unit: 'l', image_url: null, product_url: null,
  aisle_group_id: 3, confidence: 0.86, source: 'trgm', is_primary: true,
  head_term: 'halfvolle melk', intent_form: 'houdbaar', is_base: true,
  canonical_key: 'halfvolle-melk', canonical_name: 'halfvolle melk', is_organic: false,
  ...overrides,
});

const anchor: MatchAnchor = {
  chain_id: 'ah', sku_id: 'anchor', ean: '8712345678901', brand: 'AH',
  pack_size_value: 1, pack_size_unit: 'l', canonical_name: 'halfvolle melk',
  canonical_key: 'halfvolle-melk', head_term: 'halfvolle melk', intent_form: 'houdbaar',
  intent_aisle: 3, is_organic: false,
};

describe('assessCandidate (EAN-only cross-chain)', () => {
  it('accepts an exact EAN independently of fuzzy confidence', () => {
    const result = assessCandidate(candidate({ ean: anchor.ean, confidence: 0.1 }), anchor, 'precise');
    expect(result).toMatchObject({ decision: 'accepted', reliability: 0.999, hard_compatible: true });
  });

  it('accepts a leading-zero GTIN-14 as the same trade item', () => {
    const result = assessCandidate(candidate({ ean: `0${anchor.ean}` }), anchor, 'practical');
    expect(result.decision).toBe('accepted');
  });

  it('never auto-accepts a name-identical product with a different EAN', () => {
    const result = assessCandidate(candidate({ ean: '8798765432106', confidence: 0.99 }), anchor, 'value');
    expect(result).toMatchObject({ decision: 'review', hard_compatible: false });
    expect(result.reasons).toContain('ander merkartikel (andere EAN)');
  });

  it('never auto-accepts against an anchor when the candidate has no EAN, however strong the text match', () => {
    const result = assessCandidate(candidate({ confidence: 0.99 }), anchor, 'value');
    expect(result).toMatchObject({ decision: 'review', hard_compatible: false });
    expect(result.reliability).toBeLessThanOrEqual(0.49);
  });

  it('never auto-accepts when the anchor itself has no EAN', () => {
    const result = assessCandidate(candidate({ ean: '8712345678901', confidence: 0.99 }), { ...anchor, ean: null }, 'practical');
    expect(result.decision).toBe('review');
    expect(result.reasons).toContain('gekozen product heeft geen EAN');
  });

  it('still accepts a strong anchorless term suggestion (ingredient matching)', () => {
    const result = assessCandidate(candidate(), null, 'practical');
    expect(result.decision).toBe('accepted');
    expect(result.reliability).toBeGreaterThanOrEqual(0.78);
  });

  it('keeps weak anchorless suggestions in review under precise policy', () => {
    const result = assessCandidate(candidate({ confidence: 0.8 }), null, 'precise');
    expect(result.decision).toBe('review');
  });

  it('keeps composite products in review even without an anchor', () => {
    const result = assessCandidate(candidate({ is_primary: false, confidence: 0.99 }), null, 'value');
    expect(result.decision).toBe('review');
    expect(result.reasons).toContain('samengesteld product');
  });

  it('always trusts an explicit user correction', () => {
    const result = assessCandidate(candidate({ source: 'correction', confidence: 0.2 }), anchor, 'precise');
    expect(result.decision).toBe('accepted');
  });
});
