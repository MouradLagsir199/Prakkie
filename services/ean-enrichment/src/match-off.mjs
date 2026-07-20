// Offline OFF→catalogus matching: geef producten zonder scraper-EAN een EAN
// uit Open Food Facts. Dit is bewust de énige plek waar nog op naam gematcht
// wordt — één keer, offline, met provenance — zodat de runtime-matcher puur
// op EAN-identiteit kan draaien. Precisie gaat vóór dekking: een gemiste EAN
// betekent alleen "geen automatische substitutie", een fóúte EAN betekent
// het verkeerde product in iemands mandje.

export const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const tokensOf = (s) => fold(s).split(' ').filter(Boolean);
const tokenKey = (s) => [...new Set(tokensOf(s))].sort().join(' ');

/** EAN-8, UPC-12, EAN-13 of GTIN-14 — al het andere is ruis uit OFF. */
export const validEan = (code) => /^(\d{8}|\d{12,14})$/.test(String(code ?? '').trim());
/** Zelfde normalisatie als de 0032-index: leidende nullen weg. */
export const normaliseEan = (code) => String(code ?? '').trim().replace(/^0+/, '');

// hoeveelheids-parsing: OFF `quantity` is vrije tekst ("500 g", "6 x 330 ml",
// "1,5 L"); de keten-kant heeft pack_size_value + pack_size_unit.
const UNIT_TO_BASE = {
  mg: { f: 0.001, u: 'g' },
  g: { f: 1, u: 'g' },
  gr: { f: 1, u: 'g' },
  gram: { f: 1, u: 'g' },
  kg: { f: 1000, u: 'g' },
  ml: { f: 1, u: 'ml' },
  cl: { f: 10, u: 'ml' },
  dl: { f: 100, u: 'ml' },
  l: { f: 1000, u: 'ml' },
  liter: { f: 1000, u: 'ml' },
  litre: { f: 1000, u: 'ml' },
};

/** "6 x 330 ml" | "500g" | "1,5 L" → { value: <base>, unit: 'g'|'ml' } | null */
export function parseOffQuantity(quantity) {
  if (!quantity) return null;
  const text = String(quantity).toLowerCase().replace(/,/g, '.');
  const multi = text.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mg|gr?|gram|kg|ml|cl|dl|l|liter|litre)\b/);
  if (multi) {
    const m = UNIT_TO_BASE[multi[3]];
    return m ? { value: Number(multi[1]) * Number(multi[2]) * m.f, unit: m.u } : null;
  }
  const single = text.match(/(\d+(?:\.\d+)?)\s*(mg|gr?|gram|kg|ml|cl|dl|l|liter|litre)\b/);
  if (!single) return null;
  const m = UNIT_TO_BASE[single[2]];
  return m ? { value: Number(single[1]) * m.f, unit: m.u } : null;
}

/** Keten-pack (pack_size_value + unit uit catalog.products) → zelfde basis. */
export function chainPackBase(value, unit) {
  if (value === null || value === undefined || !unit) return null;
  const m = UNIT_TO_BASE[String(unit).toLowerCase()];
  return m ? { value: Number(value) * m.f, unit: m.u } : null; // 'st'/'stuks' → null: niet vergelijkbaar met OFF-massa
}

/** true = zelfde verpakking (±2%), false = aantoonbaar anders, null = onbekend. */
export function packCompatible(chainBase, offBase) {
  if (!chainBase || !offBase) return null;
  if (chainBase.unit !== offBase.unit) return null; // g vs ml zegt niets (dichtheid), geen contradictie claimen
  const ratio = chainBase.value / offBase.value;
  return ratio >= 0.98 && ratio <= 1.02;
}

/** true = merk bevestigd, false = beide bekend en verschillend, null = onbekend. */
export function brandCompatible(product, entry) {
  const brandF = fold(product.brand);
  const nameTokens = new Set(tokensOf(product.name));
  if (brandF && entry.brandParts.length) {
    const hit = entry.brandParts.some((p) => p === brandF || p.includes(brandF) || brandF.includes(p));
    return hit;
  }
  if (entry.brandParts.length) {
    // keten kent geen merkveld — het OFF-merk kan wél in de productnaam staan
    const hit = entry.brandParts.some((p) => tokensOf(p).every((t) => nameTokens.has(t)));
    return hit ? true : null;
  }
  return null;
}

/**
 * Indexeer de NL-OFF-rijen op gevouwen naam en op token-set-sleutel, elk ook
 * in de variant mét merk ervoor — winkelnamen dragen het merk vaak in de titel
 * ("Duo Penotti Duopasta") waar OFF het in `brands` heeft staan.
 */
export function buildOffIndex(rows) {
  const byName = new Map();
  const byTokenKey = new Map();
  const byFirstToken = new Map(); // eerste niet-merk-naamtoken → entries (voedt containedMatch)
  const push = (map, key, entry) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  };
  let indexed = 0;
  for (const row of rows) {
    if (!validEan(row.ean)) continue;
    const nameF = fold(row.name);
    if (!nameF) continue;
    const entry = {
      ean: String(row.ean).trim(),
      name: row.name,
      brands: row.brands ?? null,
      brandParts: String(row.brands ?? '').split(',').map(fold).filter(Boolean),
      base: parseOffQuantity(row.quantity) ??
        chainPackBase(row.productQuantity ?? null, row.productQuantityUnit ?? null),
    };
    const seen = new Set();
    const pushBoth = (text) => {
      const k = fold(text);
      if (!k || seen.has(k)) return;
      seen.add(k);
      push(byName, k, entry);
      push(byTokenKey, tokenKey(text), entry);
    };
    pushBoth(row.name);
    for (const brandPart of entry.brandParts) {
      if (!nameF.startsWith(brandPart)) pushBoth(`${brandPart} ${nameF}`);
    }
    const firstToken = tokensOf(nameF).find(
      (t) => !entry.brandParts.some((p) => tokensOf(p).includes(t))
    );
    if (firstToken) push(byFirstToken, firstToken, entry);
    indexed++;
  }
  return { byName, byTokenKey, byFirstToken, size: indexed };
}

/** Kandidaten voor containedMatch: OFF-rijen wier eerste naamtoken in de
 *  productnaam voorkomt — houdt de subset-scan per product klein. */
export function containedCandidates(product, index) {
  const out = new Set();
  for (const token of tokensOf(product.name)) {
    for (const entry of index.byFirstToken.get(token) ?? []) out.add(entry);
  }
  return [...out];
}

const uniqueEan = (entries) => {
  const eans = new Set(entries.map((e) => normaliseEan(e.ean)));
  return eans.size === 1 ? entries[0] : null; // ambigu → liever geen match
};

/**
 * Match één catalogusproduct tegen de OFF-index. Cascade van streng naar
 * ruimer; elke tier eist dat verpakking en merk nergens tegenspreken en dat
 * er precies één EAN overblijft. Een ambigue strengere tier breekt af in
 * plaats van door te vallen — identieke namen met meerdere EAN's zijn
 * varianten die tokens tóch niet kunnen scheiden.
 */
export function matchProduct(product, index) {
  const nameF = fold(product.name);
  if (!nameF) return null;
  const brandF = fold(product.brand);
  const chainBase = chainPackBase(product.pack_size_value, product.pack_size_unit);
  const variants = [nameF];
  if (brandF && !nameF.startsWith(brandF)) variants.push(`${brandF} ${nameF}`);

  const admissible = (entry) =>
    brandCompatible(product, entry) !== false && packCompatible(chainBase, entry.base) !== false;

  // tier 1 — exacte (gevouwen) naamgelijkheid
  const exact = variants.flatMap((v) => index.byName.get(v) ?? []).filter(admissible);
  if (exact.length) {
    const hit = uniqueEan(exact);
    return hit ? { ean: hit.ean, method: 'off_exact', score: 0.97, off: hit } : null;
  }

  // tier 2 — zelfde token-set (woordvolgorde/dubbelingen vrij), plus minstens
  // één positief signaal: bevestigd merk of bevestigde verpakking
  const byTokens = [...new Set(variants.flatMap((v) => index.byTokenKey.get(tokenKey(v)) ?? []))]
    .filter(admissible)
    .filter((e) => brandCompatible(product, e) === true || packCompatible(chainBase, e.base) === true);
  if (byTokens.length) {
    const hit = uniqueEan(byTokens);
    return hit ? { ean: hit.ean, method: 'off_tokens', score: 0.9, off: hit } : null;
  }

  return null;
}

/**
 * Ruimste tier, apart aan te roepen over de hele index: naam-insluiting
 * (token-subset) met kéiharde eisen — merk bevestigd én verpakking bevestigd.
 * Los van matchProduct omdat dit een lineaire scan per product zou zijn; de
 * caller draait hem alleen over kandidaten met hetzelfde eerste naamtoken.
 */
export function containedMatch(product, entries) {
  const productTokens = new Set(tokensOf(product.name));
  const chainBase = chainPackBase(product.pack_size_value, product.pack_size_unit);
  const hits = entries.filter((entry) => {
    if (brandCompatible(product, entry) !== true) return false;
    if (packCompatible(chainBase, entry.base) !== true) return false;
    const offTokens = tokensOf(entry.name).filter((t) => !entry.brandParts.some((p) => tokensOf(p).includes(t)));
    if (offTokens.length < 2) return false; // "melk" past overal in — te generiek
    return offTokens.every((t) => productTokens.has(t));
  });
  if (!hits.length) return null;
  const hit = uniqueEan(hits);
  return hit ? { ean: hit.ean, method: 'off_contained', score: 0.82, off: hit } : null;
}
