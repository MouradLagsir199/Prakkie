import { normaliseIngredient, normaliseUnit, parsePackSizeText, reconcilePackSize } from '@prakkie/matching';
import type { PoolClient } from 'pg';
import { query } from './db';
import {
  PREVIEW_ALTERNATIVE_LIMIT,
  matchItem,
  resolveLexicon,
  type ChainMatch,
  type MatchCandidate,
} from './match';
import {
  MATCHER_VERSION,
  MATCH_POLICIES,
  assessCandidate,
  type CalibrationRule,
  type MatchAnchor,
  type MatchDecision,
  type MatchPolicy,
} from './match-policy';

/**
 * WS5 pricing core: list generation from recipes (G1/G2), per-chain list
 * pricing with pack-size reconciliation (G7/E3), basket comparison (F2) and
 * deals (F3). All money in integer cents; no fake totals — unmatched items are
 * reported, never silently priced.
 */

export interface GeneratedLine {
  name: string;
  quantity: number | null;
  unit: string | null;
  item_normalised: string;
  aisle_group_id: number | null;
  provenance: { recipe_id: string; title: string; servings: number; quantity: number | null; unit: string | null }[];
}

interface RecipeRow {
  id: string;
  title: string;
  servings_base: number;
  ingredients: { raw_text?: string; quantity?: number | null; unit?: string | null; item_normalised?: string | null }[];
}

/** Scale + normalise + merge the ingredients of the given recipes into list lines. */
export async function generateLines(
  recipes: { recipe_id: string; servings: number }[],
  userId: string
): Promise<GeneratedLine[]> {
  const ids = recipes.map((r) => r.recipe_id);
  const rows = await query<RecipeRow>(
    `SELECT id, title, servings_base, ingredients FROM app.recipes
     WHERE id = ANY($2) AND deleted_at IS NULL AND (owner_id = $1 OR household_id IN (
       SELECT household_id FROM app.household_members WHERE user_id = $1))`,
    [userId, ids]
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  const merged = new Map<string, GeneratedLine>();
  for (const { recipe_id, servings } of recipes) {
    const recipe = byId.get(recipe_id);
    if (!recipe) continue;
    const factor = servings / (recipe.servings_base || 1);
    for (const ing of recipe.ingredients ?? []) {
      const norm = normaliseIngredient(ing.raw_text ?? ing.item_normalised ?? '');
      const item = ing.item_normalised || norm.item;
      if (!item) continue;
      const { term, aisleGroupId } = await resolveLexicon(item);
      const qty = (ing.quantity ?? norm.quantity) !== null ? (ing.quantity ?? norm.quantity)! * factor : null;
      const unit = ing.unit ?? norm.unit;

      const existing = merged.get(term);
      const prov = { recipe_id, title: recipe.title, servings, quantity: qty, unit };
      if (!existing) {
        merged.set(term, {
          name: term,
          quantity: qty,
          unit,
          item_normalised: term,
          aisle_group_id: aisleGroupId,
          provenance: [prov],
        });
        continue;
      }
      existing.provenance.push(prov);
      // merge quantities when both convert to the same base unit (G2)
      if (existing.quantity !== null && qty !== null && existing.unit && unit) {
        const a = normaliseUnit(existing.unit, existing.quantity);
        const b = normaliseUnit(unit, qty);
        if (a && b && a.unit === b.unit) {
          existing.quantity = a.value + b.value;
          existing.unit = a.unit === 'st' ? 'stuks' : a.unit;
          continue;
        }
      }
      if (existing.unit === unit && existing.quantity !== null && qty !== null) {
        existing.quantity += qty;
      } else if (qty !== null && existing.quantity === null) {
        existing.quantity = qty;
        existing.unit = unit;
      } // incompatible units: keep first, provenance still records both
    }
  }
  return [...merged.values()];
}

export interface PricedLine {
  item_id: string;
  name: string;
  matched: boolean;
  suggested?: boolean;
  sku_id?: string;
  product_name?: string;
  confidence?: number;
  reliability?: number;
  decision?: MatchDecision;
  reasons?: string[];
  match_origin?: 'automatic' | 'bulk_accepted' | 'user_confirmed';
  matcher_version?: string;
  needs_review?: boolean;
  packs?: number;
  fits_exactly?: boolean;
  line_price_cents?: number;
  fractional_cents?: number;
  promo?: unknown;
  promo_savings_cents?: number;
  /** Category-safe catalog search scope for the manual alternative picker. */
  category_aisle_id?: number | null;
  /** Broader, anchor-aware choices for explicit review. Populated only by the
   * substitution-preview endpoint; these never participate in auto-accept. */
  alternatives?: PricedAlternative[];
}

export interface PricedAlternative {
  chain_id: string;
  sku_id: string;
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
  confidence: number;
  source: MatchCandidate['source'];
  is_primary: boolean;
  decision: Exclude<MatchDecision, 'unavailable'>;
  reliability: number;
  reasons: string[];
  hard_compatible: boolean;
  /** True for the candidate currently proposed on the preview line. */
  suggested: boolean;
  /** Quantity-aware basket cost, used to rank the value policy honestly. */
  line_price_cents: number;
  /** Stepper-advies: zoveel stuks van dit pak dekken de hoeveelheid van het
   * origineel (800 g origineel ÷ 200 g pak → 4). Null zonder vergelijkbare
   * pakmaten of bij regels met een expliciete eenheid. */
  suggested_qty: number | null;
}

export interface ChainPricing {
  chain_id: string;
  total_cents: number;
  fractional_total_cents: number;
  promo_savings_cents: number;
  matched: number;
  review: number;
  unmatched: string[];
  full_assortment: boolean;
  staleness: string | null; // "prijzen van {date}" source timestamp
  lines: PricedLine[];
}

export interface ChainPolicyPreview extends ChainPricing {
  accepted: number;
  unavailable: number;
  accepted_total_cents: number;
}

export type ShoppingSessionPricing = Record<MatchPolicy, ChainPolicyPreview[]>;

export interface ShoppingSessionPayload {
  list_id: string;
  matcher_version: string;
  /** `policies.precise` is intentionally the single source for base pricing
   * and the Nauwkeurig preview, preventing a large duplicate JSON payload. */
  pricing_policy: 'precise';
  policies: ShoppingSessionPricing;
}

interface ListItemRow {
  id: string;
  name: string;
  quantity: string | null;
  unit: string | null;
  item_normalised: string | null;
  matches: Record<string, {
    sku_id: string;
    confidence: number;
    user_pinned?: boolean;
    preferred?: boolean;
    origin?: 'automatic' | 'bulk_accepted' | 'user_confirmed';
    policy?: MatchPolicy;
  }>;
}

interface ChainRow {
  id: string;
  full_assortment: boolean;
  enabled: boolean;
  last_ingest_at: string | null;
}

interface ResolvedMatch {
  sku_id: string;
  confidence: number;
  source?: MatchCandidate['source'];
  user_pinned?: boolean;
  origin?: 'automatic' | 'bulk_accepted' | 'user_confirmed';
  decision?: MatchDecision;
  reliability?: number;
  reasons?: string[];
}

export interface PriceListOptions {
  policy?: MatchPolicy;
  /** Restrict pricing to these list-item IDs. `undefined` keeps the existing
   * full-list projection; an explicit empty array projects no items. */
  itemIds?: readonly string[];
  /** Include a wider, read-only pool for the manual review UI. Kept opt-in so
   * ordinary price/compare requests do not pay for extra retrieval queries. */
  includeAlternatives?: boolean;
  /** Request-scoped only. The shopping-session endpoint shares expensive
   * retrieval across policies, without retaining catalog data server-side. */
  retrievalCache?: PricingRetrievalCache;
}

/**
 * Promise-valued maps make the cache safe even if a caller projects policies
 * concurrently later. Failed lookups are evicted so a transient error is not
 * memoised for the rest of the request.
 */
export interface PricingRetrievalCache {
  items: Map<string, Promise<ListItemRow[]>>;
  chains: Map<string, Promise<ChainRow[]>>;
  calibration?: Promise<CalibrationRule[]>;
  anchors: Map<string, Promise<MatchAnchor | null>>;
  matches: Map<string, Promise<Record<string, ChainMatch>>>;
  exactEans: Map<string, Promise<MatchCandidate | null>>;
  hydratedProducts: Map<string, Promise<MatchCandidate[]>>;
}

export function createPricingRetrievalCache(): PricingRetrievalCache {
  return {
    items: new Map(),
    chains: new Map(),
    anchors: new Map(),
    matches: new Map(),
    exactEans: new Map(),
    hydratedProducts: new Map(),
  };
}

async function cached<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  load: () => Promise<V>
): Promise<V> {
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

function neededBase(item: Pick<ListItemRow, 'quantity' | 'unit'>): { value: number; unit: string } | null {
  if (item.quantity === null) return null;
  // kale aantallen ("2" zonder eenheid, de qty-stepper) zijn stuks: 2× het
  // product = 2× de (bonus)prijs — owner 2026-07-07
  if (!item.unit) return { value: Number(item.quantity) || 1, unit: 'st' };
  const canon = normaliseUnit(item.unit, Number(item.quantity));
  return canon ? { value: canon.value, unit: canon.unit } : null;
}

function packBase(p: Pick<MatchCandidate, 'pack_size_value' | 'pack_size_unit'>): { value: number; unit: string } | null {
  if (p.pack_size_value == null || !p.pack_size_unit) return null;
  const map: Record<string, { f: number; u: string }> = {
    g: { f: 1, u: 'g' }, kg: { f: 1000, u: 'g' }, ml: { f: 1, u: 'ml' }, l: { f: 1000, u: 'ml' },
    st: { f: 1, u: 'st' }, stuk: { f: 1, u: 'st' }, stuks: { f: 1, u: 'st' },
  };
  const m = map[p.pack_size_unit];
  return m ? { value: Number(p.pack_size_value) * m.f, unit: m.u } : null;
}

function activePromoPrice(p: MatchCandidate): number | null {
  if (p.promo_price_cents === null || p.promo_price_cents === undefined) return null;
  const promo = p.promo as { valid_to?: string } | null;
  if (promo?.valid_to && new Date(promo.valid_to) < new Date()) return null;
  return Number(p.promo_price_cents);
}

function candidateLinePrice(candidate: MatchCandidate, item: Pick<ListItemRow, 'quantity' | 'unit'>): number {
  const unitPrice = activePromoPrice(candidate) ?? Number(candidate.price_cents);
  const needed = neededBase(item);
  const pack = packBase(candidate);
  if (needed && pack && needed.unit === pack.unit) {
    return reconcilePackSize({ neededValue: needed.value, packValue: pack.value, packPriceCents: unitPrice }).totalPriceCents;
  }
  if (needed?.unit === 'st') return Math.max(1, Math.ceil(needed.value)) * unitPrice;
  return unitPrice;
}

// ---- maat & vorm in de picker (owner 2026-07-14, "Oude kaas L is geen
// Beemster 2 plaks") ---------------------------------------------------------
// Vorm-woorden die een ándere verschijningsvorm van hetzelfde levensmiddel
// markeren: kaas in plakken vervang je niet door een heel stuk of rasp. Eén
// groep per vorm; het eerste passende woord in de naam bepaalt de vorm.
const FORM_GROUPS: [string, RegExp][] = [
  ['plakken', /\bplak(?:ken|jes|s)?\b/],
  ['geraspt', /\bgeraspte?\b/],
  ['blokjes', /\bblokjes?\b/],
  ['stukjes', /\bstukjes?\b/],
  ['reepjes', /\breepjes?\b/],
  ['schijfjes', /\bschijfjes?\b/],
  ['sticks', /\bsticks?\b/],
  ['poeder', /\bpoeder\b/],
  ['vloeibaar', /\bvloeibaar\b/],
  ['stuk', /\bstuk\b|\bhele?\b/],
];
const formOf = (name: string | null | undefined): string | null =>
  FORM_GROUPS.find(([, rx]) => rx.test((name ?? '').toLowerCase()))?.[0] ?? null;

/** Pakinhoud in basiseenheden, ook zonder expliciete pack-size: dan afgeleid
 *  uit prijs ÷ eenheidsprijs — exact, want zo is de eenheidsprijs berekend.
 *  Veel catalogusrijen (m.n. AH) hebben alleen die eenheidsprijs. */
function knownOrDerivedBase(p: {
  name?: string | null;
  pack_size_value?: number | string | null;
  pack_size_unit?: string | null;
  price_cents?: number | string | null;
  unit_price_cents_per_std?: number | string | null;
  std_unit?: string | null;
}): { value: number; unit: string } | null {
  // The visible title is essential for multipacks. A catalog row may have no
  // explicit size (the current Jumbo feed), or may describe only one inner
  // unit; `2 x 180 g` is one purchasable 360 g package.
  const named = parsePackSizeText(p.name);
  if (named) return named;
  const direct = packBase({
    pack_size_value: p.pack_size_value == null ? null : Number(p.pack_size_value),
    pack_size_unit: p.pack_size_unit ?? null,
  });
  if (direct) return direct;
  const price = Number(p.price_cents);
  const unitPrice = Number(p.unit_price_cents_per_std);
  if (!p.std_unit || !Number.isFinite(price) || !Number.isFinite(unitPrice) || unitPrice <= 0 || price <= 0) return null;
  const stdToBase: Record<string, { f: number; u: string }> = {
    g: { f: 1, u: 'g' }, kg: { f: 1000, u: 'g' }, ml: { f: 1, u: 'ml' }, l: { f: 1000, u: 'ml' },
    st: { f: 1, u: 'st' }, stuk: { f: 1, u: 'st' }, stuks: { f: 1, u: 'st' },
  };
  const m = stdToBase[p.std_unit];
  if (!m) return null;
  return { value: (price / unitPrice) * m.f, unit: m.u };
}

const anchorPackBase = (anchor: MatchAnchor | null): { value: number; unit: string } | null =>
  anchor ? knownOrDerivedBase(anchor) : null;

/**
 * Hoe goed past een kandidaat bij het anker qua vorm en pakmaat? 0 = zelfde
 * vorm en (vrijwel) dezelfde inhoud; hoger = verder weg. Presentatie-ranking
 * voor de picker — beslist nooit mee over een automatische match. De sortering
 * vergelijkt hele tiers. Een exact pak wint altijd; daarna volgen bijna exact,
 * middelgrote en grote afwijkingen. Dat voorkomt dat een iets sterkere
 * tekstmatch van 600 g boven de aanwezige 800 g-variant komt voor een
 * 800 g-anker, zonder afrondingsruis van een paar procent te overwaarderen.
 */
export function substitutionFitCost(
  anchor: MatchAnchor | null,
  candidate: Pick<MatchCandidate, 'name' | 'pack_size_value' | 'pack_size_unit' | 'price_cents' | 'unit_price_cents_per_std' | 'std_unit'>
): number {
  if (!anchor) return 0;
  let cost = 0;
  // Retailers frequently classify prepared variants in separate shelves. Keep
  // explicit preparation/form cues from the source product above a generic
  // ingredient match (e.g. BBQ chicken skewers above plain chicken fillet).
  cost += variantCueCost(anchor, candidate);
  const anchorForm = formOf(anchor.name);
  const candidateForm = formOf(candidate.name);
  if (anchorForm && candidateForm && anchorForm !== candidateForm) cost += 4;
  else if (!!anchorForm !== !!candidateForm) cost += 1;
  const aBase = anchorPackBase(anchor);
  const cBase = knownOrDerivedBase(candidate);
  if (aBase && cBase) {
    if (aBase.unit !== cBase.unit) cost += 3; // gram vs milliliter vs stuks: onvergelijkbaar
    else {
      const relativeDifference = Math.abs(cBase.value - aBase.value) / aBase.value;
      if (relativeDifference > 0.03) {
        // Na Math.ceil in de picker worden dit afzonderlijke maattiers:
        // exact/afronding = 0, dichtbij = 1, merkbaar anders = 2, ver weg = 3.
        if (relativeDifference <= 0.125) cost += 0.5;
        else if (relativeDifference <= 0.30) cost += 1.5;
        else cost += 2.5;
      }
    }
  } else {
    cost += 0.75; // maat onbekend: gelijke tier als passend, maar nooit erboven
  }
  return cost;
}

// Keep explicit preparation/form cues ahead of the feed's `is_primary` flag.
// That flag reflects retrieval confidence, not whether a product is actually
// the same prepared variant (e.g. BBQ skewers versus plain chicken fillet).
const PREPARED_VARIANT_GROUPS = [
  /\b(?:bbq|barbecue|barbeque)\b/i,
  /\bspies(?:je|jes)?\b|\bsat[eé]\b/i,
  /\b(?:gemarineerd|gekruid)\b/i,
];

function variantCueCost(
  anchor: Pick<MatchAnchor, 'name'> | null,
  candidate: Pick<MatchCandidate, 'name'>
): number {
  if (!anchor) return 0;
  let cost = 0;
  for (const marker of PREPARED_VARIANT_GROUPS) {
    const anchorHas = marker.test(anchor.name ?? '');
    const candidateHas = marker.test(candidate.name ?? '');
    if (anchorHas && !candidateHas) cost += 4;
    else if (!anchorHas && candidateHas) cost += 1;
  }
  return cost;
}

/** Plain base products are not alternatives for an explicitly prepared
 * source product. At least one of the source's strong preparation cues must
 * survive (BBQ/barbecue, skewer/sate, marinated/seasoned). This is a hard
 * picker gate, not merely a score: a high-confidence plain chicken fillet can
 * therefore never reappear above BBQ chicken skewers. */
function sharesPreparedVariantCue(
  anchor: Pick<MatchAnchor, 'name'> | null,
  candidate: Pick<MatchCandidate, 'name'>
): boolean {
  if (!anchor) return true;
  const activeGroups = PREPARED_VARIANT_GROUPS.filter((marker) => marker.test(anchor.name ?? ''));
  return activeGroups.length === 0 || activeGroups.some((marker) => marker.test(candidate.name ?? ''));
}

/** Stable identity for visually duplicate catalog alternatives. */
const alternativeIdentity = (candidate: MatchCandidate): string =>
  [candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), candidate.pack_size_value ?? '', candidate.pack_size_unit ?? ''].join('|');

const normalisedGtin = (value: string | null | undefined): string | null =>
  value?.trim().replace(/^0+/, '') || null;

/** Manual alternatives must stay inside the anchor's known product category.
 * The intent aisle is almost fully populated and is more reliable than the
 * source-feed aisle (which is often null). An exact GTIN remains valid even
 * when category enrichment is missing or stale. */
function isSameProductCategory(anchor: MatchAnchor | null, candidate: MatchCandidate): boolean {
  if (!anchor) return true;
  const anchorGtin = normalisedGtin(anchor.ean);
  const candidateGtin = normalisedGtin(candidate.ean);
  if (anchorGtin && candidateGtin === anchorGtin) return true;
  if (anchor.intent_aisle == null) return true;
  const candidateAisle = candidate.intent_aisle ?? candidate.aisle_group_id;
  if (candidateAisle !== anchor.intent_aisle) return false;
  // A basic ingredient/product should not turn into a meal, snack or other
  // composed product merely because its name contains the same word. The
  // enrichment flag is noisy in the live catalog, though: identical product
  // families such as appelsap can be split across true/false. Same aisle plus
  // the exact same head term is therefore stronger evidence than that flag.
  if (anchor.is_base === true && candidate.is_base === false) {
    const family = (value: string | null | undefined) => (value ?? '')
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
    const anchorFamily = family(anchor.head_term ?? anchor.canonical_name);
    const candidateFamily = family(candidate.head_term ?? candidate.canonical_name);
    if (!anchorFamily || anchorFamily !== candidateFamily) return false;
  }
  return true;
}

/** A specific variant head can be too narrow cross-chain ("fuji appels" while
 * the other chain only labels products "appel"). Use the final product noun as
 * a retrieval fallback; category + base-product gates still decide what may be
 * shown. Compound heads deliberately stay intact. */
export function genericProductTerms(term: string): string[] {
  const folded = term.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  if (!folded || /\b(en|met)\b/.test(folded)) return [];
  const words = folded.split(/\s+/);
  const last = words.at(-1);
  const terms = words.length > 1 && last && last.length >= 3 ? [last] : [];
  if (/\b(?:bbq|barbecue|barbeque)\b/.test(folded)) terms.push('bbq', 'barbecue', 'barbeque');
  if (/\bspies(?:je|jes)?\b/.test(folded)) terms.push('spies', 'spiesje', 'spiesjes');
  if (/\b(?:sat[eé]|gemarineerd|gekruid)\b/.test(folded)) terms.push('sate', 'gemarineerd', 'gekruid');
  // Supermarkten benoemen hetzelfde platte brood anders. Een zoekanker
  // "Libanees brood" moet daarom ook Aldi's "flatbreads naturel" ophalen;
  // categorie/aisle- en base-productgates blijven daarna beslissen wat veilig
  // in de picker mag verschijnen.
  if (/\b(?:libanees brood|pita(?:brood)?|flatbreads?)\b/.test(folded)) {
    terms.push('flatbread', 'libanees brood', 'pitabrood');
  }
  return [...new Set(terms.filter((candidate) => candidate !== folded))];
}

/**
 * Turn the broad retrieval pool into a compact, policy-aware manual picker.
 * This is presentation ranking only: the returned order cannot alter the
 * automatic match stored in `ResolvedMatch`.
 */
export function rankPreviewAlternatives(
  candidates: MatchCandidate[],
  context: {
    anchor: MatchAnchor | null;
    policy: MatchPolicy;
    calibration?: CalibrationRule[];
    selectedSku?: string | null;
    quantity?: string | number | null;
    unit?: string | null;
    limit?: number;
  }
): PricedAlternative[] {
  const item = {
    quantity: context.quantity == null ? null : String(context.quantity),
    unit: context.unit ?? null,
  };
  const calibration = context.calibration ?? [];

  // Collapse duplicate catalog rows with the same visible product/pack. Prefer
  // the current suggestion, otherwise the stronger (then cheaper) candidate.
  const unique = new Map<string, MatchCandidate>();
  for (const candidate of candidates) {
    const key = alternativeIdentity(candidate);
    const previous = unique.get(key);
    const candidateSelected = candidate.sku_id === context.selectedSku;
    const previousSelected = previous?.sku_id === context.selectedSku;
    if (
      !previous ||
      (candidateSelected && !previousSelected) ||
      (candidateSelected === previousSelected && (
        candidate.confidence > previous.confidence ||
        (candidate.confidence === previous.confidence && candidateLinePrice(candidate, item) < candidateLinePrice(previous, item))
      ))
    ) {
      unique.set(key, candidate);
    }
  }

  const aBase = anchorPackBase(context.anchor);
  const comparable = [...unique.values()].filter((candidate) => {
    if (!isSameProductCategory(context.anchor, candidate)) return false;
    if (!sharesPreparedVariantCue(context.anchor, candidate)) return false;
    const cBase = knownOrDerivedBase(candidate);
    // A known mass cannot be replaced by a known volume (or vice versa) while
    // claiming an equivalent quantity. Piece-count versus weight is allowed:
    // fresh produce is legitimately sold both per piece and per kilo.
    const massVolumeConflict = aBase && cBase &&
      ((aBase.unit === 'g' && cBase.unit === 'ml') || (aBase.unit === 'ml' && cBase.unit === 'g'));
    return !massVolumeConflict;
  });

  const ranked = comparable.map((candidate) => {
    const assessment = assessCandidate(candidate, context.anchor, context.policy, calibration);
    return {
      chain_id: candidate.chain_id,
      sku_id: candidate.sku_id,
      name: candidate.name,
      brand: candidate.brand,
      price_cents: Number(candidate.price_cents),
      promo_price_cents: candidate.promo_price_cents == null ? null : Number(candidate.promo_price_cents),
      promo: candidate.promo,
      unit_price_cents_per_std: candidate.unit_price_cents_per_std == null ? null : Number(candidate.unit_price_cents_per_std),
      std_unit: candidate.std_unit,
      pack_size_value: candidate.pack_size_value == null ? null : Number(candidate.pack_size_value),
      pack_size_unit: candidate.pack_size_unit,
      image_url: candidate.image_url,
      product_url: candidate.product_url,
      confidence: Number(candidate.confidence),
      source: candidate.source,
      is_primary: candidate.is_primary !== false,
      decision: assessment.decision,
      reliability: assessment.reliability,
      reasons: assessment.reasons,
      hard_compatible: assessment.hard_compatible,
      suggested: candidate.sku_id === context.selectedSku,
      // Never propose extra packages in the picker. It starts from the list
      // quantity; only the user's stepper action may increase that number.
      line_price_cents: candidateLinePrice(candidate, item),
      suggested_qty: null,
    } satisfies PricedAlternative;
  });

  // maat/vorm-afstand tot het anker, per sku (alternatieven zijn één keten)
  const fitTier = new Map<string, number>();
  const variantTier = new Map<string, number>();
  for (const candidate of comparable) {
    fitTier.set(candidate.sku_id, Math.ceil(substitutionFitCost(context.anchor, candidate)));
    variantTier.set(candidate.sku_id, Math.ceil(variantCueCost(context.anchor, candidate)));
  }

  ranked.sort((a, b) => {
    const safe = Number(b.hard_compatible) - Number(a.hard_compatible);
    if (safe) return safe;
    // A prepared variant cue is more meaningful than retrieval primary-ness:
    // do not put plain chicken fillet above BBQ chicken skewers just because
    // the generic product has a slightly stronger text score.
    const variant = (variantTier.get(a.sku_id) ?? 0) - (variantTier.get(b.sku_id) ?? 0);
    if (variant) return variant;
    const primary = Number(b.is_primary) - Number(a.is_primary);
    if (primary) return primary;
    if (context.policy === 'value' && a.hard_compatible && b.hard_compatible) {
      return a.line_price_cents - b.line_price_cents || b.reliability - a.reliability || b.confidence - a.confidence;
    }
    return (
      (fitTier.get(a.sku_id) ?? 0) - (fitTier.get(b.sku_id) ?? 0) ||
      Number(b.suggested) - Number(a.suggested) ||
      Number(b.decision === 'accepted') - Number(a.decision === 'accepted') ||
      b.reliability - a.reliability ||
      b.confidence - a.confidence ||
      a.line_price_cents - b.line_price_cents
    );
  });

  return ranked.slice(0, context.limit ?? PREVIEW_ALTERNATIVE_LIMIT);
}

/** Price one list across chains without persisting automatic matcher guesses. */
export async function priceList(
  listId: string,
  chainIds: string[],
  userId: string,
  options: PriceListOptions = {},
  client?: Pick<PoolClient, 'query'>
): Promise<ChainPricing[]> {
  const q = client ?? { query };
  const policy = options.policy ?? 'precise';
  const retrievalCache = options.retrievalCache;
  const itemIds = options.itemIds === undefined
    ? undefined
    : [...new Set(options.itemIds)].sort();
  const itemCacheKey = itemIds === undefined
    ? `${listId}:*`
    : `${listId}:${itemIds.join(',')}`;
  const loadItems = async (): Promise<ListItemRow[]> => (
    await q.query(
      `SELECT i.id, i.name, i.quantity, i.unit, i.item_normalised, i.matches
       FROM app.list_items i WHERE i.list_id = $1 AND i.deleted_at IS NULL AND i.checked = false${
         itemIds === undefined ? '' : ' AND i.id = ANY($2::uuid[])'
       }`,
      itemIds === undefined ? [listId] : [listId, itemIds]
    )
  ).rows as ListItemRow[];
  const items = retrievalCache
    ? await cached(retrievalCache.items, itemCacheKey, loadItems)
    : await loadItems();

  const chainCacheKey = [...new Set(chainIds)].sort().join('\u0000');
  const loadChains = async (): Promise<ChainRow[]> => (
    await q.query(
      `SELECT id, full_assortment, enabled, last_ingest_at FROM catalog.chains WHERE id = ANY($1)`,
      [chainIds]
    )
  ).rows as ChainRow[];
  const chains = retrievalCache
    ? await cached(retrievalCache.chains, chainCacheKey, loadChains)
    : await loadChains();
  const enabledChains = chains.filter((c) => c.enabled);
  const loadCalibration = async (): Promise<CalibrationRule[]> => {
    try {
      const cr = await q.query(
        `SELECT policy, source, min_score, measured_precision, sample_size
         FROM catalog.match_policy_calibration WHERE matcher_version = $1 AND enabled`,
        [MATCHER_VERSION]
      );
      return cr.rows.map((row) => ({
        policy: row.policy as MatchPolicy,
        source: row.source as CalibrationRule['source'],
        min_score: Number(row.min_score),
        measured_precision: row.measured_precision == null ? null : Number(row.measured_precision),
        sample_size: Number(row.sample_size),
      }));
    } catch {
      // Rolling deploy: conservative in-code defaults work before the migration lands.
      return [];
    }
  };
  let calibration: CalibrationRule[];
  if (retrievalCache) {
    retrievalCache.calibration ??= loadCalibration();
    calibration = await retrievalCache.calibration;
  } else {
    calibration = await loadCalibration();
  }

  // resolve matches (batched; reuse stored ones, match the rest in parallel-ish)
  const skuNeeds = new Map<string, Set<string>>(); // chain → skus to hydrate
  const itemMatches = new Map<string, Map<string, ResolvedMatch>>();
  const itemAnchors = new Map<string, MatchAnchor | null>();
  for (const item of items) {
    const map = new Map<string, ResolvedMatch>();
    for (const [chain, m] of Object.entries(item.matches ?? {})) {
      // Old pricing GETs persisted unconfirmed automatic guesses. Ignore those
      // so every preview is recomputed under the requested policy. Explicit
      // manual choices and a previously accepted bulk conversion remain stable.
      const origin = m.origin ?? (m.user_pinned ? 'user_confirmed' : 'automatic');
      if (m?.sku_id && (m.user_pinned || origin === 'bulk_accepted' || origin === 'user_confirmed')) {
        map.set(chain, { ...m, origin });
      }
    }
    itemMatches.set(item.id, map);
  }

  const candidateCache = new Map<string, MatchCandidate>(); // `${chain}:${sku}` → product
  const alternativeCandidates = new Map<string, MatchCandidate[]>(); // `${item}:${chain}` → manual review pool
  for (const item of items) {
    const have = itemMatches.get(item.id)!;
    const missing = enabledChains.map((c) => c.id).filter((c) => !have.has(c));
    if (missing.length) {
      // verankerde substitutie, EAN-only (owner 2026-07-14): het door de user
      // gekózen product bepaalt wat "hetzelfde" is bij een andere keten, en
      // "hetzelfde" bestaat alléén als exact dezelfde EAN/GTIN (0032-index,
      // gevuld door de OFF-verrijkingsjob). Geen naam-, foto- of AI-gelijkenis
      // meer als automatisch substituut — zonder EAN-treffer is het eerlijk
      // "geen match" en kiest de user zelf uit de term-shortlist.
      const pinned = Object.entries(item.matches ?? {}).filter(([, m]) => m?.user_pinned && m.sku_id);
      const anchorEntry =
        pinned.find(([, m]) => (m as { preferred?: boolean }).preferred) ?? pinned[0] ?? null;
      let anchor: MatchAnchor | null = null;
      if (anchorEntry) {
        const loadAnchor = async (): Promise<MatchAnchor | null> => {
          const ar = await q.query(
            `SELECT p.chain_id, p.sku_id, p.name, p.ean, p.brand, p.pack_size_value, p.pack_size_unit,
                    p.price_cents, p.unit_price_cents_per_std, p.std_unit,
                    nc.display_name AS canonical_name, nc.canonical_key, nc.is_organic,
                    pi.head_term, pi.form AS intent_form, pi.aisle_group_id AS intent_aisle,
                    pi.is_base
             FROM catalog.products p
             LEFT JOIN catalog.name_canonical nc ON nc.name_search = public.fold_text(p.name)
             LEFT JOIN catalog.product_intent pi ON pi.chain_id = p.chain_id AND pi.sku_id = p.sku_id
             WHERE p.chain_id = $1 AND p.sku_id = $2`,
            [anchorEntry[0], anchorEntry[1].sku_id]
          );
          return (ar.rows[0] as MatchAnchor | undefined) ?? null;
        };
        anchor = retrievalCache
          ? await cached(retrievalCache.anchors, `${listId}:${item.id}`, loadAnchor)
          : await loadAnchor();
      }
      itemAnchors.set(item.id, anchor);
      // AI-head van het anker (0025) is de schoonste zoekterm ("stokbrood", geen
      // ontmerkte naam vol bijwoorden); canonical blijft de fallback. Mét anker
      // voedt de term-shortlist alleen nog de handmatige picker — automatische
      // substitutie is EAN-only en heeft geen termen nodig.
      const term = anchor?.head_term || anchor?.canonical_name || item.item_normalised || normaliseIngredient(item.name).item;
      // A normal price/compare request has no use for name candidates: since
      // policy-v2-ean they can never become an automatic match. Fetch them
      // only for the explicit manual-alternatives preview. This keeps an
      // uncomposed recipe list O(items + exact EAN lookups), rather than doing
      // an expensive term search for every item × chain.
      const needTermMatches = options.includeAlternatives === true;
      const loadMatches = () => matchItem(term, missing, userId, client);
      let result: Record<string, ChainMatch> = needTermMatches
        ? retrievalCache
          ? await cached(
              retrievalCache.matches,
              `${listId}:${item.id}:${[...missing].sort().join(',')}`,
              loadMatches
            )
          : await loadMatches()
        : {};
      // Variant/cultivar names can retrieve only a small specific pool. Always
      // add the generic product noun for the manual picker: "Zie meer" must
      // expose the full valid pool, not merely one fourth result after the
      // first three cards. Category gates below still remove unrelated goods.
      // Keep product-form cues from the actual chosen SKU as well as the
      // curated head term. A head such as "kipfilet" drops important cues in
      // names like "BBQ kipfilet spies", which otherwise makes plain chicken
      // fillet outrank the BBQ/skewer family at another chain.
      const fallbackTerms = anchor
        ? [...new Set([...genericProductTerms(term), ...genericProductTerms(anchor.name ?? '')])]
        : [];
      const fallbackChains = anchor && fallbackTerms.length && options.includeAlternatives ? missing : [];
      for (const fallbackTerm of fallbackTerms) {
        if (!fallbackChains.length) break;
        const loadFallbackMatches = () => matchItem(fallbackTerm, fallbackChains, userId, client);
        const fallbackResult = retrievalCache
          ? await cached(
              retrievalCache.matches,
              `${listId}:${item.id}:${[...fallbackChains].sort().join(',')}:fallback:${fallbackTerm}`,
              loadFallbackMatches
            )
          : await loadFallbackMatches();
        for (const chain of fallbackChains) {
          const primary = result[chain]?.shortlist ?? [];
          const fallback = fallbackResult[chain]?.shortlist ?? [];
          const seen = new Set<string>();
          const merged = [...primary, ...fallback].filter((candidate) => {
            if (seen.has(candidate.sku_id)) return false;
            seen.add(candidate.sku_id);
            return true;
          });
          result[chain] = {
            best: result[chain]?.best ?? fallbackResult[chain]?.best ?? null,
            shortlist: merged,
          };
        }
      }
      for (const chain of missing) {
        const shortlist = result[chain]?.shortlist ?? [];
        const rememberAlternatives = async (selected?: MatchCandidate): Promise<void> => {
          if (!options.includeAlternatives) return;
          // Preserve exact-EAN/correction provenance for the proposed SKU;
          // the term shortlist may also have retrieved it as trgm/semantic.
          const alternatives = selected
            ? [selected, ...shortlist.filter((candidate) => candidate.sku_id !== selected.sku_id)]
            : shortlist;
          alternativeCandidates.set(`${item.id}:${chain}`, alternatives);
        };

        // Exact trade-item identity is the only automatic cross-chain tier.
        if (anchor?.ean) {
          const loadExactEan = async (): Promise<MatchCandidate | null> => {
            const exact = await q.query(
              `SELECT p.chain_id, p.sku_id, p.ean, p.name, p.brand, p.price_cents,
                      p.promo_price_cents, p.promo, p.unit_price_cents_per_std, p.std_unit,
                      p.pack_size_value, p.pack_size_unit, p.image_url, p.product_url,
                      p.aisle_group_id, nc.display_name AS canonical_name, nc.canonical_key,
                      nc.is_organic, pi.head_term, pi.form AS intent_form,
                      pi.aisle_group_id AS intent_aisle, pi.is_base
               FROM catalog.products p
               LEFT JOIN catalog.name_canonical nc ON nc.name_search = public.fold_text(p.name)
               LEFT JOIN catalog.product_intent pi ON pi.chain_id = p.chain_id AND pi.sku_id = p.sku_id
               WHERE p.chain_id = $1
                 AND NULLIF(ltrim(p.ean, '0'), '') = NULLIF(ltrim($2, '0'), '')
                 AND p.available
               ORDER BY p.price_cents ASC LIMIT 1`,
              [chain, anchor!.ean]
            );
            const candidate = exact.rows[0] as MatchCandidate | undefined;
            return candidate
              ? { ...candidate, confidence: 0.999, source: 'ean', is_primary: true }
              : null;
          };
          const eanCandidate = retrievalCache
            ? await cached(
                retrievalCache.exactEans,
                `${listId}:${item.id}:${chain}`,
                loadExactEan
              )
            : await loadExactEan();
          if (eanCandidate) {
            const assessment = assessCandidate(eanCandidate, anchor, policy, calibration);
            have.set(chain, {
              sku_id: eanCandidate.sku_id,
              confidence: eanCandidate.confidence,
              source: eanCandidate.source,
              origin: 'automatic',
              ...assessment,
            });
            candidateCache.set(`${chain}:${eanCandidate.sku_id}`, eanCandidate);
            await rememberAlternatives(eanCandidate);
            continue;
          }
        }
        if (anchor) {
          // EAN-only: geen treffer op identiteit = eerlijk geen automatische
          // match; de term-shortlist blijft beschikbaar voor de picker.
          await rememberAlternatives();
          continue;
        }
        // Ook een kale receptregel zonder productanker wordt nooit stilletjes
        // op naam ingevuld. De shortlist is alleen de handmatige bladerhulp;
        // pas een expliciete userkeuze wordt een match. Zo is elke automatische
        // cross-supermarktkeuze aantoonbaar exacte EAN-identiteit.
        await rememberAlternatives();
      }
    }
    for (const [chain, m] of have) {
      if (!candidateCache.has(`${chain}:${m.sku_id}`)) {
        (skuNeeds.get(chain) ?? skuNeeds.set(chain, new Set()).get(chain)!).add(m.sku_id);
      }
    }
  }
  for (const [chain, skus] of skuNeeds) {
    const orderedSkus = [...skus].sort();
    const loadProducts = async (): Promise<MatchCandidate[]> => {
      const r = await q.query(
        `SELECT p.chain_id, p.sku_id, p.ean, p.name, p.brand, p.price_cents, p.promo_price_cents, p.promo,
                unit_price_cents_per_std, std_unit, pack_size_value, pack_size_unit,
                image_url, product_url, p.aisle_group_id, nc.display_name AS canonical_name,
                nc.canonical_key, nc.is_organic, pi.head_term, pi.form AS intent_form,
                pi.aisle_group_id AS intent_aisle, pi.is_base
         FROM catalog.products p
         LEFT JOIN catalog.name_canonical nc ON nc.name_search = public.fold_text(p.name)
         LEFT JOIN catalog.product_intent pi ON pi.chain_id = p.chain_id AND pi.sku_id = p.sku_id
         WHERE p.chain_id = $1 AND p.sku_id = ANY($2)`,
        [chain, orderedSkus]
      );
      return r.rows.map((row) => ({ ...row, confidence: 0, source: 'trgm' } as MatchCandidate));
    };
    const products = retrievalCache
      ? await cached(
          retrievalCache.hydratedProducts,
          `${chain}:${orderedSkus.join(',')}`,
          loadProducts
        )
      : await loadProducts();
    for (const product of products) {
      candidateCache.set(`${chain}:${product.sku_id}`, product);
    }
  }

  return enabledChains.map((chain) => {
    const lines: PricedLine[] = [];
    let total = 0;
    let fractional = 0;
    let savings = 0;
    let review = 0;
    const unmatched: string[] = [];
    for (const item of items) {
      const m = itemMatches.get(item.id)!.get(chain.id);
      const product = m ? candidateCache.get(`${chain.id}:${m.sku_id}`) : undefined;
      if (!m || !product) {
        unmatched.push(item.name);
        const candidates = alternativeCandidates.get(`${item.id}:${chain.id}`) ?? [];
        lines.push({
          item_id: item.id,
          name: item.name,
          category_aisle_id: itemAnchors.get(item.id)?.intent_aisle ?? null,
          matched: false,
          decision: 'unavailable',
          matcher_version: MATCHER_VERSION,
          alternatives: options.includeAlternatives
            ? rankPreviewAlternatives(candidates, {
                anchor: itemAnchors.get(item.id) ?? null,
                policy,
                calibration,
                quantity: item.quantity,
                unit: item.unit,
              })
            : undefined,
        });
        continue;
      }
      const explicit = m.user_pinned || m.origin === 'user_confirmed' || m.origin === 'bulk_accepted';
      const assessed = m.decision
        ? { decision: m.decision, reliability: m.reliability ?? m.confidence, reasons: m.reasons ?? [] }
        : explicit
          ? { decision: 'accepted' as const, reliability: 1, reasons: [m.origin === 'bulk_accepted' ? 'eerder als lijst geaccepteerd' : 'door jou gekozen'] }
          : assessCandidate(product, itemAnchors.get(item.id) ?? null, policy, calibration);
      const accepted = assessed.decision === 'accepted';
      const promoPrice = activePromoPrice(product);
      const unitPrice = promoPrice ?? Number(product.price_cents);
      const needed = neededBase(item);
      const pack = packBase(product);
      let packs = 1;
      let linePrice = unitPrice;
      let frac = unitPrice;
      let fits = false;
      if (needed && pack && needed.unit === pack.unit) {
        const fit = reconcilePackSize({ neededValue: needed.value, packValue: pack.value, packPriceCents: unitPrice });
        packs = fit.packsToBuy;
        linePrice = fit.totalPriceCents;
        frac = fit.fractionalCostCents;
        fits = fit.fitsExactly;
      } else if (needed && needed.unit === 'st') {
        packs = Math.max(1, Math.ceil(needed.value));
        linePrice = packs * unitPrice;
        frac = linePrice;
      }
      const lineSavings = promoPrice !== null ? packs * (Number(product.price_cents) - promoPrice) : 0;
      if (accepted) {
        total += linePrice;
        fractional += frac;
        savings += lineSavings;
      } else {
        review++;
        unmatched.push(item.name);
      }
      lines.push({
        item_id: item.id,
        name: item.name,
        category_aisle_id: itemAnchors.get(item.id)?.intent_aisle ?? null,
        matched: accepted,
        suggested: true,
        sku_id: product.sku_id,
        product_name: product.name,
        confidence: m.confidence,
        reliability: assessed.reliability,
        decision: assessed.decision,
        reasons: assessed.reasons,
        match_origin: m.origin ?? 'automatic',
        matcher_version: MATCHER_VERSION,
        needs_review: !accepted,
        packs,
        fits_exactly: fits,
        line_price_cents: linePrice,
        fractional_cents: frac,
        promo: promoPrice !== null ? product.promo : null,
        promo_savings_cents: lineSavings,
        alternatives: options.includeAlternatives
          ? rankPreviewAlternatives(
              alternativeCandidates.get(`${item.id}:${chain.id}`) ?? [product],
              {
                anchor: itemAnchors.get(item.id) ?? null,
                policy,
                calibration,
                selectedSku: product.sku_id,
                quantity: item.quantity,
                unit: item.unit,
              }
            )
          : undefined,
      });
    }
    return {
      chain_id: chain.id,
      total_cents: total,
      fractional_total_cents: fractional,
      promo_savings_cents: savings,
      matched: lines.filter((l) => l.matched).length,
      review,
      unmatched,
      full_assortment: chain.full_assortment,
      staleness: chain.last_ingest_at,
      lines,
    };
  });
}

/** Add the counters consumed by the policy tabs without changing line data. */
export function toPolicyPreview(chain: ChainPricing): ChainPolicyPreview {
  return {
    ...chain,
    accepted: chain.lines.filter((line) => line.decision === 'accepted').length,
    unavailable: chain.lines.filter((line) => line.decision === 'unavailable').length,
    accepted_total_cents: chain.total_cents,
  };
}

/**
 * Load all data needed for one Boodschappen session. Retrieval is deliberately
 * performed once per item/chain set and then projected through all policies.
 * The cache lives only for this call: reopening the app makes a fresh request
 * and therefore sees fresh list, catalog and promotion data.
 */
export async function priceShoppingSession(
  listId: string,
  chainIds: string[],
  userId: string,
  options: Pick<PriceListOptions, 'itemIds'> = {},
  client?: Pick<PoolClient, 'query'>
): Promise<ShoppingSessionPricing> {
  const retrievalCache = createPricingRetrievalCache();
  const policies = {} as ShoppingSessionPricing;
  // Sequential projection guarantees the first pass has populated the shared
  // Promise cache. Policy assessment/ranking is cheap and remains independent.
  for (const policy of MATCH_POLICIES) {
    const chains = await priceList(
      listId,
      chainIds,
      userId,
      { policy, itemIds: options.itemIds, includeAlternatives: true, retrievalCache },
      client
    );
    policies[policy] = chains.map(toPolicyPreview);
  }
  return policies;
}

export function buildShoppingSessionPayload(
  listId: string,
  policies: ShoppingSessionPricing
): ShoppingSessionPayload {
  return {
    list_id: listId,
    matcher_version: MATCHER_VERSION,
    pricing_policy: 'precise',
    policies,
  };
}
