import { describe, expect, it } from 'vitest';
import { normaliseIngredient } from './normalise';

const cases: [string, Partial<ReturnType<typeof normaliseIngredient>>][] = [
  ['400 g gezeefde tomaten (passata)', { quantity: 400, unit: 'g', item: 'gezeefde tomaten', note: 'passata' }],
  ['2 el olijfolie', { quantity: 2, unit: 'el', item: 'olijfolie' }],
  ['1 tl komijn', { quantity: 1, unit: 'tl', item: 'komijn' }],
  ['snufje zout', { quantity: 1, unit: 'snufje', item: 'zout' }],
  ['2 teentjes knoflook', { quantity: 2, unit: 'teentje', item: 'knoflook' }],
  ['peper naar smaak', { quantity: null, unit: null, item: 'peper', toTaste: true }],
  ['2-3 el sojasaus', { quantity: 2.5, quantityMax: 3, unit: 'el', item: 'sojasaus' }],
  ['2 à 3 uien', { quantity: 2.5, quantityMax: 3, item: 'uien' }],
  ['½ courgette', { quantity: 0.5, unit: null, item: 'courgette' }],
  ['1½ kg aardappelen', { quantity: 1.5, unit: 'kg', item: 'aardappelen' }],
  ['1 1/2 kopje rijst', { quantity: 1.5, unit: 'kopje', item: 'rijst' }],
  ['1/2 citroen', { quantity: 0.5, item: 'citroen' }],
  ['ui, fijngesnipperd', { quantity: null, item: 'ui', note: 'fijngesnipperd' }],
  ['2 eieren', { quantity: 2, unit: null, item: 'eieren' }],
  ['1 blik tomatenblokjes', { quantity: 1, unit: 'blik', item: 'tomatenblokjes' }],
  ['scheutje melk', { quantity: 1, unit: 'scheutje', item: 'melk' }],
  ['half bosje peterselie', { quantity: 0.5, unit: 'bosje', item: 'peterselie' }],
  ['250 gr crème fraîche', { quantity: 250, unit: 'g', item: 'creme fraiche' }],
  ['1,5 dl kookroom', { quantity: 1.5, unit: 'dl', item: 'kookroom' }],
  ['verse basilicum (optioneel)', { item: 'verse basilicum', toTaste: false, note: 'optioneel' }],
  ['2 tbsp olive oil', { quantity: 2, unit: 'el', item: 'olive oil' }],
  ['200 g spekreepjes, uitgebakken', { quantity: 200, unit: 'g', item: 'spekreepjes', note: 'uitgebakken' }],
];

describe('E1 normaliser', () => {
  for (const [raw, expected] of cases) {
    it(raw, () => {
      const got = normaliseIngredient(raw);
      for (const [k, v] of Object.entries(expected)) {
        if (typeof v === 'number') expect(got[k as keyof typeof got], k).toBeCloseTo(v as number, 5);
        else expect(got[k as keyof typeof got], k).toEqual(v);
      }
    });
  }

  it('keeps the raw line verbatim', () => {
    expect(normaliseIngredient('  2 el  Olijfolie ').raw).toBe('2 el  Olijfolie');
  });
});
