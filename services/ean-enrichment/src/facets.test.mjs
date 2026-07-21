import { describe, it, expect } from 'vitest';
import { classify, verifyFacets, categoryPolicy } from './facets.mjs';

// Facetstruct-helper.
const f = (over) => ({
  category: 'frisdrank', brand_tier: 'private_label',
  variant: 'regular', flavor: 'regular', form: 'houdbaar', dietary: [], type: null,
  pack: { value: 1.5, unit: 'l' }, ean: null, ...over,
});

describe('classify — vier-uitgangen-funnel', () => {
  it('EXACT bij gelijke EAN (leidende nullen genegeerd)', () => {
    const r = classify(f({ ean: '08710398' }), f({ ean: '8710398', variant: 'zero' }));
    expect(r.decision).toBe('EXACT');
  });

  it('EQUIVALENT: huismerk cola zero → huismerk cola zero andere keten', () => {
    const ah = f({ variant: 'zero', brand_tier: 'private_label' });
    const plus = f({ variant: 'zero', brand_tier: 'private_label', pack: { value: 1, unit: 'l' } });
    const r = classify(ah, plus);
    expect(r.decision).toBe('EQUIVALENT');
    expect(r.reasons[0]).toContain('zero');
  });

  it('COMPROMISE: cola zero → gewone cola (harde variant gebroken)', () => {
    const r = classify(f({ variant: 'zero' }), f({ variant: 'regular' }));
    expect(r.decision).toBe('COMPROMISE');
    expect(r.broken).toContain('variant');
    expect(r.reasons[0]).toMatch(/variant/);
  });

  it('COMPROMISE: sperziebonen blik → zak (harde vorm gebroken)', () => {
    const blik = f({ category: 'groente', form: 'blik', type: 'sperziebonen' });
    const zak = f({ category: 'groente', form: 'vers', type: 'sperziebonen' });
    const r = classify(blik, zak);
    expect(r.decision).toBe('COMPROMISE');
    expect(r.broken).toContain('form');
  });

  it('NO_MATCH bij andere categorie', () => {
    const r = classify(f({ category: 'frisdrank' }), f({ category: 'sap' }));
    expect(r.decision).toBe('NO_MATCH');
  });

  it('zuivel: lactosevrij → gewone melk is COMPROMISE (dieet-eis niet vervuld)', () => {
    const src = f({ category: 'zuivel-melk', type: 'halfvol', dietary: ['lactosevrij'] });
    const cand = f({ category: 'zuivel-melk', type: 'halfvol', dietary: [] });
    expect(classify(src, cand).decision).toBe('COMPROMISE');
  });

  it('zuivel: gewone melk → lactosevrij is EQUIVALENT (dieet is bonus, geen eis)', () => {
    const src = f({ category: 'zuivel-melk', type: 'halfvol', dietary: [] });
    const cand = f({ category: 'zuivel-melk', type: 'halfvol', dietary: ['lactosevrij'] });
    expect(classify(src, cand).decision).toBe('EQUIVALENT');
  });
});

describe('verifyFacets — anti-"wit brood"-poort', () => {
  it('REGRESSIE: bakmix gelabeld als vers brood → verified=false (uitgesloten)', () => {
    // De historische ramp: "Koopmans Witbrood MIX" stond in product_intent als
    // form='vers'; de LLM ziet de bakmix en zegt form='houdbaar'. Twee signalen
    // oneens → niet vertrouwen → mag nooit auto-matchen.
    const llm = {
      category: 'bakproducten', form: 'houdbaar', variant: 'regular',
      flavor: 'regular', dietary: [], type: 'broodmix', pack: { value: 450, unit: 'g' },
    };
    const structured = {
      name: 'Koopmans Witbrood Mix', intent_form: 'vers',
      category_path: ['Bakken', 'Bakmixen'], pack_size_value: 450, pack_size_unit: 'g',
    };
    const v = verifyFacets(llm, structured);
    expect(v.verified).toBe(false);
    expect(v.disagreements.some((d) => d.startsWith('form:'))).toBe(true);
  });

  it('en zelfs als het toch geclassificeerd wordt: bakmix ≠ vers brood → geen EQUIVALENT', () => {
    const mix = { category: 'bakproducten', variant: 'regular', flavor: 'regular', form: 'houdbaar', dietary: [], type: 'broodmix', ean: null };
    const brood = { category: 'brood', variant: 'regular', flavor: 'regular', form: 'vers', dietary: [], type: 'wit', ean: null };
    expect(classify(brood, mix).decision).toBe('NO_MATCH');
  });

  it('schone extractie die overeenkomt → verified=true', () => {
    const llm = { category: 'frisdrank', form: 'houdbaar', variant: 'zero', flavor: 'regular', dietary: [], type: null, pack: { value: 1.5, unit: 'l' } };
    const structured = { name: 'Cola Zero 1,5L', intent_form: 'houdbaar', category_path: ['Frisdrank', 'Cola'], pack_size_value: 1.5, pack_size_unit: 'l', is_organic: false };
    const v = verifyFacets(llm, structured);
    expect(v.verified).toBe(true);
    expect(v.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe('categoryPolicy', () => {
  it('kent beleid voor bekende categorie', () => {
    expect(categoryPolicy('frisdrank').hard).toContain('variant');
  });
  it('valt terug op conservatief beleid (categorie+vorm hard) voor onbekende', () => {
    const p = categoryPolicy('iets-onbekends');
    expect(p.hard).toEqual(['category', 'form']);
  });
});
