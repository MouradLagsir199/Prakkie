import { describe, it, expect } from 'vitest';
import { nameHash, toRow } from './facet-run.mjs';
import { verifyFacets } from './facets.mjs';

describe('facet-run helpers', () => {
  it('nameHash is stabiel en verandert bij verpakkingswijziging', () => {
    const a = { name: 'AH Cola zero', brand: 'AH', pack_size_value: 1.5, pack_size_unit: 'l' };
    const b = { ...a, pack_size_value: 1 };
    expect(nameHash(a)).toBe(nameHash(a));
    expect(nameHash(a)).not.toBe(nameHash(b));
  });

  it('toRow mapt facetstruct + verify-uitkomst naar een DB-rij', () => {
    const p = { chain_id: 'ah', sku_id: 'wi123', name: 'AH Cola zero 1,5 L', brand: 'AH', pack_size_value: 1.5, pack_size_unit: 'l' };
    const facets = { category: 'frisdrank', brand_tier: 'private_label', variant: 'zero', flavor: 'regular', form: 'houdbaar', dietary: [], type: null, pack: { value: 1.5, unit: 'l' } };
    const row = toRow(p, verifyFacets(facets, { name: p.name, intent_form: 'houdbaar', pack_size_value: 1.5 }));
    expect(row).toMatchObject({
      chain_id: 'ah', sku_id: 'wi123', category: 'frisdrank', brand_tier: 'private_label',
      variant: 'zero', form: 'houdbaar', verified: true, matcher_version: 'graph-v1',
    });
    expect(row.pack_value).toBe(1.5);
    expect(typeof row.name_hash).toBe('string');
  });
});
