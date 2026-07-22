import { describe, it, expect } from 'vitest';
import { classifyLine, buildChainTotals, optimizeBasket, assembleBasketPlan, type PlanItemInput } from './basket-plan';

const cand = (chain: string, price: number, exact = false) => ({
  chain_id: chain, sku_id: `${chain}-sku`, name: `${chain} product`, price_cents: price, is_exact: exact, confidence: 0.9, reasons: [],
});

// 3 items, 2 ketens (ah, jumbo)
const CHAINS = ['ah', 'jumbo'] as const;
const items: PlanItemInput[] = [
  { item_id: 'i1', name: 'cola zero', canonical_id: 'cn1', candidates: { ah: cand('ah', 100, true), jumbo: cand('jumbo', 90) }, categoryHasAlt: { ah: true, jumbo: true } },
  { item_id: 'i2', name: 'sperziebonen blik', canonical_id: 'cn2', candidates: { ah: cand('ah', 200) }, categoryHasAlt: { ah: true, jumbo: true } },
  { item_id: 'i3', name: 'halfvolle melk', canonical_id: 'cn3', candidates: { ah: cand('ah', 50), jumbo: cand('jumbo', 60) }, categoryHasAlt: { ah: true, jumbo: true } },
];

describe('classifyLine', () => {
  it('exact wanneer de kandidaat dezelfde EAN heeft', () => {
    expect(classifyLine(items[0]!, 'ah').decision).toBe('exact');
  });
  it('equivalent voor een canonieke sibling zonder EAN-gelijkheid', () => {
    expect(classifyLine(items[0]!, 'jumbo').decision).toBe('equivalent');
  });
  it('compromise wanneer geen sibling maar wél iets in de categorie', () => {
    expect(classifyLine(items[1]!, 'jumbo').decision).toBe('compromise');
  });
  it('no_match wanneer niets in de categorie', () => {
    const item: PlanItemInput = { ...items[1]!, categoryHasAlt: { ah: true, jumbo: false } };
    expect(classifyLine(item, 'jumbo').decision).toBe('no_match');
  });
});

describe('buildChainTotals — direct totaal = EXACT + EQUIVALENT', () => {
  it('AH dekt alles, Jumbo mist item2', () => {
    const lines = assembleBasketPlan('L', CHAINS, items, 'graph-v1').lines;
    const totals = buildChainTotals(lines, CHAINS);
    const ah = totals.find((t) => t.chain_id === 'ah')!;
    const jumbo = totals.find((t) => t.chain_id === 'jumbo')!;
    expect(ah).toMatchObject({ total_cents: 350, matched: 3, missing: 0, complete: true });
    expect(jumbo).toMatchObject({ total_cents: 150, matched: 2, missing: 1, complete: false });
  });
});

describe('optimizeBasket', () => {
  const plan = assembleBasketPlan('L', CHAINS, items, 'graph-v1');
  it('goedkoopste enkele complete winkel = AH (350)', () => {
    expect(plan.optimizer.cheapest_single).toMatchObject({ chain_id: 'ah', total_cents: 350, missing: 0 });
  });
  it('split kiest per item de goedkoopste keten (i1 jumbo 90, i2 ah 200, i3 ah 50 = 340)', () => {
    expect(plan.optimizer.split).toMatchObject({ total_cents: 340, missing: 0 });
    expect(plan.optimizer.split!.assignments).toMatchObject({ i1: 'jumbo', i2: 'ah', i3: 'ah' });
  });
  it('besparing van split t.o.v. goedkoopste complete winkel = 10', () => {
    expect(plan.optimizer.savings_vs_single_cents).toBe(10);
  });
});
