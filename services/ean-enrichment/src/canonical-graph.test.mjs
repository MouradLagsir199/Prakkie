import { describe, it, expect } from 'vitest';
import { canonicalKey, buildCanonicalNodes } from './canonical-graph.mjs';

const p = (over) => ({
  chain_id: 'ah', sku_id: 's1', category: 'frisdrank',
  variant: 'zero', flavor: 'regular', form: 'houdbaar', type: null, dietary: [],
  confidence: 0.9, verified: true, ...over,
});

describe('canonical graph clustering', () => {
  it('huismerk + huismerk + A-merk cola zero → één canonieke knoop (brand_tier zacht)', () => {
    const nodes = buildCanonicalNodes([
      p({ chain_id: 'ah', sku_id: 'a', brand_tier: 'private_label' }),
      p({ chain_id: 'plus', sku_id: 'b', brand_tier: 'private_label' }),
      p({ chain_id: 'jumbo', sku_id: 'c', brand_tier: 'a_merk' }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].members).toHaveLength(3);
    expect(nodes[0].members[0].reasons.join(' ')).toContain('variant: zero');
  });

  it('cola zero en gewone cola → aparte knopen (variant is hard)', () => {
    const nodes = buildCanonicalNodes([
      p({ sku_id: 'a', variant: 'zero' }),
      p({ chain_id: 'plus', sku_id: 'b', variant: 'regular' }),
    ]);
    expect(nodes).toHaveLength(2);
  });

  it('sperziebonen blik vs zak → aparte knopen (vorm is hard voor groente)', () => {
    const nodes = buildCanonicalNodes([
      p({ sku_id: 'a', category: 'groente', form: 'blik', type: 'sperziebonen' }),
      p({ chain_id: 'plus', sku_id: 'b', category: 'groente', form: 'vers', type: 'sperziebonen' }),
    ]);
    expect(nodes).toHaveLength(2);
  });

  it('onverifieerde rijen tellen niet mee', () => {
    const nodes = buildCanonicalNodes([p({ verified: false })]);
    expect(nodes).toHaveLength(0);
  });

  it('canonicalKey is stabiel over volgorde van dietary', () => {
    const a = canonicalKey({ category: 'zuivel-melk', type: 'halfvol', dietary: ['bio', 'lactosevrij'] });
    const b = canonicalKey({ category: 'zuivel-melk', type: 'halfvol', dietary: ['lactosevrij', 'bio'] });
    expect(a).toBe(b);
  });
});
