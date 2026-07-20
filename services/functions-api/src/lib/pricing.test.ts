import { describe, expect, it, vi } from 'vitest';
import type { MatchCandidate } from './match';
import type { MatchAnchor } from './match-policy';
import {
  buildShoppingSessionPayload,
  createPricingRetrievalCache,
  genericProductTerms,
  priceList,
  priceShoppingSession,
  rankPreviewAlternatives,
} from './pricing';

describe('genericProductTerms', () => {
  it('retrieves flatbread families for Libanees brood across chain naming differences', () => {
    expect(genericProductTerms('libanees brood')).toEqual(
      expect.arrayContaining(['brood', 'flatbread', 'pitabrood'])
    );
  });

  it('keeps prepared BBQ/skewer cues when a retailer uses a different shelf', () => {
    expect(genericProductTerms('Vomar BBQ kipfilet spies')).toEqual(
      expect.arrayContaining(['bbq', 'spies', 'spiesjes'])
    );
  });
});

const anchor: MatchAnchor = {
  chain_id: 'jumbo',
  sku_id: '300141STK',
  name: 'Jumbo - Rond Wit - Half',
  ean: '8718452636457',
  brand: null,
  pack_size_value: null,
  pack_size_unit: null,
  canonical_name: 'rond wit brood',
  canonical_key: 'wit_brood_rond',
  head_term: 'wit brood',
  intent_form: 'vers',
  intent_aisle: 6,
  is_organic: false,
};

const candidate = (overrides: Partial<MatchCandidate> & Pick<MatchCandidate, 'sku_id' | 'name'>): MatchCandidate => ({
  chain_id: 'plus',
  ean: null,
  brand: null,
  price_cents: 99,
  promo_price_cents: null,
  promo: null,
  unit_price_cents_per_std: null,
  std_unit: null,
  pack_size_value: null,
  pack_size_unit: null,
  image_url: null,
  product_url: null,
  aisle_group_id: 6,
  confidence: 0.9,
  source: 'semantic',
  is_primary: true,
  head_term: 'wit brood',
  intent_form: 'vers',
  is_base: true,
  canonical_name: 'wit brood',
  canonical_key: null,
  is_organic: false,
  ...overrides,
});

describe('rankPreviewAlternatives', () => {
  it('keeps the full candidate pool available for Zie meer', () => {
    const pool = Array.from({ length: 30 }, (_, index) => candidate({
      sku_id: `candidate-${index}`,
      name: `PLUS Wit brood variant ${index}`,
      confidence: 0.9 - index / 1000,
    }));

    const ranked = rankPreviewAlternatives(pool, {
      anchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    expect(ranked).toHaveLength(30);
    expect(new Set(ranked.map((option) => option.sku_id)).size).toBe(30);
  });

  it('only suggests products from the same known category as the anchor', () => {
    const appleAnchor: MatchAnchor = {
      ...anchor,
      name: 'Jumbo Fuji Appels 4 Stuks',
      ean: '8718452396542',
      head_term: 'fuji appels',
      intent_form: 'vers',
      intent_aisle: 1,
      is_base: true,
    };
    const freshApples = candidate({
      sku_id: 'fresh-apples',
      name: 'Jonagold appel',
      aisle_group_id: null,
      intent_aisle: 1,
      is_base: true,
      head_term: 'appel',
      std_unit: 'kg',
      unit_price_cents_per_std: 179,
      price_cents: 269,
      confidence: 0.7,
    });
    const appleJuice = candidate({
      sku_id: 'apple-juice',
      name: 'Bio+ Bio appelsap',
      aisle_group_id: null,
      intent_aisle: 15,
      is_base: true,
      head_term: 'appelsap',
      std_unit: 'l',
      unit_price_cents_per_std: 279,
      price_cents: 279,
      confidence: 0.99,
    });
    const fruitSnack = candidate({
      sku_id: 'fruit-snack',
      name: 'Knijpfruit appel',
      aisle_group_id: null,
      intent_aisle: 1,
      is_base: false,
      head_term: 'knijpfruit',
      confidence: 0.98,
    });

    const ranked = rankPreviewAlternatives([appleJuice, fruitSnack, freshApples], {
      anchor: appleAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    expect(ranked.map((option) => option.sku_id)).toEqual(['fresh-apples']);
  });

  it('ranks the exact-EAN twin first in value mode; name-only lookalikes stay review', () => {
    const proposed = candidate({ sku_id: '575373', name: 'PLUS Rond wit half', price_cents: 99, confidence: 0.903 });
    const eanTwin = candidate({
      sku_id: '467299',
      name: 'PLUS Boeren wit tijger Half',
      price_cents: 68,
      confidence: 0.812,
      ean: anchor.ean,
    });
    const lookalike = candidate({
      sku_id: '931177',
      name: 'Koopmans Broodmix wit brood',
      price_cents: 30,
      confidence: 0.9,
      head_term: 'broodmix',
      is_primary: false,
      is_base: false,
    });

    const ranked = rankPreviewAlternatives([proposed, lookalike, eanTwin], {
      anchor,
      policy: 'value',
      selectedSku: proposed.sku_id,
    });

    expect(ranked.map((option) => option.sku_id)[0]).toBe('467299');
    expect(ranked[0]).toMatchObject({ hard_compatible: true, decision: 'accepted', line_price_cents: 68 });
    expect(ranked.slice(1)).toSatisfy((rest: { decision: string; hard_compatible: boolean }[]) =>
      rest.every((option) => option.decision === 'review' && !option.hard_compatible)
    );
  });

  it('keeps the current precise suggestion visible first and collapses duplicate catalog rows', () => {
    const proposed = candidate({ sku_id: '575373', name: 'PLUS Rond wit half', confidence: 0.903 });
    const duplicate = candidate({ sku_id: 'duplicate', name: 'PLUS Rond wit half', confidence: 0.99 });
    const other = candidate({ sku_id: '467299', name: 'PLUS Boeren wit tijger Half', price_cents: 68, confidence: 0.812 });
    const input = [other, duplicate, proposed];

    const ranked = rankPreviewAlternatives(input, {
      anchor,
      policy: 'precise',
      selectedSku: proposed.sku_id,
    });

    expect(ranked.map((option) => option.sku_id)).toEqual(['575373', '467299']);
    expect(ranked[0]?.suggested).toBe(true);
    expect(input.map((option) => option.sku_id)).toEqual(['467299', 'duplicate', '575373']);
  });

  // owner 2026-07-14: "AH Oude kaas L" was Meest vergelijkbaar voor "Beemster
  // oud 2 plaks" — vorm (plakken vs stuk) en pakmaat moeten de ranking sturen.
  it('demotes a different form (whole piece) below sliced candidates for a sliced anchor', () => {
    const slicedAnchor: MatchAnchor = {
      ...anchor,
      name: 'Beemster Oud 48+ plakken',
      ean: null,
      pack_size_value: 150,
      pack_size_unit: 'g',
    };
    const wholePiece = candidate({
      sku_id: 'piece', name: 'AH Oude kaas L stuk', confidence: 0.95,
      pack_size_value: 500, pack_size_unit: 'g',
    });
    const sliced = candidate({
      sku_id: 'sliced', name: 'AH Oude kaas 48+ plakken', confidence: 0.8,
      pack_size_value: 190, pack_size_unit: 'g',
    });
    const grated = candidate({
      sku_id: 'grated', name: 'AH Oude kaas geraspt', confidence: 0.9,
      pack_size_value: 150, pack_size_unit: 'g',
    });

    const ranked = rankPreviewAlternatives([wholePiece, grated, sliced], {
      anchor: slicedAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    // plakken passen exact; geraspt (vorm-conflict) en heel stuk (vorm-conflict
    // + 3,3× de maat) zakken onder de plakken ondanks hogere tekst-confidence
    expect(ranked.map((option) => option.sku_id)).toEqual(['sliced', 'grated', 'piece']);
  });

  it('prefers a matching pack size over a much larger pack at equal confidence', () => {
    const packAnchor: MatchAnchor = { ...anchor, ean: null, pack_size_value: 800, pack_size_unit: 'g' };
    const bigTub = candidate({
      sku_id: 'big', name: 'PLUS Kwark bak', confidence: 0.9,
      pack_size_value: 200, pack_size_unit: 'g',
    });
    const rightSize = candidate({
      sku_id: 'right', name: 'PLUS Kwark emmer', confidence: 0.9,
      pack_size_value: 750, pack_size_unit: 'g',
    });

    const ranked = rankPreviewAlternatives([bigTub, rightSize], {
      anchor: packAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    expect(ranked.map((option) => option.sku_id)).toEqual(['right', 'big']);
  });

  it('ranks an exact 800 g chicken pack above a selected, stronger-named 600 g pack', () => {
    const chickenAnchor: MatchAnchor = {
      ...anchor,
      name: 'AH Scharrel kipfilet',
      head_term: 'kipfilet',
      ean: null,
      pack_size_value: null,
      pack_size_unit: null,
      price_cents: 975,
      unit_price_cents_per_std: 1219,
      std_unit: 'kg',
    };
    const selectedSixHundred = candidate({
      sku_id: '515106KGR',
      name: 'Jumbo Kipfilet ca. 600g',
      confidence: 0.96,
      price_cents: 828,
      unit_price_cents_per_std: 1380,
      std_unit: 'kg',
    });
    const exactEightHundred = candidate({
      sku_id: '753633KGR',
      name: 'Jumbo Kipfilet 800 g',
      confidence: 0.9,
      price_cents: 975,
      unit_price_cents_per_std: 1219,
      std_unit: 'kg',
    });

    const ranked = rankPreviewAlternatives([selectedSixHundred, exactEightHundred], {
      anchor: chickenAnchor,
      policy: 'precise',
      selectedSku: selectedSixHundred.sku_id,
      quantity: '1',
      unit: null,
    });

    expect(ranked.map((option) => option.sku_id)).toEqual(['753633KGR', '515106KGR']);
  });

  it('ranks a BBQ/skewer variant above generic chicken fillet', () => {
    const bbqAnchor: MatchAnchor = {
      ...anchor,
      name: 'Vomar BBQ kipfilet spies',
      head_term: 'kipfilet',
      ean: null,
      intent_aisle: 9,
      is_base: false,
    };
    const genericChicken = candidate({
      sku_id: 'generic-chicken',
      name: 'AH Scharrel kipfilet',
      intent_aisle: 9,
      is_base: true,
      confidence: 0.96,
    });
    const bbqSkewers = candidate({
      sku_id: 'bbq-skewers',
      name: 'AH BBQ kipfilet spiesjes',
      intent_aisle: 9,
      is_base: false,
      confidence: 0.82,
    });

    const ranked = rankPreviewAlternatives([genericChicken, bbqSkewers], {
      anchor: bbqAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    expect(ranked.map((option) => option.sku_id)).toEqual(['bbq-skewers']);
  });

  it('never offers plain chicken when the source explicitly says BBQ/skewer', () => {
    const bbqAnchor: MatchAnchor = {
      ...anchor,
      name: 'Vomar BBQ kipfilet spies',
      head_term: 'kipfilet',
      ean: null,
      intent_aisle: 9,
      is_base: false,
    };
    const ranked = rankPreviewAlternatives([
      candidate({
        sku_id: 'plain-chicken',
        name: 'AH Scharrel kipfilet 800 g',
        intent_aisle: 9,
        is_base: true,
        confidence: 0.99,
      }),
    ], {
      anchor: bbqAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    expect(ranked).toEqual([]);
  });

  // live gezien 2026-07-14: AH-melk 1 l (zonder pack_size, wel eenheidsprijs)
  // kreeg een 500 ml-pak als Meest vergelijkbaar — de inhoud moet dan uit
  // prijs ÷ eenheidsprijs komen, voor anker én kandidaten.
  it('derives pack sizes from the unit price when pack_size is missing', () => {
    const litreAnchor: MatchAnchor = {
      ...anchor,
      name: 'Mijn Melk Volle melk',
      ean: null,
      pack_size_value: null,
      pack_size_unit: null,
      price_cents: 105,
      unit_price_cents_per_std: 105,
      std_unit: 'l',
    };
    const halfLitre = candidate({
      sku_id: 'half', name: 'Jumbo Houdbare Volle Melk 500ML', confidence: 0.95,
      price_cents: 89, unit_price_cents_per_std: 178, std_unit: 'l',
    });
    const fullLitre = candidate({
      sku_id: 'full', name: 'Jumbo Houdbare Volle Melk 1L', confidence: 0.85,
      price_cents: 99, unit_price_cents_per_std: 99, std_unit: 'l',
    });

    const ranked = rankPreviewAlternatives([halfLitre, fullLitre], {
      anchor: litreAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    expect(ranked.map((option) => option.sku_id)).toEqual(['full', 'half']);
    const bySku = new Map(ranked.map((option) => [option.sku_id, option]));
    expect(bySku.get('half')?.suggested_qty).toBeNull();
    expect(bySku.get('full')?.suggested_qty).toBeNull();
  });

  it('ranks the exact 1.5 L apple juice above a higher-confidence 1 L variant', () => {
    const appleJuiceAnchor: MatchAnchor = {
      ...anchor,
      name: 'AH Appelsap',
      ean: null,
      pack_size_value: null,
      pack_size_unit: null,
      price_cents: 159,
      unit_price_cents_per_std: 106,
      std_unit: 'l',
    };
    const oneLitre = candidate({
      sku_id: '160956PAK',
      name: 'Jumbo Appelsap 1 L',
      confidence: 0.96,
      price_cents: 135,
      unit_price_cents_per_std: 135,
      std_unit: 'l',
    });
    const exactOneAndHalf = candidate({
      sku_id: '54848PAK',
      name: 'Jumbo Appelsap 1,5 L',
      confidence: 0.82,
      price_cents: 159,
      unit_price_cents_per_std: 106,
      std_unit: 'l',
      // live catalog value: noisy label, but same aisle + exact head family
      // must keep this true 1,5 L equivalent eligible.
      is_base: false,
    });

    const ranked = rankPreviewAlternatives([oneLitre, exactOneAndHalf], {
      anchor: appleJuiceAnchor,
      policy: 'precise',
      selectedSku: oneLitre.sku_id,
      quantity: '1',
      unit: null,
    });

    expect(ranked.map((option) => option.sku_id)).toEqual(['54848PAK', '160956PAK']);
    expect(ranked.every((option) => option.suggested_qty === null)).toBe(true);
  });

  it('never proposes extra packs, even when the alternative pack is smaller', () => {
    const packAnchor: MatchAnchor = { ...anchor, ean: null, pack_size_value: 800, pack_size_unit: 'g' };
    const smallPack = candidate({
      sku_id: 'small', name: 'PLUS Kwark bak', pack_size_value: 200, pack_size_unit: 'g',
    });
    const litrePack = candidate({
      sku_id: 'litre', name: 'PLUS Kwark drink', pack_size_value: 1, pack_size_unit: 'l',
    });
    const samePack = candidate({
      sku_id: 'same', name: 'PLUS Kwark emmer', pack_size_value: 800, pack_size_unit: 'g',
    });

    const ranked = rankPreviewAlternatives([smallPack, litrePack, samePack], {
      anchor: packAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    const bySku = new Map(ranked.map((option) => [option.sku_id, option]));
    expect(bySku.get('small')?.suggested_qty).toBeNull();
    expect(bySku.get('same')?.suggested_qty).toBeNull();
    // Een bekende liter-verpakking kan geen alternatief met "dezelfde
    // hoeveelheid" zijn voor een bekend gram-anker.
    expect(bySku.has('litre')).toBe(false);
    // Bij een expliciete eenheid op het item prijzen packs zichzelf al.
    const withUnit = rankPreviewAlternatives([smallPack], {
      anchor: packAnchor, policy: 'precise', quantity: '800', unit: 'g',
    });
    expect(withUnit[0]?.suggested_qty).toBeNull();
  });

  it('prices the quantity already on the list without inventing a pack multiplier', () => {
    const packAnchor: MatchAnchor = { ...anchor, ean: null, pack_size_value: 800, pack_size_unit: 'g' };
    const smallPack = candidate({
      sku_id: 'small', name: 'PLUS Kwark bak', pack_size_value: 200, pack_size_unit: 'g',
    });
    const ranked = rankPreviewAlternatives([smallPack], {
      anchor: packAnchor, policy: 'precise', quantity: '2', unit: null,
    });
    expect(ranked[0]?.suggested_qty).toBeNull();
    expect(ranked[0]?.line_price_cents).toBe(198);
  });

  it('shows one 2 x 180 g multipack and leaves any increase to the user', () => {
    const packAnchor: MatchAnchor = {
      ...anchor,
      name: 'Jumbo Lahmacun voordeelverpakking 750 g',
      ean: null,
      pack_size_value: null,
      pack_size_unit: null,
      price_cents: 649,
      unit_price_cents_per_std: 865,
      std_unit: 'kg',
    };
    const multipack = candidate({
      sku_id: '2x180',
      name: 'Mekkafood Lahmacun Turkse Pizza 2x180g',
      price_cents: 325,
      unit_price_cents_per_std: 903,
      std_unit: 'kg',
    });

    const [option] = rankPreviewAlternatives([multipack], {
      anchor: packAnchor,
      policy: 'precise',
      quantity: '1',
      unit: null,
    });

    expect(option?.suggested_qty).toBeNull();
    expect(option?.line_price_cents).toBe(325);
  });
});

describe('priceList EAN-only automatic choices', () => {
  function eanPricingQuery(exactRows: MatchCandidate[]) {
    return vi.fn(async (sql: string) => {
      if (sql.includes('FROM app.list_items i WHERE')) {
        return {
          rows: [{
            id: 'item-1',
            name: 'Jumbo Rond Wit Half',
            quantity: '1',
            unit: null,
            item_normalised: 'wit brood',
            matches: {
              jumbo: { sku_id: anchor.sku_id, user_pinned: true, preferred: true },
            },
          }],
        };
      }
      if (sql.includes('FROM catalog.chains WHERE')) {
        return {
          rows: [{ id: 'plus', full_assortment: true, enabled: true, last_ingest_at: '2026-07-16T12:00:00Z' }],
        };
      }
      if (sql.includes('FROM catalog.match_policy_calibration')) return { rows: [] };
      if (sql.includes('WHERE p.chain_id = $1 AND p.sku_id = $2')) {
        return {
          rows: [{
            ...anchor,
            price_cents: 99,
            unit_price_cents_per_std: null,
            std_unit: null,
            intent_aisle: 6,
          }],
        };
      }
      if (sql.includes("NULLIF(ltrim(p.ean, '0'), '')")) return { rows: exactRows };
      if (sql.includes('p.sku_id = ANY($2)')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql.slice(0, 100)}`);
    });
  }

  it('automatically accepts the exact same EAN at another supermarket', async () => {
    const exact = candidate({
      chain_id: 'plus',
      sku_id: 'plus-same-ean',
      name: 'PLUS Rond wit half',
      ean: anchor.ean,
    });
    const query = eanPricingQuery([exact]);

    const [priced] = await priceList('list-1', ['plus'], 'user-1', {}, { query } as never);

    expect(priced?.lines[0]).toMatchObject({
      matched: true,
      decision: 'accepted',
      sku_id: 'plus-same-ean',
      match_origin: 'automatic',
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('WITH terms AS'))).toBe(false);
  });

  it('leaves the item unmatched when another supermarket has no exact EAN', async () => {
    const query = eanPricingQuery([]);

    const [priced] = await priceList('list-1', ['plus'], 'user-1', {}, { query } as never);

    expect(priced?.lines[0]).toMatchObject({
      matched: false,
      decision: 'unavailable',
    });
    expect(priced?.total_cents).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('WITH terms AS'))).toBe(false);
  });
});

describe('priceShoppingSession', () => {
  it('retrieves manual candidates once but never auto-selects an anchorless name match', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM app.list_items i WHERE')) {
        return {
          rows: [{
            id: 'item-1',
            name: 'melk',
            quantity: '1',
            unit: null,
            item_normalised: 'melk',
            matches: {},
          }],
        };
      }
      if (sql.includes('FROM catalog.chains WHERE')) {
        return {
          rows: [{ id: 'plus', full_assortment: true, enabled: true, last_ingest_at: '2026-07-13T12:00:00Z' }],
        };
      }
      if (sql.includes('FROM catalog.match_policy_calibration')) return { rows: [] };
      if (sql.includes('WITH terms AS')) {
        return {
          rows: [candidate({
            chain_id: 'plus',
            sku_id: 'milk-1',
            name: 'PLUS Melk',
            price_cents: 150,
            confidence: 0.85,
            source: 'semantic',
            canonical_name: 'melk',
            head_term: 'melk',
            intent_form: 'vers',
          })],
        };
      }
      if (sql.includes('FROM catalog.ingredient_lexicon')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    });

    const result = await priceShoppingSession(
      'list-1',
      ['plus'],
      'user-1',
      {},
      { query } as never
    );

    // List, chain, calibration, lexicon and the expensive candidate SQL each
    // execute once, rather than once per policy.
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('WITH terms AS'))).toHaveLength(1);
    const fullItemQuery = query.mock.calls.find(([sql]) => String(sql).includes('FROM app.list_items i WHERE'));
    expect(fullItemQuery?.[0]).not.toContain('i.id = ANY');
    expect(fullItemQuery?.[1]).toEqual(['list-1']);

    expect(result.precise[0]).toMatchObject({
      chain_id: 'plus', accepted: 0, review: 0, unavailable: 1,
      accepted_total_cents: 0,
    });
    expect(result.practical[0]).toMatchObject({
      chain_id: 'plus', accepted: 0, review: 0, unavailable: 1,
      accepted_total_cents: 0,
    });
    expect(result.value[0]).toMatchObject({
      chain_id: 'plus', accepted: 0, review: 0, unavailable: 1,
      accepted_total_cents: 0,
    });
    for (const policy of ['precise', 'practical', 'value'] as const) {
      expect(result[policy][0]?.lines[0]).toMatchObject({
        decision: 'unavailable',
        matched: false,
      });
      expect(result[policy][0]?.lines[0]?.alternatives?.[0]).toMatchObject({
        sku_id: 'milk-1',
      });
    }

    const payload = buildShoppingSessionPayload('list-1', result);
    expect(payload).toMatchObject({
      list_id: 'list-1',
      matcher_version: 'policy-v2-ean',
      pricing_policy: 'precise',
      policies: {
        precise: [{ chain_id: 'plus' }],
        practical: [{ chain_id: 'plus' }],
        value: [{ chain_id: 'plus' }],
      },
    });
    // Base pricing is policies.precise by contract, rather than a fourth copy
    // of the largest policy array in the wire payload.
    expect(Object.keys(payload).sort()).toEqual([
      'list_id', 'matcher_version', 'policies', 'pricing_policy',
    ]);
  });

  it('queries and projects only explicitly requested item IDs', async () => {
    const requestedId = '00000000-0000-4000-8000-000000000001';
    const otherId = '00000000-0000-4000-8000-000000000002';
    const rows = [
      {
        id: requestedId,
        name: 'melk',
        quantity: '1',
        unit: null,
        item_normalised: 'melk',
        matches: {},
      },
      {
        id: otherId,
        name: 'brood',
        quantity: '1',
        unit: null,
        item_normalised: 'brood',
        matches: {},
      },
    ];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM app.list_items i WHERE')) {
        const ids = params?.[1] as string[] | undefined;
        return { rows: ids ? rows.filter((row) => ids.includes(row.id)) : rows };
      }
      if (sql.includes('FROM catalog.chains WHERE')) {
        return {
          rows: [{ id: 'plus', full_assortment: true, enabled: true, last_ingest_at: '2026-07-13T12:00:00Z' }],
        };
      }
      if (sql.includes('FROM catalog.match_policy_calibration')) return { rows: [] };
      if (sql.includes('WITH terms AS')) {
        return {
          rows: [candidate({
            chain_id: 'plus',
            sku_id: 'milk-1',
            name: 'PLUS Melk',
            price_cents: 150,
            confidence: 0.85,
            source: 'semantic',
            canonical_name: 'melk',
            head_term: 'melk',
            intent_form: 'vers',
          })],
        };
      }
      if (sql.includes('FROM catalog.ingredient_lexicon')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    });

    const result = await priceShoppingSession(
      'list-1',
      ['plus'],
      'user-1',
      { itemIds: [requestedId] },
      { query } as never
    );

    const itemQueries = query.mock.calls.filter(([sql]) => String(sql).includes('FROM app.list_items i WHERE'));
    expect(itemQueries).toHaveLength(1);
    expect(itemQueries[0]?.[0]).toContain('i.id = ANY($2::uuid[])');
    expect(itemQueries[0]?.[1]).toEqual(['list-1', [requestedId]]);
    for (const policy of ['precise', 'practical', 'value'] as const) {
      expect(result[policy][0]?.lines.map((line) => line.item_id)).toEqual([requestedId]);
    }
  });

  it('keys shared item retrieval by the requested subset', async () => {
    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';
    const rows = [
      { id: firstId, name: 'melk', quantity: '1', unit: null, item_normalised: 'melk', matches: {} },
      { id: secondId, name: 'brood', quantity: '1', unit: null, item_normalised: 'brood', matches: {} },
    ];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM app.list_items i WHERE')) {
        const ids = params?.[1] as string[] | undefined;
        return { rows: ids ? rows.filter((row) => ids.includes(row.id)) : rows };
      }
      if (sql.includes('FROM catalog.chains WHERE')) return { rows: [] };
      if (sql.includes('FROM catalog.match_policy_calibration')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    });
    const retrievalCache = createPricingRetrievalCache();
    const client = { query } as never;

    await priceList('list-1', [], 'user-1', { itemIds: [firstId], retrievalCache }, client);
    await priceList('list-1', [], 'user-1', { itemIds: [secondId], retrievalCache }, client);
    await priceList('list-1', [], 'user-1', { retrievalCache }, client);

    const itemQueries = query.mock.calls.filter(([sql]) => String(sql).includes('FROM app.list_items i WHERE'));
    expect(itemQueries).toHaveLength(3);
    expect(itemQueries.map(([, params]) => params)).toEqual([
      ['list-1', [firstId]],
      ['list-1', [secondId]],
      ['list-1'],
    ]);
  });

  it('does not retrieve name candidates during ordinary EAN-only pricing', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM app.list_items i WHERE')) {
        return {
          rows: [{
            id: 'item-1', name: 'melk', quantity: '1', unit: 'l',
            item_normalised: 'melk', matches: {},
          }],
        };
      }
      if (sql.includes('FROM catalog.chains WHERE')) {
        return {
          rows: [{ id: 'plus', full_assortment: true, enabled: true, last_ingest_at: '2026-07-16T12:00:00Z' }],
        };
      }
      if (sql.includes('FROM catalog.match_policy_calibration')) return { rows: [] };
      throw new Error(`Ordinary pricing unexpectedly searched candidates: ${sql.slice(0, 80)}`);
    });

    const result = await priceList('list-1', ['plus'], 'user-1', {}, { query } as never);

    expect(result[0]).toMatchObject({
      chain_id: 'plus', matched: 0, total_cents: 0, unmatched: ['melk'],
    });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
