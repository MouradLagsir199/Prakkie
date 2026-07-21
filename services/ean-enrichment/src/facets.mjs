// Facet-kern van matching v2 (docs/09_matching_architecture.md, Fase 0).
//
// Pure, deterministische logica — geen netwerk, geen DB. Twee dingen:
//   1. verifyFacets(): kruiscontrole van een (LLM-)facetstruct tegen de
//      gestructureerde velden die we al hebben. Onenigheid → lage confidence →
//      het product mag NIET auto-matchen (valt naar COMPROMISE). Dit is de
//      anti-"wit brood"-poort: één fragiel signaal wordt nooit blind vertrouwd.
//   2. classify(): de vier-uitgangen-funnel EXACT/EQUIVALENT/COMPROMISE/NO_MATCH
//      op basis van per-categorie harde/zachte facetten.
//
// Facetstruct (ProductFacets):
//   { category, brand_tier, variant, flavor, form, dietary[], type, pack }
// form-waarden sluiten aan op catalog.product_intent.form.

export const FORM_VALUES = [
  'vers', 'blik', 'pot', 'diepvries', 'gedroogd', 'houdbaar', 'bewerkt', 'non-food',
];
export const BRAND_TIERS = ['a_merk', 'private_label', 'value_line'];

export const FACET_MATCHER_VERSION = 'graph-v1';

// Per-categorie beleid: welke facetten zijn hard (kunnen niet weg-gerankt
// worden) en welke zacht (alleen rangschikking). Categoriesleutels zijn
// fijnmazige slugs; 'type' is het categorie-specifieke subtype
// (vet vol/half/mager, kristal/basterd, sperziebonen/doperwten…).
const CATEGORY_POLICY = {
  frisdrank:      { hard: ['category', 'variant', 'flavor'], soft: ['brand_tier', 'form', 'pack'] },
  'zuivel-melk':  { hard: ['category', 'type', 'dietary'],   soft: ['brand_tier', 'pack'] },
  // groente: één basiscategorie voor vers/blik/diepvries; de vorm is de harde as.
  groente:        { hard: ['category', 'form', 'type'],      soft: ['brand_tier', 'pack', 'dietary'] },
  suiker:         { hard: ['category', 'type'],              soft: ['brand_tier', 'form', 'pack'] },
};

// Conservatieve fallback voor de longtail: categorie + vorm hard, rest zacht.
// Neigt naar "vraag het de gebruiker", nooit naar een zelfverzekerde foute swap.
const FALLBACK_POLICY = {
  hard: ['category', 'form'],
  soft: ['brand_tier', 'variant', 'flavor', 'type', 'dietary', 'pack'],
};

export function categoryPolicy(category) {
  return CATEGORY_POLICY[category] ?? FALLBACK_POLICY;
}

/** Leidende nullen weg zodat GTIN-13/EAN-8-varianten gelijk vergelijken. */
function normEan(ean) {
  if (!ean) return null;
  const digits = String(ean).replace(/\D/g, '').replace(/^0+/, '');
  return digits.length ? digits : null;
}

/** variant/flavor: ontbrekend telt als de neutrale basisvariant. */
function normVariant(v) {
  return v == null || v === '' ? 'regular' : String(v).toLowerCase();
}

/** Bevredigt kandidaat de bron op één harde facet? */
function facetSatisfied(key, source, cand) {
  switch (key) {
    case 'category':
      return source.category === cand.category;
    case 'variant':
    case 'flavor':
      return normVariant(source[key]) === normVariant(cand[key]);
    case 'form':
    case 'type':
      return (source[key] ?? null) === (cand[key] ?? null);
    case 'dietary': {
      // Elke dieet-eis van de bron moet de kandidaat ook waarmaken
      // (lactosevrij bron → alleen lactosevrije kandidaat; regular bron → vrij).
      const need = new Set(source.dietary ?? []);
      const has = new Set(cand.dietary ?? []);
      for (const d of need) if (!has.has(d)) return false;
      return true;
    }
    default:
      return true; // onbekende/zachte sleutel gates nooit
  }
}

const FACET_LABEL_NL = {
  variant: 'variant',
  flavor: 'smaak',
  form: 'vorm',
  type: 'soort',
  dietary: 'dieet',
  category: 'categorie',
};

function brokenReason(key, source, cand) {
  const label = FACET_LABEL_NL[key] ?? key;
  const want = key === 'dietary' ? (source.dietary ?? []).join('/') : (source[key] ?? '—');
  const got = key === 'dietary' ? (cand.dietary ?? []).join('/') || 'geen' : (cand[key] ?? '—');
  return `andere ${label} (${got} i.p.v. ${want})`;
}

/**
 * De vier-uitgangen-funnel. `source` en `cand` zijn ProductFacets-structs,
 * elk met optioneel `ean`. Retourneert { decision, reasons[], broken[] }.
 */
export function classify(source, cand) {
  // EXACT: identiek artikel, hier goedkoper — geen substitutie.
  const se = normEan(source.ean);
  const ce = normEan(cand.ean);
  if (se && ce && se === ce) {
    return { decision: 'EXACT', reasons: ['identiek product (zelfde EAN)'], broken: [] };
  }

  // Andere categorie → niet beschikbaar als substituut.
  if (source.category !== cand.category) {
    return { decision: 'NO_MATCH', reasons: ['andere categorie'], broken: [] };
  }

  const policy = categoryPolicy(source.category);
  const hardNonCategory = policy.hard.filter((k) => k !== 'category');
  const broken = hardNonCategory.filter((k) => !facetSatisfied(k, source, cand));

  if (broken.length === 0) {
    const matched = ['category', ...hardNonCategory]
      .map((k) => (k === 'category' ? source.category : source[k]))
      .filter((v) => v != null && v !== '');
    return { decision: 'EQUIVALENT', reasons: [`gematcht: ${matched.join(' · ')}`], broken: [] };
  }
  return {
    decision: 'COMPROMISE',
    reasons: broken.map((k) => brokenReason(k, source, cand)),
    broken,
  };
}

/**
 * Kruiscontrole van een facetstruct tegen gestructureerde velden. `structured`
 * bevat wat we al in de catalogus hebben:
 *   { name, brand, pack_size_value, pack_size_unit, category_path[],
 *     intent_form, is_organic }
 * Retourneert { facets, confidence, verified, disagreements[] }.
 * verified === false → dit product is uitgesloten van auto-matchen.
 */
export function verifyFacets(facets, structured = {}) {
  const disagreements = [];
  let confidence = 0.9;
  let hardConflict = false;

  // 1. FORM komt van het schap (product_intent.form / categorie), niet van de
  //    LLM — die kan 'vers' vs 'houdbaar' niet uit een kale productnaam afleiden.
  //    De anti-"wit brood"-poort is daarom géén botte llm≠intent-vergelijking,
  //    maar een gerichte check: een schap-label 'vers' op iets dat overduidelijk
  //    een houdbare mix/poeder is (naam + categoriepad) → signalen spreken elkaar
  //    tegen → niet vertrouwen.
  const shelfForm = structured.intent_form ?? null;
  const nameLC = (structured.name ?? '').toLowerCase();
  const pathLC = (structured.category_path ?? []).join(' ').toLowerCase();
  const looksLikeMix =
    /\b(mix|bakmix|poeder|poedermix|concentraat|siroop|aanmaak)\b/.test(nameLC) ||
    /bakmix|bakproduct/.test(pathLC);
  let effectiveForm = shelfForm ?? facets.form ?? null;
  if ((shelfForm === 'vers' || facets.form === 'vers') && looksLikeMix) {
    disagreements.push('form: schap zegt vers maar naam/pad duidt op mix/poeder');
    hardConflict = true;
    effectiveForm = facets.form ?? shelfForm; // behoud de LLM-lezing (houdbaar)
  }
  facets = { ...facets, form: effectiveForm };

  // 2. categorie moet ergens in het keten-categoriepad terugkomen (zacht).
  if (facets.category && Array.isArray(structured.category_path) && structured.category_path.length) {
    const path = structured.category_path.join(' ').toLowerCase();
    const head = facets.category.split(/[-/]/)[0];
    if (head && !path.includes(head)) {
      disagreements.push(`category: ${facets.category} niet in pad [${structured.category_path.join(', ')}]`);
      confidence -= 0.15;
    }
  }

  // 3. bio vs name_canonical.is_organic (zacht).
  const claimsBio = (facets.dietary ?? []).includes('bio');
  if (typeof structured.is_organic === 'boolean' && claimsBio !== structured.is_organic) {
    disagreements.push(`bio: llm=${claimsBio} vs is_organic=${structured.is_organic}`);
    confidence -= 0.15;
  }

  // 4. verpakking vs pack_size (zacht) — grove sanity, geen exacte eis.
  if (facets.pack?.value != null && structured.pack_size_value != null) {
    const a = Number(facets.pack.value);
    const b = Number(structured.pack_size_value);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0 && Math.abs(a - b) / b > 0.1) {
      disagreements.push(`pack: llm=${a}${facets.pack.unit ?? ''} vs ${b}${structured.pack_size_unit ?? ''}`);
      confidence -= 0.1;
    }
  }

  confidence = Math.max(0, Math.min(0.99, confidence));
  const verified = !hardConflict && confidence >= 0.7;
  return { facets, confidence, verified, disagreements };
}
