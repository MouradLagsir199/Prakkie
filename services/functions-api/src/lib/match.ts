import type { PoolClient } from 'pg';
import { query } from './db';

/**
 * E3 matcher (plan/05 WS2): ingredient → SKU per chain, cascade
 *   user correction (E5) → lexicon hint → pg_trgm fuzzy over catalog.products
 * with confidence + shortlist fallback. pgvector semantic sits behind the same
 * seam once embeddings exist (owner input #6); absent embeddings it degrades
 * to the fuzzy tier. One round-trip matches one item across all chains.
 *
 * NB (owner 2026-07-14): dit bestand matcht *ingrediënttermen* aan producten —
 * dat kan alleen op naam. Product→product (cross-chain, "hetzelfde artikel bij
 * een andere keten") gaat uitsluitend op EAN-identiteit in pricing.ts; de
 * vroegere beeld- en anker-naam-tiers zijn verwijderd.
 */

export interface MatchCandidate {
  chain_id: string;
  sku_id: string;
  ean?: string | null;
  name: string;
  brand: string | null;
  price_cents: number;
  promo_price_cents: number | null;
  promo: unknown;
  unit_price_cents_per_std: number | null;
  std_unit: string | null;
  pack_size_value: number | null;
  pack_size_unit: string | null;
  image_url: string | null;
  product_url: string | null;
  aisle_group_id: number | null;
  confidence: number;
  source: 'ean' | 'correction' | 'lexicon' | 'trgm' | 'semantic';
  /** "het gezochte product zelf" (canonieke naam eindigt op de term — NL is
   *  kop-finaal) vs. samengesteld/afgeleid ("roomboter croissant"). Stuurt de
   *  sortering in de app: eerst de echte varianten op prijs, dan de rest. */
  is_primary?: boolean;
  /** AI-intent (0025): de kale kern van wat het product ís ("volle melk") */
  head_term?: string | null;
  /** AI-intent (0025): vers|blik|pot|diepvries|gedroogd|houdbaar|bewerkt|non-food */
  intent_form?: string | null;
  /** AI-intent (0025): genormaliseerde winkelcategorie/afdeling. */
  intent_aisle?: number | null;
  /** AI-intent (0025): basisingrediënt vs samengesteld/kant-en-klaar (soep, saus, gebak) */
  is_base?: boolean | null;
  canonical_name?: string | null;
  canonical_key?: string | null;
  is_organic?: boolean | null;
}

export interface ChainMatch {
  best: MatchCandidate | null;
  /** shown when best.confidence < SHORTLIST_THRESHOLD (match-fix UX, E5) */
  shortlist: MatchCandidate[];
}

export const SHORTLIST_THRESHOLD = 0.72;
// owner UX 2026-07-06/07: the user always picks the product — every item gets a
// full dropdown, so the shortlist is broad (roombotercroissant must show up
// under "roomboter") and always returned, not only when the matcher doubts.
// 24 per chain: liever te veel opties met lagere confidence dan te weinig.
const SHORTLIST_SIZE = 24;

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Resolve an ingredient term through the lexicon (aliases → canonical item),
 * returning the search term + default aisle for list placement.
 */
export async function resolveLexicon(
  item: string,
  client?: Queryable
): Promise<{ term: string; aisleGroupId: number | null; aliases: string[] }> {
  const q = client ?? { query };
  const r = await q.query(
    `SELECT item_normalised, aisle_group_id, aliases FROM catalog.ingredient_lexicon
     WHERE item_normalised = $1 OR $1 = ANY(aliases) LIMIT 1`,
    [item]
  );
  if (r.rows[0]) {
    const term = String(r.rows[0].item_normalised);
    const aliases = [...new Set([item, term, ...((r.rows[0].aliases as string[]) ?? [])])];
    return { term, aisleGroupId: r.rows[0].aisle_group_id ?? null, aliases };
  }
  return { term: item, aisleGroupId: null, aliases: [item] };
}

// composite/processed product words: penalised when absent from the query itself
const PROCESSED_RX = '\\m(saus|soep|salade|mix|kruidenmix|poeder|drink|snack|chips|koek|koekje|koekjes|biscuit|biscuits|croissant|croissants|sprits|spritsen|smaak|geur|shampoo|spray|kattenvoer|hondenvoer|schotel|dagschotel|maaltijd)\\M';

// form words (conserven/bewerkingen): who "sperziebonen" zoekt wil vrijwel nooit
// "in blik gebroken". Alleen toegepast op vers-producten (aisle-groep 1) — bij
// kikkererwten/doperwten is blik/pot juist dé normale vorm. Bewust NIET in de
// lijst: diepvries, gesneden, gewassen, geraspt, gekookt (gekookte bietjes is
// de normale vorm), gezouten. Query "sperziebonen blik" krijgt géén penalty.
const FORM_RX = '\\m(blik|blikje|blikjes|pot|potje|gebroken|gedroogd|gedroogde|ingelegd|ingelegde|zoetzuur|zoetzure|tafelzuur)\\M';
// JS-spiegel van FORM_RX voor de is_primary-beslissing: de AI-intent zegt soms
// 'vers' tegen een pot gebroken sperziebonen, maar het vorm-woord in de
// productnaam zelf liegt niet (owner 2026-07-08, "gebroken sperziebonen eerst")
const FORM_WORDS_JS = /\b(blik|blikje|blikjes|pot|potje|gebroken|gedroogd|gedroogde|ingelegd|ingelegde|zoetzuur|zoetzure|tafelzuur)\b/;

// samengesteld-product-markers voor is_primary (owner 2026-07-07 avond):
// gebak, gerechten en afgeleiden die met het ingrediënt gemáákt zijn maar het
// ingrediënt niet zíjn. Suffix-match (geen \m-prefix): vangt ook samenstellingen
// als boterhamZAKJES, eiercakeJES, roomIJS. 'rijst' matcht 'ijs' NIET (de t
// breekt de woordgrens). Spiegel: DISH_WORDS in scripts/seed-lexicon-hints.mjs.
const COMPOSITE_RX = new RegExp(
  '(saus|soep|salade|schotel|maaltijd|mix|poeder|drink|snack|chips|koek|koekjes?|biscuits?' +
    '|croissants?|spritsen|sprits|taart|vlaai|wafels?|cakejes?|cake|flappen|flap|kano|tengels?' +
    "|kaastengel|carrees?|hoef|picolientjes?|zakjes?|creme|gebak|ijs|dessert|pizza|burgers?" +
    '|wraps?|broodjes?|repen|reep|spread|vulling|beleg|smaak|geur|shampoo|spray' +
    '|krakelingen?|kantjes|vlinders?|stengels?|soesjes?|bolussen?)($|\\s)'
);
// interpunctie → spatie: "kano's" moet als woord 'kano' matchen, niet dood op de apostrof
const foldJs = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const escRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// gesloten klasse kwaliteits-/vorm-bijvoeglijken: mogen in een canoniek naast de
// term staan zonder dat het een ánder product wordt ("verse roomboter ongezouten",
// "roomboter goud"). Elk ander rest-zelfstandig-naamwoord ⇒ samengesteld product.
const ADJ_WORDS = new Set([
  'gezouten', 'ongezouten', 'vers', 'verse', 'bio', 'biologisch', 'biologische', 'licht', 'lichte',
  'extra', 'fijn', 'fijne', 'puur', 'pure', 'echt', 'echte', 'goud', 'blend', 'traditioneel',
  'traditionele', 'ambachtelijk', 'ambachtelijke', 'natuur', 'naturel', 'halfvol', 'halfvolle',
  'vol', 'volle', 'mager', 'magere', 'houdbaar', 'houdbare', 'gras', 'weide', 'roomboter',
  'origineel', 'originele', 'klassiek', 'klassieke', 'mini', 'maxi', 'groot', 'grote', 'klein', 'kleine',
]);

// variant-conflict (owner-bug 2026-07-07): "volle melk" matchte "halfvolle melk"
// (trgm ziet de substring, niet de betekenis). Noemt de QUERY expliciet één
// variant uit een groep en het product een ándere, dan is dat een fout product
// — harde penalty. Query zonder variantwoord ("melk") krijgt níks: dan zijn
// alle varianten prima. \m..\M is woordgrens: "volle" matcht niet ín "halfvolle".
const VARIANT_RX = '\\m(volle|halfvolle|magere|lactosevrije?)\\M';

const CANDIDATE_SQL = `
WITH terms AS (SELECT DISTINCT unnest($1::text[]) AS q),
corrections AS (
  SELECT mc.chain_id, mc.chosen_sku_id
  FROM app.match_corrections mc
  WHERE mc.user_id = $4 AND mc.item_normalised = ANY($1 || $5)
),
hints AS (
  SELECT lp.chain_id, lp.sku_id, lp.rank
  FROM catalog.lexicon_products lp
  WHERE lp.item_normalised = ANY($1)
),
fuzzy AS (
  -- score shape per (query term, product): trgm similarity + whole-word boost
  -- + COVERAGE (how much of the product name the query explains — "uien" is
  -- all about "ui", "gehakt met ui" is not) + canonical-name equality against
  -- the full alias set ($6) + processed-product penalty. Cheap-first price is
  -- the final tiebreak so raw produce beats processed products at equal score.
  SELECT chain_id, sku_id, MAX(score) AS score, MIN(price_cents) AS price_cents FROM (
    SELECT p.chain_id, p.sku_id, p.price_cents,
           GREATEST(word_similarity(t.q, p.name), similarity(p.name, t.q))
           + CASE WHEN public.fold_text(p.name) ~ ('\\m' || t.q || '\\M') THEN 0.18 ELSE 0 END
           + CASE WHEN public.fold_text(p.name) = t.q THEN 0.35
                  WHEN public.fold_text(p.name) LIKE t.q || '%' THEN 0.12
                  ELSE 0 END
           + 0.45 * length(t.q)::float / GREATEST(length(p.name), length(t.q))
           + CASE WHEN public.fold_text(nc.display_name) = ANY($6) THEN 0.60
                  WHEN nc.display_name IS NOT NULL
                       AND public.fold_text(nc.display_name) ~ ('\\m' || t.q || '\\M') THEN 0.15
                  ELSE 0 END
           - CASE WHEN public.fold_text(p.name) ~ '${PROCESSED_RX}'
                       AND NOT t.q ~ '${PROCESSED_RX}' THEN 0.22 ELSE 0 END
           - CASE WHEN $7::boolean AND public.fold_text(p.name) ~ '${FORM_RX}'
                       AND NOT t.q ~ '${FORM_RX}' THEN 0.22 ELSE 0 END
           - CASE WHEN t.q ~ '${VARIANT_RX}'
                       AND public.fold_text(p.name) ~ '${VARIANT_RX}'
                       AND substring(t.q from '${VARIANT_RX}')
                           IS DISTINCT FROM substring(public.fold_text(p.name) from '${VARIANT_RX}')
                  THEN 0.50 ELSE 0 END AS score
    FROM catalog.products p
    CROSS JOIN terms t
    LEFT JOIN catalog.name_canonical nc
      ON nc.name_search = public.fold_text(p.name)
    WHERE p.chain_id = ANY($2) AND p.available
      AND (t.q <% p.name OR p.name % t.q)
  ) s GROUP BY chain_id, sku_id
),
query_vector AS (
  SELECT embedding FROM catalog.ingredient_lexicon
  WHERE embedding IS NOT NULL AND (item_normalised = $8 OR $8 = ANY(aliases))
  LIMIT 1
),
semantic AS (
  SELECT target.chain_id, neighbour.sku_id, neighbour.score
  FROM unnest($2::text[]) AS target(chain_id)
  CROSS JOIN query_vector qv
  CROSS JOIN LATERAL (
    SELECT pe.sku_id, 1 - (pe.embedding <=> qv.embedding) AS score
    FROM catalog.product_embeddings pe
    JOIN catalog.products p ON p.chain_id = pe.chain_id AND p.sku_id = pe.sku_id
    WHERE pe.chain_id = target.chain_id AND p.available
    ORDER BY pe.embedding <=> qv.embedding
    LIMIT $3
  ) neighbour
),
ranked AS (
  SELECT chain_id, sku_id, score, source, rn FROM (
    SELECT c.chain_id, c.chosen_sku_id AS sku_id, 1.0::float AS score, 'correction' AS source,
           1 AS rn
    FROM corrections c
    UNION ALL
    SELECT h.chain_id, h.sku_id, 0.95 - (h.rank - 1) * 0.02, 'lexicon',
           row_number() OVER (PARTITION BY h.chain_id ORDER BY h.rank)
    FROM hints h
    UNION ALL
    SELECT f.chain_id, f.sku_id, f.score, 'trgm',
           row_number() OVER (PARTITION BY f.chain_id ORDER BY f.score DESC, f.price_cents ASC)
    FROM fuzzy f
    UNION ALL
    SELECT s.chain_id, s.sku_id, s.score, 'semantic',
           row_number() OVER (PARTITION BY s.chain_id ORDER BY s.score DESC)
    FROM semantic s
  ) u
  WHERE rn <= $3
)
SELECT DISTINCT ON (p.chain_id, p.sku_id)
       p.chain_id, p.sku_id, p.ean, p.name, p.brand, p.price_cents, p.promo_price_cents, p.promo,
       p.unit_price_cents_per_std, p.std_unit, p.pack_size_value, p.pack_size_unit,
       p.image_url, p.product_url, p.aisle_group_id,
       r.score AS confidence, r.source,
       public.fold_text(nc.display_name) AS canonical_name, nc.canonical_key, nc.is_organic,
       pi.head_term, pi.form AS intent_form, pi.aisle_group_id AS intent_aisle, pi.is_base
FROM ranked r
JOIN catalog.products p ON p.chain_id = r.chain_id AND p.sku_id = r.sku_id
LEFT JOIN catalog.name_canonical nc ON nc.name_search = public.fold_text(p.name)
LEFT JOIN catalog.product_intent pi ON pi.chain_id = p.chain_id AND pi.sku_id = p.sku_id
WHERE p.available
ORDER BY p.chain_id, p.sku_id,
         CASE r.source WHEN 'correction' THEN 0 WHEN 'lexicon' THEN 1 ELSE 2 END`;

const sourceRank = { ean: 0, correction: 0, lexicon: 1, trgm: 2, semantic: 2 }; // retrieval tiers compete on confidence

// One anchored search can merge a specific variant pool ("fuji appels") with
// its generic product pool ("appels"). Keep the entire merged candidate set
// available behind "Zie meer"; the UI itself shows only the first three until
// the user explicitly expands it.
export const PREVIEW_ALTERNATIVE_LIMIT = 64;

// ---- gezonde-default-keuze (owner 2026-07-07, "6x200ML bij Alles bij Jumbo") --
// De shortlist blijft compleet — dit stuurt alleen welke kandidaat de stille
// default (best) wordt: geen multipack/tray tenzij de query erom vraagt, en
// mét een benodigde hoeveelheid wint het pak dat daar qua maat bij past.

const MULTIPACK_RX = /\d+\s*[x×]\s*\d+/i;
const PACK_TO_BASE: Record<string, { f: number; u: string }> = {
  g: { f: 1, u: 'g' }, kg: { f: 1000, u: 'g' }, ml: { f: 1, u: 'ml' }, l: { f: 1000, u: 'ml' },
  st: { f: 1, u: 'st' }, stuk: { f: 1, u: 'st' }, stuks: { f: 1, u: 'st' },
};
const candidateBase = (c: MatchCandidate): { value: number; unit: string } | null => {
  if (c.pack_size_value === null || !c.pack_size_unit) return null;
  const m = PACK_TO_BASE[c.pack_size_unit];
  return m ? { value: Number(c.pack_size_value) * m.f, unit: m.u } : null;
};

/** Kies de default uit een (al op bron+confidence gesorteerde) shortlist.
 *  Kandidaten binnen 0.05 van de top met dezelfde bron gelden als gelijkwaardig;
 *  dáárbinnen: liever geen multipack, liever een pakmaat tussen 0,5× en 2× de
 *  benodigde hoeveelheid, dan de laagste eenheidsprijs. */
export function pickSaneBest(
  candidates: MatchCandidate[],
  opts: {
    wantsMultipack?: boolean;
    neededBase?: { value: number; unit: string } | null;
  } = {}
): MatchCandidate | null {
  const top = candidates[0] ?? null;
  if (!top || top.source === 'correction') return top; // eigen keuze is heilig

  const fitsNeeded = (c: MatchCandidate): boolean => {
    const need = opts.neededBase;
    if (!need || need.unit === 'st') return true; // zonder maat-eis past alles
    const base = candidateBase(c);
    if (!base || base.unit !== need.unit) return true; // onbekende maat: niet straffen
    return base.value >= need.value * 0.5 && base.value <= need.value * 2;
  };
  const isMultipack = (c: MatchCandidate) => !opts.wantsMultipack && MULTIPACK_RX.test(c.name);

  // alleen ingrijpen als de top écht scheef zit: multipack, verkeerde maat, of
  // een top die níét "het product zelf" is terwijl die er wél tussen staan
  // ("Roomboter kano's" boven "Roomboter ongezouten", of een vergiftigde hint)
  const topNotPrimary = top.is_primary === false && candidates.some((c) => c.is_primary);
  if (!isMultipack(top) && fitsNeeded(top) && !topNotPrimary) return top;

  // een niet-primaire lexicon-hint mag door élke bron verslagen worden — anders
  // bevat de tier alleen hint-rijen en blijft de vergiftigde hint winnen
  const widen = topNotPrimary && top.source === 'lexicon';
  const tier = candidates.filter((c) =>
    widen
      ? c.source !== 'correction' && c.confidence >= top.confidence - 0.25
      : sourceRank[c.source] === sourceRank[top.source] &&
        c.confidence >= top.confidence - (topNotPrimary ? 0.15 : 0.05)
  );
  const scored = tier.map((c) => ({
    c,
    primary: c.is_primary === false ? 1 : 0,
    multipack: isMultipack(c) ? 1 : 0,
    fits: fitsNeeded(c) ? 0 : 1,
    unit: c.unit_price_cents_per_std ?? Number.MAX_SAFE_INTEGER,
  }));
  scored.sort(
    (a, b) =>
      a.primary - b.primary || a.multipack - b.multipack || a.fits - b.fits || a.unit - b.unit
  );
  return scored[0]?.c ?? top;
}

/** Match one normalised item across chains. */
export async function matchItem(
  item: string,
  chainIds: string[],
  userId: string | null,
  client?: Queryable
): Promise<Record<string, ChainMatch>> {
  const q = client ?? { query };
  const { term, aliases, aisleGroupId } = await resolveLexicon(item, client);
  // Dutch morphological aliases (plural/diminutive: uien, aardappelen) join the
  // search — "aardappel" alone loses the whole-word boost against products named
  // "…aardappelen", letting dish names win. Translations ("onion") stay out:
  // they'd surface "AH Onion rings" for "ui". (UX-audit matching pass)
  const morphAliases = aliases.filter((a) => a.includes(term) || term.includes(a));
  const searchTerms = [...new Set([item, term, ...morphAliases])].slice(0, 6);
  const freshProduce = aisleGroupId === 1; // groente & fruit → FORM_RX-penalty aan
  const r = await q.query(CANDIDATE_SQL, [searchTerms, chainIds, SHORTLIST_SIZE, userId, [item], aliases, freshProduce, term]);

  // "het product zelf" herkennen (owner 2026-07-07 avond, "roomboter vóór
  // croissants"). NB: de AI-canonieken zijn ontmerkte productnamen, geen
  // kop-labels ("Spar kaastengel roomboter" → "kaastengel roomboter") — dus
  // twee betrouwbare signalen i.p.v. kop-matching:
  //   1. canoniek exact gelijk aan de term/alias → zéker het product;
  //   2. naam óf canoniek draagt een samengesteld-woord (gebak/gerecht/vorm)
  //      dat de query zelf niet noemt → zéker NIET het product. Suffix-match
  //      vangt ook samenstellingen: boterhamZAKJES, eiercakEJES, roomIJS.
  // Geldt óók voor lexicon-hints: een vergiftigde hint verliest zo zijn voorrang.
  const aliasSet = [...new Set([...searchTerms, ...aliases.map((a) => a.toLowerCase())])];
  const queryIsComposite = aliasSet.some((a) => COMPOSITE_RX.test(a));
  const queryNamesForm = aliasSet.some((a) => FORM_WORDS_JS.test(a) || /\bdiepvries\b/.test(a));
  /** matcht een AI-head_term tegen de zoektermen: exact, of kop-uitbreiding
   *  ("volle melk" bij query "melk"). Plurals/varianten komen al uit het
   *  gecureerde lexicon (aliasSet bevat "appels" naast "appel") — een generieke
   *  prefix/lengte-fuzzy of pluralis-stam-heuristiek is NIET veilig gebleken:
   *  "appel" matchte zo "appelsap" (owner-bug 2026-07-08, live gevonden via
   *  substitution-eval.mjs), en NL-onregelmatige meervouden (boon/bonen) maken
   *  generieke suffix-stripping riskant. Restgevallen (bv. "gele ui" vs "gele
   *  uien" als het lexicon die exacte frase niet als alias kent) horen bij het
   *  lexicon opgelost te worden, niet bij een fuzzy regel hier. */
  const headMatches = (head: string): boolean =>
    aliasSet.some((a) => head === a || head.endsWith(` ${a}`) || a.endsWith(` ${head}`));
  const primaryOf = (
    name: string,
    canonical: string | null | undefined,
    source: MatchCandidate['source'],
    confidence: number,
    headTerm?: string | null,
    intentForm?: string | null,
    isBase?: boolean | null
  ): boolean => {
    if (source === 'correction') return true; // eigen keuze is heilig
    // AI-intent (0025) is de waarheid als die er is: head_term zegt wat het
    // product ÍS, form demoteert conserven bij vers-zoekopdrachten
    // (sperziebonen-blik zakt onder de verse zak), is_base filtert kant-en-
    // klare/samengestelde treffers wier head toevallig op de term eindigt
    // ("Cup-a-Soup Tomaat", "Romige Tomaat"-saus, "Rode kool met appel" —
    // owner-bug 2026-07-08, live gevonden via substitution-eval.mjs)
    const head = headTerm?.trim().toLowerCase();
    if (head) {
      if (!headMatches(head)) return false;
      if (isBase === false) return false;
      if (!queryIsComposite && COMPOSITE_RX.test(head)) return false;
      // koppel-koppen zijn een méngsel, geen kop-uitbreiding: "doperwten en
      // wortelen" eindigt op " wortelen" maar ís geen wortelen. Zoek je de mix
      // zelf, dan staat die als alias in de set en blijft hij primair.
      if (!aliasSet.includes(head) && /\b(en|met)\b|[&,]/.test(head)) return false;
      if (freshProduce && !queryNamesForm) {
        if (intentForm === 'blik' || intentForm === 'pot' || intentForm === 'gedroogd') return false;
        // vangnet voor gelogen intent-forms ('vers' op een pot): het vorm-woord
        // in de naam demoteert óók — "sperziebonen" toont heel vóór gebroken
        if (FORM_WORDS_JS.test(foldJs(name))) return false;
      }
      return true;
    }
    const canon = canonical?.trim() ?? '';
    if (canon && aliasSet.includes(canon)) return true;
    if (!queryIsComposite && (COMPOSITE_RX.test(foldJs(name)) || (canon && COMPOSITE_RX.test(canon)))) return false;
    if (canon) {
      // restwoord-net: een canoniek woord dat geen alias, geen kwaliteits-
      // bijvoeglijk naamwoord en geen marker is, is de kop van een ánder
      // product ("roomboter KAASKANTJES", "KRAKELINGEN roomboter")
      const leftover = canon.split(' ').some(
        (w) =>
          /^[a-z]{4,}$/.test(w) &&
          !ADJ_WORDS.has(w) &&
          !COMPOSITE_RX.test(w) &&
          !aliasSet.some((a) => a === w || a.split(' ').includes(w))
      );
      if (!queryIsComposite && leftover) return false;
      if (aliasSet.some((a) => new RegExp(`(^|\\s)${escRx(a)}($|\\s)`).test(canon))) return true;
    }
    if (source === 'lexicon') return true;
    return confidence >= SHORTLIST_THRESHOLD;
  };

  const byChain: Record<string, MatchCandidate[]> = {};
  for (const row of r.rows as (MatchCandidate & { confidence: string | number; canonical_name?: string | null })[]) {
    const raw = Number(row.confidence);
    // trgm raw scores are boost-stacked (0..~2); map to a 0..0.90 confidence
    const confidence = row.source === 'trgm' ? Math.min(0.9, raw * 0.5) : raw;
    const candidate = { ...row, confidence, rawScore: raw } as MatchCandidate & { rawScore: number };
    candidate.is_primary = primaryOf(
      row.name,
      row.canonical_name,
      row.source,
      confidence,
      row.head_term,
      row.intent_form,
      row.is_base
    );
    (byChain[candidate.chain_id] ??= []).push(candidate);
  }

  const wantsMultipack = MULTIPACK_RX.test(item);

  const result: Record<string, ChainMatch> = {};
  for (const chainId of chainIds) {
    const candidates = (byChain[chainId] ?? []).sort(
      (a, b) => sourceRank[a.source] - sourceRank[b.source] || b.confidence - a.confidence
    );
    result[chainId] = {
      best: pickSaneBest(candidates, { wantsMultipack }),
      shortlist: candidates.slice(0, SHORTLIST_SIZE),
    };
  }
  return result;
}
