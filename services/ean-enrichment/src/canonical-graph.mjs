// Canonical Product Graph (matching v2, docs/09 §3 pijler 2 / Fase 3).
//
// Elke geverifieerde SKU krijgt een canonieke sleutel = categorie + de HARDE
// facetten voor die categorie (per beleid). SKU's met dezelfde sleutel zijn
// siblings onder één canonieke knoop — dat is "hetzelfde product-concept",
// óók over ketens en merken heen. Omdat brand_tier ZACHT is, clusteren
// AH-huismerk, PLUS-huismerk en het A-merk cola-zero samen: precies de
// cross-chain (huismerk-)match die EAN-only nooit kon maken.
//
// Puur en deterministisch: geen netwerk, geen DB. De DB-builder (canonical-run.mjs)
// leest catalog.product_facets en schrijft het resultaat weg.
import { createHash } from 'node:crypto';
import { categoryPolicy } from './facets.mjs';

const norm = (v) => (v == null || v === '' ? '' : String(v).toLowerCase());

/** De canonieke sleutel: categorie + harde-facetwaarden (stabiel, geordend). */
export function canonicalKey(facets, policies) {
  const policy = categoryPolicy(facets.category, policies);
  const parts = policy.hard.map((k) => {
    if (k === 'category') return `cat=${norm(facets.category)}`;
    if (k === 'dietary') {
      const d = [...(facets.dietary ?? [])].map(norm).filter(Boolean).sort().join('+');
      return `dietary=${d}`;
    }
    // variant/flavor: ontbrekend = neutrale basisvariant (zie facets.mjs).
    if (k === 'variant' || k === 'flavor') return `${k}=${norm(facets[k]) || 'regular'}`;
    return `${k}=${norm(facets[k])}`;
  });
  return parts.join('|');
}

/** Stabiel, kort id uit de sleutel (deterministisch — geen Math.random). */
export function canonicalId(key) {
  return 'cn_' + createHash('sha1').update(key).digest('hex').slice(0, 16);
}

const FACET_LABEL_NL = { variant: 'variant', flavor: 'smaak', form: 'vorm', type: 'soort', dietary: 'dieet' };

/** Leesbare "waarom deze knoop": de gedeelde harde facetten. */
export function memberReasons(facets, policies) {
  const policy = categoryPolicy(facets.category, policies);
  return policy.hard
    .filter((k) => k !== 'category')
    .map((k) => {
      const label = FACET_LABEL_NL[k] ?? k;
      const v = k === 'dietary'
        ? ([...(facets.dietary ?? [])].map(norm).filter(Boolean).join('/') || 'geen')
        : (k === 'variant' || k === 'flavor' ? norm(facets[k]) || 'regular' : norm(facets[k]) || '—');
      return `${label}: ${v}`;
    });
}

function label(facets) {
  return [facets.category, facets.type, facets.variant !== 'regular' ? facets.variant : null,
    facets.flavor !== 'regular' ? facets.flavor : null, facets.form]
    .map(norm).filter(Boolean).join(' · ');
}

/**
 * Bouw canonieke knopen uit geverifieerde facetrijen.
 * `products`: [{chain_id, sku_id, category, variant, flavor, form, type, dietary, confidence, verified}]
 * Retourneert [{canonical_id, facet_key, category, label, members:[{chain_id,sku_id,confidence,reasons}]}].
 */
export function buildCanonicalNodes(products, policies) {
  const byId = new Map();
  for (const p of products) {
    if (!p.verified) continue; // onzekere facetten doen niet mee aan clustering
    const key = canonicalKey(p, policies);
    const id = canonicalId(key);
    let node = byId.get(id);
    if (!node) {
      node = { canonical_id: id, facet_key: key, category: p.category ?? null, label: label(p), members: [] };
      byId.set(id, node);
    }
    node.members.push({
      chain_id: p.chain_id,
      sku_id: p.sku_id,
      confidence: p.confidence ?? 0,
      reasons: memberReasons(p, policies),
    });
  }
  return [...byId.values()];
}
