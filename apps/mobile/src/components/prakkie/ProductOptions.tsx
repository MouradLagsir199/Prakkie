import { formatEuroCents } from '@prakkie/shared';
import { Image } from 'expo-image';
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { authedRequest } from '../../data/api';
import { colors, fonts, radius, type } from '../../theme/tokens';
import { ChainLogo } from './ChainLogo';

/**
 * The product dropdown (owner UX 2026-07-06): the app never decides for you —
 * every matching product for a term is listed with thumbnail + price, and the
 * user picks. Used per list item (Boodschappen) and per ingredient in the
 * recipe → lijst flow.
 */

export interface ProductOption {
  sku_id: string;
  name: string;
  brand?: string | null;
  price_cents: number;
  promo_price_cents?: number | null;
  /** Quantity-aware basket cost returned by the replacement preview. */
  line_price_cents?: number;
  image_url?: string | null;
  confidence?: number;
  reliability?: number;
  decision?: 'accepted' | 'review' | 'unavailable';
  /** herkomst van de match: eigen correctie > lexicon-hint > fuzzy/beeld */
  source?: 'ean' | 'correction' | 'lexicon' | 'trgm' | 'semantic';
  /** server: "het gezochte product zelf" (roomboter) vs samengesteld (croissant) */
  is_primary?: boolean;
  /** inhoud/gewicht — 300 g sandwichspread is geen 450 g */
  pack_size_value?: number | null;
  pack_size_unit?: string | null;
  unit_price_cents_per_std?: number | null;
  std_unit?: string | null;
  /** bonus-details uit de catalogus — mechanic ("2e halve prijs") voedt de
   *  oranje bonus-flag in de schap-bladeraar (owner 2026-07-10) */
  promo?: { type?: string | null; mechanic?: string | null } | null;
  /** Alleen bij afdelingsbreed zoeken: laat zien uit welk schap het resultaat komt. */
  category_name?: string | null;
  /** Catalog department, used to keep manual replacement search in-category. */
  department_slug?: string | null;
  /** Vervang-advies uit de picker-preview: zoveel stuks van dit pak dekken de
   *  hoeveelheid van het origineel (800 g origineel ÷ 200 g pak → 4). */
  suggested_qty?: number | null;
}

/** de tekst op de oranje bonus-flag: de mechanic als die er is, anders "Bonus" */
export function promoLabel(o: ProductOption): string | null {
  const onPromo = o.promo_price_cents != null && o.promo_price_cents < o.price_cents;
  if (!onPromo && !o.promo) return null;
  const mech = (o.promo?.mechanic ?? '').trim();
  return mech ? mech.slice(0, 28) : 'Bonus';
}

/** het gezochte product zelf eerst (owner 2026-07-07, "roomboter vóór
 *  croissants") — fallback op confidence voor responses zonder de vlag */
const primaryRank = (o: ProductOption) => ((o.is_primary ?? (o.confidence ?? 0) >= 0.72) ? 0 : 1);

/** 0,3 kg → "300 g"; 1,5 l → "1,5 l" */
function formatStdQty(qty: number, stdUnit: string): string {
  const small: Record<string, string> = { kg: 'g', l: 'ml' };
  if (qty < 1 && small[stdUnit]) {
    return `${Math.round((qty * 1000) / 5) * 5} ${small[stdUnit]}`;
  }
  const rounded = Math.round(qty * 100) / 100;
  return `${String(rounded).replace('.', ',')} ${stdUnit}`;
}

type VisiblePack = { label: string; baseUnit: 'g' | 'ml' | 'st'; baseValue: number };

/** Product titles are often more complete than feed metadata (notably Jumbo).
 * Keep display parsing aligned with the server matcher: the last explicit
 * amount wins and a multipack remains visibly a multipack. */
function visiblePackFromName(name: string): VisiblePack | null {
  const matches = [...name.matchAll(
    /\b(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kilo(?:gram)?|g|gr|gram|ml|cl|dl|l|liter|litre|stuks?|st)\b/gi
  )];
  const match = matches.at(-1);
  if (!match) return null;
  const multiplier = match[1] ? Number(match[1]) : 1;
  const amount = Number(match[2]!.replace(',', '.'));
  if (!Number.isFinite(multiplier) || !Number.isFinite(amount) || multiplier <= 0 || amount <= 0) return null;
  const raw = match[3]!.toLowerCase();
  const displayUnit = /^(?:kg|kilo|kilogram)$/.test(raw)
    ? 'kg'
    : /^(?:g|gr|gram)$/.test(raw)
      ? 'g'
      : /^(?:l|liter|litre)$/.test(raw)
        ? 'l'
        : ['ml', 'cl', 'dl'].includes(raw)
          ? raw
          : 'stuks';
  const baseUnit: VisiblePack['baseUnit'] = displayUnit === 'kg' || displayUnit === 'g'
    ? 'g'
    : ['l', 'ml', 'cl', 'dl'].includes(displayUnit)
      ? 'ml'
      : 'st';
  const factor = displayUnit === 'kg'
    ? 1000
    : displayUnit === 'l'
      ? 1000
      : displayUnit === 'cl'
        ? 10
        : displayUnit === 'dl'
          ? 100
          : 1;
  const amountLabel = String(amount).replace('.', ',');
  return {
    label: multiplier > 1 ? `${multiplier} × ${amountLabel} ${displayUnit}` : `${amountLabel} ${displayUnit}`,
    baseUnit,
    baseValue: multiplier * amount * factor,
  };
}

const unitFamily = (unit: string | null | undefined): VisiblePack['baseUnit'] | null => {
  const folded = (unit ?? '').toLowerCase();
  if (['kg', 'g', 'gr', 'gram'].includes(folded)) return 'g';
  if (['l', 'ml', 'cl', 'dl', 'liter', 'litre'].includes(folded)) return 'ml';
  if (['st', 'stuk', 'stuks'].includes(folded)) return 'st';
  return null;
};

/** Comparable contents for client-side presentation ranking. The server is
 * authoritative, but this keeps an exact-size option first while an older API
 * deployment is still serving a pre-fix order. */
export function productPackBase(o: Pick<
  ProductOption,
  'name' | 'pack_size_value' | 'pack_size_unit' | 'price_cents' | 'unit_price_cents_per_std' | 'std_unit'
>): { value: number; unit: VisiblePack['baseUnit'] } | null {
  const named = visiblePackFromName(o.name);
  if (named) return { value: named.baseValue, unit: named.baseUnit };
  if (o.pack_size_value != null && o.pack_size_unit) {
    const unit = unitFamily(o.pack_size_unit);
    if (unit) {
      const raw = o.pack_size_unit.toLowerCase();
      const factor = raw === 'kg' || raw === 'l' || raw === 'liter' || raw === 'litre'
        ? 1000
        : raw === 'cl'
          ? 10
          : raw === 'dl'
            ? 100
            : 1;
      return { value: Number(o.pack_size_value) * factor, unit };
    }
  }
  const unit = unitFamily(o.std_unit);
  const price = Number(o.price_cents);
  const unitPrice = Number(o.unit_price_cents_per_std);
  if (!unit || !Number.isFinite(price) || !Number.isFinite(unitPrice) || price <= 0 || unitPrice <= 0) return null;
  const factor = o.std_unit?.toLowerCase() === 'kg' || o.std_unit?.toLowerCase() === 'l' ? 1000 : 1;
  return { value: (price / unitPrice) * factor, unit };
}

const RECOMMENDATION_NOISE = new Set([
  'ah', 'albert', 'heijn', 'jumbo', 'aldi', 'plus', 'dirk', 'dekamarkt',
  'vomar', 'hoogvliet', 'spar', 'picnic', 'ekoplaza',
  'g', 'gr', 'gram', 'kg', 'kilo', 'ml', 'cl', 'dl', 'l', 'liter', 'litre',
  'st', 'stuk', 'stuks', 'x',
]);

function recommendationTokens(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !/^\d+(?:[.,]\d+)?$/.test(token) && !RECOMMENDATION_NOISE.has(token));
}

function recommendationTitleScore(anchorName: string, candidateName: string): number {
  const anchor = recommendationTokens(anchorName);
  const candidate = recommendationTokens(candidateName);
  if (!anchor.length || !candidate.length) return 0;
  const tokenFit = (wanted: string, available: string) => {
    if (wanted === available) return 1;
    if (wanted.length >= 4 && available.length >= 4 && (wanted.includes(available) || available.includes(wanted))) return 0.72;
    return 0;
  };
  const coverage = (wanted: string[], available: string[]) =>
    wanted.reduce((sum, token) => sum + Math.max(...available.map((other) => tokenFit(token, other))), 0) / wanted.length;
  // Het origineel bepaalt vooral wat niet verloren mag gaan (scharrel,
  // naturel, volkoren); kandidaatdekking voorkomt dat een lange irrelevante
  // titel op één toevallig woord wint.
  return coverage(anchor, candidate) * 0.72 + coverage(candidate, anchor) * 0.28;
}

function recommendationPackScore(
  anchor: ReturnType<typeof productPackBase>,
  candidate: ReturnType<typeof productPackBase>
): number {
  if (!anchor) return 0.45;
  if (!candidate) return 0.08;
  if (anchor.unit !== candidate.unit) return -0.6;
  const ratio = candidate.value / anchor.value;
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  // Exact dezelfde inhoud = 1. Een 600g-pak voor een 800g-anker zakt al
  // duidelijk, waardoor een aanwezige 800g-variant bovenaan komt.
  return Math.exp(-2.8 * Math.abs(Math.log(ratio)));
}

const PREPARED_RECOMMENDATION_CUES = [
  /\b(?:bbq|barbecue|barbeque)\b/i,
  /\bspies(?:je|jes)?\b|\bsat[eé]\b/i,
  /\b(?:gemarineerd|gekruid)\b/i,
];

export function hasPreparedRecommendationCue(name: string): boolean {
  return PREPARED_RECOMMENDATION_CUES.some((cue) => cue.test(name));
}

/** Keep the recommendation lane faithful to explicitly prepared products.
 * A source such as "BBQ kipfilet spies" must not silently degrade to plain
 * chicken just because the resolved retailer shelf is broad. Typed searches
 * remain unrestricted because at that point the user explicitly controls the
 * requested product. */
function preparedCueMatches(anchorName: string, candidateName: string): number | null {
  const active = PREPARED_RECOMMENDATION_CUES.filter((cue) => cue.test(anchorName));
  if (!active.length) return null;
  return active.filter((cue) => cue.test(candidateName)).length;
}

/** Sterke, uitlegbare rangschikking voor de handmatige alternatiefzoeker.
 * De categorie is al server-side veilig begrensd; binnen dat schap wegen de
 * semantische titel en vergelijkbare verpakkingsinhoud het zwaarst. */
export function rankRecommendedProducts(
  options: ProductOption[],
  opts: {
    anchor: Pick<ProductOption, 'name' | 'pack_size_value' | 'pack_size_unit' | 'price_cents' | 'unit_price_cents_per_std' | 'std_unit'>;
    query?: string;
    serverRankedSkus?: string[];
  }
): ProductOption[] {
  const targetName = opts.query?.trim() || opts.anchor.name;
  const anchorPack = productPackBase(opts.anchor);
  const serverRank = new Map((opts.serverRankedSkus ?? []).map((sku, index) => [sku, index]));
  return options
    .filter((option) => {
      if (opts.query?.trim()) return true;
      const cueMatches = preparedCueMatches(opts.anchor.name, option.name);
      return cueMatches == null || cueMatches > 0;
    })
    .map((option, index) => {
      const title = recommendationTitleScore(targetName, option.name);
      const pack = recommendationPackScore(anchorPack, productPackBase(option));
      const cueMatches = preparedCueMatches(opts.anchor.name, option.name) ?? 0;
      const knownRank = serverRank.get(option.sku_id);
      // De prijs-engine kent vorm/canonical-name al. Gebruik die als kleine
      // tie-breaker, nooit als vervanging van titel + hoeveelheid.
      const serverHint = opts.query?.trim() || knownRank == null
        ? 0
        : Math.max(0, 0.035 - knownRank * 0.004);
      return {
        option,
        index,
        score: title * 0.66 + pack * 0.34 + cueMatches * 0.4 + serverHint,
      };
    })
    .sort((a, b) =>
      b.score - a.score ||
      (a.option.promo_price_cents ?? a.option.price_cents) - (b.option.promo_price_cents ?? b.option.price_cents) ||
      a.index - b.index
    )
    .map(({ option }) => option);
}

/** "300 g · €3,30/kg" — inhoud + eenheidsprijs, voor eerlijke vergelijking.
 *  Zonder expliciete pack-size wordt de inhoud afgeleid uit de eenheidsprijs
 *  (prijs ÷ prijs-per-kg) — dat is exact, want zo is die prijs ook berekend. */
export function packLabel(o: ProductOption): string | null {
  const parts: string[] = [];
  const namedPack = visiblePackFromName(o.name);
  let visibleUnit: VisiblePack['baseUnit'] | null = null;
  if (namedPack) {
    parts.push(namedPack.label);
    visibleUnit = namedPack.baseUnit;
  } else if (o.pack_size_value != null && o.pack_size_unit) {
    parts.push(`${String(o.pack_size_value).replace('.', ',')} ${o.pack_size_unit}`);
    visibleUnit = unitFamily(o.pack_size_unit);
  } else if (o.unit_price_cents_per_std && o.std_unit && o.price_cents) {
    parts.push(formatStdQty(o.price_cents / o.unit_price_cents_per_std, o.std_unit));
    visibleUnit = unitFamily(o.std_unit);
  }
  const stdUnit = unitFamily(o.std_unit);
  if (o.unit_price_cents_per_std != null && o.std_unit && (!visibleUnit || !stdUnit || visibleUnit === stdUnit)) {
    parts.push(`${formatEuroCents(o.unit_price_cents_per_std)}/${o.std_unit}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Cross-chain variant (owner UX 2026-07-07): één zoekterm, álle geselecteerde
 *  supers in één /v1/match-call, resultaten gemerged en gesorteerd op prijs —
 *  goedkoopste bovenaan, keten-badge per rij. De user kiest, altijd. */
export interface CrossChainOption extends ProductOption {
  chain: string;
  /** relevantie-rang binnen de eigen keten-shortlist (0 = beste match) */
  rank: number;
}

/** al-gekozen sku's per keten — worden altijd getoond, vooraan, met de échte
 *  productnaam (owner-bug 2026-07-08: "Jumbo bruin brood" toonde geen vinkje
 *  omdat de fuzzy matcher die sku toevallig niet zelf terugvond). */
export type PinnedByChain = Record<string, string | undefined>;

export function useCrossChainOptions(term: string | null, chains: readonly string[], pinnedByChain?: PinnedByChain) {
  const [options, setOptions] = useState<CrossChainOption[] | null>(null);
  const chainKey = chains.join(',');
  const pinnedKey = pinnedByChain
    ? Object.entries(pinnedByChain)
        .filter(([c, sku]) => !!sku && chains.includes(c))
        .map(([c, sku]) => `${c}:${sku}`)
        .join(',')
    : '';
  useEffect(() => {
    if (!term || !chainKey) {
      setOptions(null);
      return;
    }
    let live = true;
    setOptions(null);
    const pinnedParam = pinnedKey ? `&pinned=${encodeURIComponent(pinnedKey)}` : '';
    authedRequest(`/v1/match?item=${encodeURIComponent(term)}&chains=${chainKey}${pinnedParam}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { matches: Record<string, { shortlist: ProductOption[] }> };
        const merged = chainKey.split(',').flatMap((c) =>
          (body.matches[c]?.shortlist ?? []).map((o, rank) => ({ ...o, chain: c, rank }) as CrossChainOption)
        );
        // owner 2026-07-07 (4e iteratie): één platte lijst, maar in lógische
        // volgorde — eerst het gezochte product zelf (alle varianten, goedkoopste
        // eerst), dan pas samengestelde producten (croissants, flappen), ook op prijs.
        merged.sort(
          (a, b) =>
            primaryRank(a) - primaryRank(b) ||
            (a.promo_price_cents ?? a.price_cents) - (b.promo_price_cents ?? b.price_cents) ||
            a.rank - b.rank
        );
        // de al-gekozen producten altijd bovenaan — ongeacht prijs/relevantie-
        // sortering, zodat de user in één oogopslag ziet wat er al staat.
        const pins = new Set(pinnedKey ? pinnedKey.split(',') : []);
        merged.sort((a, b) => Number(pins.has(`${b.chain}:${b.sku_id}`)) - Number(pins.has(`${a.chain}:${a.sku_id}`)));
        if (live) setOptions(merged);
      })
      .catch(() => {
        if (live) setOptions([]);
      });
    return () => {
      live = false;
    };
  }, [term, chainKey, pinnedKey]);
  return options;
}

/** één productrij met keten-badge — gedeeld door zoeklijst en item-sheet */
export function CrossChainRow({
  option,
  chosen,
  onPick,
}: {
  option: CrossChainOption;
  chosen?: boolean;
  onPick: (option: CrossChainOption) => void;
}) {
  return (
    <Pressable
      style={[styles.row, chosen && styles.rowChosen]}
      onPress={() => onPick(option)}
      accessibilityRole="button"
      accessibilityState={{ selected: !!chosen }}
      accessibilityLabel={`Kies ${option.name} bij ${option.chain}`}
    >
      {option.image_url ? (
        <Image source={{ uri: option.image_url }} style={styles.thumb} contentFit="contain" />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]} />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        {(() => {
          const flag = promoLabel(option);
          return flag ? (
            <View style={styles.bonusFlag}>
              <Text style={styles.bonusFlagText}>{flag}</Text>
            </View>
          ) : null;
        })()}
        <Text style={styles.name} numberOfLines={2}>{option.name}</Text>
        {(() => {
          const sub = [option.category_name, option.brand, packLabel(option)].filter(Boolean).join(' · ');
          return sub ? <Text style={styles.brand} numberOfLines={1}>{sub}</Text> : null;
        })()}
      </View>
      <ChainLogo id={option.chain} size={22} />
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        {option.promo_price_cents != null && option.promo_price_cents < option.price_cents ? (
          <>
            <Text style={styles.oldPrice}>{formatEuroCents(option.price_cents)}</Text>
            <Text style={styles.price}>{formatEuroCents(option.promo_price_cents)}</Text>
          </>
        ) : (
          <Text style={styles.price}>{formatEuroCents(option.price_cents)}</Text>
        )}
      </View>
      {chosen ? <Check size={16} color={colors.primary} strokeWidth={2.6} /> : null}
    </Pressable>
  );
}

/** De gedeelde resultatenlijst — één platte lijst met varianten, goedkoopste
 *  eerst. Eén component voor zoekpaneel én item-sheet, zodat ze nooit uiteenlopen. */
export function CrossChainList({
  options,
  maxRows = 30,
  currentSku,
  onPick,
}: {
  options: CrossChainOption[];
  maxRows?: number;
  currentSku?: string | null;
  onPick: (option: CrossChainOption) => void;
}) {
  return (
    <View>
      {options.slice(0, maxRows).map((o) => (
        <CrossChainRow key={`${o.chain}:${o.sku_id}`} option={o} chosen={o.sku_id === currentSku} onPick={onPick} />
      ))}
    </View>
  );
}

/** Zoek + kies over alle geselecteerde supers — voor de item-sheet. */
export function CrossChainOptions({
  term,
  chains,
  currentSku,
  pinnedByChain,
  onPick,
  maxRows = 30,
}: {
  term: string | null;
  chains: readonly string[];
  currentSku?: string | null;
  /** al-gekozen sku per keten (chain → sku_id) — altijd zichtbaar, vooraan */
  pinnedByChain?: PinnedByChain;
  onPick: (option: CrossChainOption) => void;
  /** ruim: liever scrollen dan een optie missen (owner 2026-07-07) */
  maxRows?: number;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const options = useCrossChainOptions(debounced || term, chains, pinnedByChain);

  return (
    <View>
      <View style={styles.searchRow}>
        <Search size={14} color={colors.textMuted2} strokeWidth={2.2} />
        <TextInput
          style={styles.searchInput}
          placeholder={`Zoek in je supers: ${term ?? 'roomboter'} of 500 g…`}
          placeholderTextColor={colors.textMuted2}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
        />
      </View>
      {options === null ? (
        <Text style={[type.meta, styles.state]}>Producten laden…</Text>
      ) : options.length === 0 ? (
        <Text style={[type.meta, styles.state]}>Geen producten gevonden — probeer een ander woord.</Text>
      ) : (
        <CrossChainList options={options} maxRows={maxRows} currentSku={currentSku} onPick={onPick} />
      )}
    </View>
  );
}

export function useProductOptions(term: string | null, chain: string, enabled = true) {
  const [options, setOptions] = useState<ProductOption[] | null>(null);
  useEffect(() => {
    if (!enabled) {
      setOptions([]);
      return;
    }
    if (!term) {
      setOptions(null);
      return;
    }
    let live = true;
    setOptions(null);
    authedRequest(`/v1/match?item=${encodeURIComponent(term)}&chains=${chain}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { matches: Record<string, { shortlist: ProductOption[] }> };
        // zelfde logische volgorde als cross-chain: eerst het product zelf, dan de rest
        const sorted = [...(body.matches[chain]?.shortlist ?? [])].sort(
          (a, b) =>
            primaryRank(a) - primaryRank(b) ||
            (a.promo_price_cents ?? a.price_cents) - (b.promo_price_cents ?? b.price_cents)
        );
        if (live) setOptions(sorted);
      })
      .catch(() => {
        if (live) setOptions([]);
      });
    return () => {
      live = false;
    };
  }, [term, chain, enabled]);
  return options;
}

export function ProductOptions({
  term,
  chain,
  currentSku,
  suggestedOptions = [],
  onPick,
  maxRows = 24,
  initialRows = 6,
  searchable = true,
  fetchFallback = true,
}: {
  term: string | null;
  chain: string;
  currentSku?: string | null;
  /** Policy-aware preview candidates, already ranked by the server. */
  suggestedOptions?: ProductOption[];
  onPick: (option: ProductOption) => void;
  maxRows?: number;
  /** Keep review sheets compact while retaining access to the full shortlist. */
  initialRows?: number;
  /** vind álles: "croissant" typen bij "roomboter" haalt de croissants op */
  searchable?: boolean;
  /** Fetch the broad /v1/match fallback immediately. A typed search always
   *  fetches, so preview-ranked suggestions can render without initial I/O. */
  fetchFallback?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setExpanded(false), [term, chain, debounced]);
  const shouldFetchFallback = fetchFallback || !!debounced;
  const fetchedOptions = useProductOptions(debounced || term, chain, shouldFetchFallback);
  const options = useMemo(() => {
    // A typed search replaces the policy suggestions; without a search, keep
    // the server-ranked, anchor-aware candidates first and append /v1/match as
    // a broad fallback. Dedupe by SKU so the same product never appears twice.
    const source = debounced
      ? (fetchedOptions ?? [])
      : [...suggestedOptions, ...(fetchedOptions ?? [])];
    const seen = new Set<string>();
    return source.filter((option) => {
      if (seen.has(option.sku_id)) return false;
      seen.add(option.sku_id);
      return true;
    });
  }, [debounced, fetchedOptions, suggestedOptions]);
  const availableRows = Math.min(options.length, maxRows);
  const visibleRows = expanded ? availableRows : Math.min(availableRows, initialRows);

  const searchBox = searchable ? (
    <View style={styles.searchRow}>
      <Search size={14} color={colors.textMuted2} strokeWidth={2.2} />
      <TextInput
        style={styles.searchInput}
        placeholder={`Zoek bij ${chain.toUpperCase()}: ${term ?? 'product'} of 500 g…`}
        placeholderTextColor={colors.textMuted2}
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
      />
    </View>
  ) : null;

  if (shouldFetchFallback && fetchedOptions === null && options.length === 0) {
    return (
      <View>
        {searchBox}
        <Text style={[type.meta, styles.state]}>Producten laden…</Text>
      </View>
    );
  }
  if (options.length === 0) {
    return (
      <View>
        {searchBox}
        <Text style={[type.meta, styles.state]}>Geen producten gevonden — probeer een ander woord.</Text>
      </View>
    );
  }
  return (
    <View>
      {searchBox}
      {options.slice(0, visibleRows).map((o) => {
        const chosen = o.sku_id === currentSku;
        return (
          <Pressable
            key={o.sku_id}
            style={[styles.row, chosen && styles.rowChosen]}
            onPress={() => onPick(o)}
            accessibilityRole="button"
            accessibilityState={{ selected: chosen }}
            accessibilityLabel={`Kies ${o.name}`}
          >
            {o.image_url ? (
              <Image source={{ uri: o.image_url }} style={styles.thumb} contentFit="contain" />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]} />
            )}
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <Text style={styles.name} numberOfLines={2}>{o.name}</Text>
              {(() => {
                const sub = [o.brand, packLabel(o)].filter(Boolean).join(' · ');
                return sub ? <Text style={styles.brand} numberOfLines={1}>{sub}</Text> : null;
              })()}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              {o.promo_price_cents != null && o.promo_price_cents < o.price_cents ? (
                <>
                  <Text style={styles.oldPrice}>{formatEuroCents(o.price_cents)}</Text>
                  <Text style={styles.price}>{formatEuroCents(o.promo_price_cents)}</Text>
                </>
              ) : (
                <Text style={styles.price}>{formatEuroCents(o.price_cents)}</Text>
              )}
            </View>
            {chosen ? <Check size={16} color={colors.primary} strokeWidth={2.6} /> : null}
          </Pressable>
        );
      })}
      {availableRows > initialRows ? (
        <Pressable
          onPress={() => setExpanded((current) => !current)}
          style={styles.moreButton}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? 'Minder alternatieven tonen' : `Alle ${availableRows} alternatieven tonen`}
        >
          <Text style={styles.moreButtonText}>
            {expanded ? 'Minder tonen' : `Toon ${availableRows - initialRows} meer`}
          </Text>
          {expanded
            ? <ChevronUp size={15} color={colors.primary} strokeWidth={2.4} />
            : <ChevronDown size={15} color={colors.primary} strokeWidth={2.4} />}
        </Pressable>
      ) : null}
      {shouldFetchFallback && fetchedOptions === null
        ? <Text style={styles.loadingMore}>Meer producten laden…</Text>
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  state: { paddingVertical: 10 },
  bonusFlag: {
    alignSelf: 'flex-start', backgroundColor: colors.bonusFlag, borderRadius: radius.pill,
    paddingHorizontal: 8, paddingVertical: 2, marginBottom: 1,
  },
  bonusFlagText: { fontSize: 10, fontFamily: fonts.bodyBold, color: colors.onBonusFlag },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surfaceMuted,
    borderRadius: radius.control, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 6,
    borderWidth: 1, borderColor: colors.borderControl,
  },
  searchInput: { flex: 1, fontSize: 13.5, color: colors.text, padding: 0 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 6,
    borderRadius: radius.md,
  },
  rowChosen: { backgroundColor: colors.badgeBg },
  thumb: { width: 40, height: 40, borderRadius: 8, backgroundColor: colors.surface },
  thumbEmpty: { backgroundColor: '#EDE7D8' },
  name: { fontSize: 12.5, color: colors.text, lineHeight: 16 },
  brand: { fontSize: 10.5, color: colors.textMuted2 },
  price: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  oldPrice: { fontSize: 10.5, color: colors.textDisabled, textDecorationLine: 'line-through' },
  moreButton: {
    minHeight: 40, marginTop: 4, borderRadius: radius.control, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: colors.badgeBg,
  },
  moreButtonText: { fontSize: 12, fontFamily: fonts.bodyBold, color: colors.primary },
  loadingMore: { paddingVertical: 5, textAlign: 'center', fontSize: 10.5, color: colors.textMuted2 },
});
