import { formatEuroCents, type StorePanelSort } from '@prakkie/shared';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import {
  AlertTriangle, Bookmark, BookmarkPlus, Check, ChevronLeft, ChevronRight, Minus, Pencil, Plus,
  RotateCcw, Search, Share2, Sparkles, Star, Tag, Trash2, Users, X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CrossChainOptions,
  hasPreparedRecommendationCue,
  packLabel,
  rankRecommendedProducts,
  type CrossChainOption,
  type PinnedByChain,
  type ProductOption,
} from '../../components/prakkie/ProductOptions';
import { ChainLogo } from '../../components/prakkie/ChainLogo';
import { CrossChainTotal } from '../../components/prakkie/CrossChainTotal';
import { CTAButton } from '../../components/prakkie/CTAButton';
import { LoadingBar } from '../../components/prakkie/LoadingBar';
import { useBasketPlan } from '../../data/basket-plan';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest, currentUser } from '../../data/api';
import { CHAIN_BRAND, chainName } from '../../data/chains';
import { activeHouseholdId, loadHousehold, memberName, type HouseholdInfo, type MemberInfo } from '../../data/households';
import {
  getCachedPreview,
  getCachedPricing,
  invalidateShoppingSessionList,
  loadCachedPreview,
  type ShoppingChainPricing,
  type ShoppingMatchPolicy,
  type ShoppingPricedLine,
  type ShoppingSubstitutionPreview,
  useShoppingSessionCache,
  warmShoppingSession,
} from '../../data/shopping-session-cache';
import { confirmDialog, notice } from '../../lib/dialogs';
import { reusableChainChoice } from '../../data/substitution-choice';
import {
  fetchPanelProducts,
  resolveStoreCategory,
  type ResolvedStoreCategory,
  useMyChains,
} from '../../store/api';
import { shoppingItemDescriptors } from '../../store/lijst';
import { colors, fonts, radius, shadows, type } from '../../theme/tokens';

/**
 * De summary (owner 2026-07-13): dé lijst met prijzen — standaard gesorteerd
 * per supermarkt, met als enige schakelaar "supermarkt subtotalen". Producten
 * komen erop door de winkel te browsen (Boodschappen-tab); de AI-resolve
 * ("Vind mijn prakkie") is gesloopt. Verder ongewijzigd: super-wissel
 * ("Alles bij X"), afvinken, draft/Opslaan, delen, favorieten.
 */

interface ListRow {
  id: string; name: string; week_start?: string | null; household_id?: string | null; is_current?: boolean;
  /** losse huisgenoten met wie deze lijst gedeeld is (naast household_id) */
  shared_with?: string[] | null;
}
type MatchPolicy = ShoppingMatchPolicy;
interface RestorableMatchEntry {
  sku_id: string; confidence?: number; user_pinned?: boolean; preferred?: boolean;
  unit_cents?: number | null;
  /** Per-supermarket wizard result, retained when another chain becomes preferred. */
  product_name?: string;
  image_url?: string | null;
  pack_size_value?: number | null;
  pack_size_unit?: string | null;
  unit_price_cents_per_std?: number | null;
  std_unit?: string | null;
  selected_qty?: number;
  origin?: 'automatic' | 'bulk_accepted' | 'user_confirmed';
  policy?: MatchPolicy; matcher_version?: string;
}
interface MatchRestore {
  chain_id: string | null;
  product_name: string;
  item_normalised?: string | null;
  match?: RestorableMatchEntry | null;
  unit_cents?: number | null;
  quantity?: number | string | null;
}
interface MatchEntry extends RestorableMatchEntry {
  /** Persisted undo point for changes made by Alles bij / Goedkoopste prakkie. */
  restore?: MatchRestore;
}
interface ItemRow {
  id: string; list_id: string; name: string; quantity: number | string | null; unit: string | null;
  aisle_group_id: number | null; checked: boolean; is_manual: boolean;
  item_normalised?: string | null;
  matches?: Record<string, MatchEntry>;
  provenance?: { recipe_title?: string; title?: string }[];
  added_by?: string | null;
  created_at?: string;
  updated_at?: string;
  /** client-only: stuksprijs per keten van net gekozen producten/alternatieven
   *  (draft — de server heeft deze keuzes nog niet geprijsd) */
  _alt_cents?: Record<string, number>;
}

type PricedLine = ShoppingPricedLine;
type ChainPricing = ShoppingChainPricing;
interface Correction { chain_id: string; item_normalised: string; chosen_sku_id: string }
type SubstitutionPreview = ShoppingSubstitutionPreview;
interface ApplySubstitutionOptions {
  preview?: SubstitutionPreview;
  chain?: string;
  choices?: Record<string, ProductOption>;
  quantities?: Record<string, number>;
}
const SUBSTITUTION_POLICY: MatchPolicy = 'precise';
const PICKER_SORTS: { key: StorePanelSort; label: string }[] = [
  { key: 'aanbevolen', label: 'Aanbevolen' },
  { key: 'prijs', label: 'Prijs' },
  { key: 'eenheidsprijs', label: 'Per kilo/liter' },
];
interface SubstitutionFeedback {
  item_id: string; chain_id: string; candidate_sku_id: string; policy: MatchPolicy;
  action: 'bulk_accepted' | 'user_confirmed' | 'rejected'; reliability?: number | null;
  reasons: string[]; matcher_version: string;
}
interface CheapestPlan {
  total: number;
  counts: Map<string, number>;
  choices: Map<string, { chain: string; cents: number }>;
  missing: number;
}

/** de keuze van de user voor dit item: eerst expliciet verkozen, dan gepind */
function chosenChainOf(item: ItemRow, myChains: string[]): string | null {
  const m = item.matches ?? {};
  const preferred = Object.keys(m).find((c) => m[c]?.preferred && !!reusableChainChoice(m, c));
  if (preferred) return preferred;
  return [...myChains, ...Object.keys(m)].find((c) => !!reusableChainChoice(m, c)) ?? null;
}

/** kale aantallen (geen eenheid / stuks) schalen de prijs lineair mee */
const isCount = (i: ItemRow) => !i.unit || i.unit === 'st' || i.unit === 'stuks';
const countQty = (i: ItemRow) => Math.max(1, Number(i.quantity) || 1);

/** de velden die de server kent — client-only velden (_unit_cents) blijven thuis */
function itemFields(i: ItemRow): Record<string, unknown> {
  return {
    list_id: i.list_id,
    name: i.name,
    quantity: i.quantity ?? null,
    unit: i.unit ?? null,
    item_normalised: i.item_normalised ?? null,
    aisle_group_id: i.aisle_group_id ?? null,
    is_manual: !!i.is_manual,
    matches: i.matches ?? {},
    checked: !!i.checked,
    ...(i.provenance ? { provenance: i.provenance } : {}),
  };
}

function withoutRestore(entry: MatchEntry): RestorableMatchEntry {
  const { restore: _restore, ...plain } = entry;
  return plain;
}

/** Bewaar het pack-aantal van de oude supermarkt vóór een andere keten
 * preferred wordt. Het lijst-aantal zelf is niet het pack-aantal van iedere
 * supermarktvariant. */
function withoutPreferredForSwitch(entry: MatchEntry, item: ItemRow): MatchEntry {
  const { preferred: _preferred, ...rest } = entry;
  return isCount(item) && entry.preferred && rest.selected_qty == null
    ? { ...rest, selected_qty: countQty(item) }
    : rest;
}

function restorePointOf(item: ItemRow): MatchRestore | null {
  return Object.values(item.matches ?? {}).find((entry) => !!entry.restore)?.restore ?? null;
}

function optionLineCents(item: ItemRow, option: ProductOption): number {
  if (option.line_price_cents != null) return option.line_price_cents;
  const unitCents = option.promo_price_cents ?? option.price_cents;
  return isCount(item) ? Math.round(unitCents * countQty(item)) : unitCents;
}

export default function ResultaatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { rows: listRows } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const selectedChains = useMyChains();
  const myChains = selectedChains ?? ['ah'];
  const chainsLoaded = selectedChains !== null;
  // Abonnement op de module-cache: een afgeronde Boodschappen-opwarming laat
  // dit scherm direct hertekenen, zonder hier een tweede aanvraag te starten.
  const shoppingCache = useShoppingSessionCache();
  const [detailItem, setDetailItem] = useState<ItemRow | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [household, setHousehold] = useState<HouseholdInfo | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  // het draft-model: null = live (opgeslagen) weergave; anders het concept
  const [draftItems, setDraftItems] = useState<ItemRow[] | null>(null);
  const [draftCorrections, setDraftCorrections] = useState<Correction[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'save' | 'saveDraft' | 'share' | 'load'>('none');
  const [templateName, setTemplateName] = useState('');
  const [draftSaveName, setDraftSaveName] = useState('');
  const [substitutionChain, setSubstitutionChain] = useState<string | null>(null);
  const [substitutionPreview, setSubstitutionPreview] = useState<SubstitutionPreview | null>(null);
  const [substitutionLoading, setSubstitutionLoading] = useState(false);
  const [previewStep, setPreviewStep] = useState(0);
  // Kies-alternatief picker (owner-mockup 2026-07-14): de staged keuze op de
  // huidige kaart; pas "Volgende" maakt hem definitief
  // (EAN-only regime: alleen expliciete keuzes worden toegepast)
  const [stagedPickSku, setStagedPickSku] = useState<string | null>(null);
  // aantal-keuze bij de staged variant: null = gebruik het bestaande lijst-aantal
  const [stagedQty, setStagedQty] = useState<number | null>(null);
  const [pickerCatalogSearch, setPickerCatalogSearch] = useState('');
  const [pickerCatalogSort, setPickerCatalogSort] = useState<StorePanelSort>('aanbevolen');
  const [pickerCatalogResults, setPickerCatalogResults] = useState<ProductOption[] | null>(null);
  const [pickerCatalogLoading, setPickerCatalogLoading] = useState(false);
  const [pickerCategory, setPickerCategory] = useState<ResolvedStoreCategory | null>(null);
  const [pickerCategoryError, setPickerCategoryError] = useState<string | null>(null);
  const [previewChoices, setPreviewChoices] = useState<Record<string, ProductOption>>({});
  // bevestigde aantallen per item (alleen stuks-regels; 800 g → 4× 200 g)
  const [previewQty, setPreviewQty] = useState<Record<string, number>>({});
  const [substitutionFeedback, setSubstitutionFeedback] = useState<SubstitutionFeedback[]>([]);
  const [selectedStoreCard, setSelectedStoreCard] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const prakkieShimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(prakkieShimmer, {
        toValue: 1,
        duration: 2600,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    animation.start();
    return () => animation.stop();
  }, [prakkieShimmer]);

  // naam-bewerken in de item-sheet: draft volgt het geopende item
  useEffect(() => {
    setNameDraft(detailItem?.name ?? '');
  }, [detailItem?.id]);

  // jouw supers uit Profiel: kv-cache direct, /v1/me als waarheid
  useEffect(() => {
    loadHousehold().then((h) => {
      setMembers(h.members);
      setHousehold(h.household);
    }).catch(() => {});
    currentUser().then((u) => setMyId(u?.id ?? null)).catch(() => {});
  }, []);

  const lists = useMemo(
    () => listRows.map((r) => ({ ...(r.row as unknown as ListRow), id: r.id })),
    [listRows]
  );
  // owner 2026-07-10: boodschappen is niet dag-gebonden — er is precies één
  // actuele lijst (is_current); dat is de laatste waarheid. Oude gedateerde
  // lijsten blijven bestaan maar de app toont ze niet meer.
  const list = lists.find((l) => l.is_current) ?? null;
  const items = useMemo(
    () => itemRows.map((r) => r.row as unknown as ItemRow).filter((i) => list && i.list_id === list.id),
    [itemRows, list]
  );
  const itemDescriptors = useMemo(() => shoppingItemDescriptors(items), [items]);
  const listRevision = useMemo(
    () => itemDescriptors.map((item) => item.fingerprint).sort().join('|'),
    [itemDescriptors]
  );
  // opgeslagen lijstjes (favorieten): lijsten zonder datum, niet de actuele —
  // laden kan hier direct (owner 2026-07-13): de items dragen hun productkeuzes
  // (matches) al mee, dus er komt geen matcher aan te pas
  const templates = useMemo(
    () => lists.filter((l) => !(l.week_start ?? '').slice(0, 10) && !l.is_current),
    [lists]
  );
  const templateCount = useCallback(
    (tplId: string) =>
      itemRows.filter((r) => (r.row as unknown as ItemRow).list_id === tplId).length,
    [itemRows]
  );

  /** favoriet lijstje inladen: items komen bóven op je huidige lijst */
  async function loadTemplate(tpl: ListRow) {
    let listId = list?.id ?? null;
    if (!listId) {
      listId = newId();
      await upsertRow('lists', { name: 'Mijn boodschappen', is_current: true, household_id: await activeHouseholdId() }, listId);
    }
    const tplItems = itemRows
      .map((r) => ({ ...(r.row as unknown as ItemRow), id: r.id }))
      .filter((i) => i.list_id === tpl.id);
    for (const it of tplItems) {
      await upsertRow('list_items', itemFields({ ...it, list_id: listId, checked: false }), newId());
    }
    setSheet('none');
    syncNow(['lists', 'list_items']).catch(() => {});
  }

  async function removeTemplate(tpl: ListRow) {
    const ok = await confirmDialog({
      title: 'Opgeslagen lijstje verwijderen?',
      message: `“${tpl.name}” verdwijnt uit je opgeslagen lijstjes.`,
      confirmLabel: 'Verwijderen',
      destructive: true,
    });
    if (!ok) return;
    const children = itemRows.filter((r) => (r.row as unknown as ItemRow).list_id === tpl.id);
    for (const c of children) await deleteRow('list_items', c.id);
    await deleteRow('lists', tpl.id);
    syncNow(['lists', 'list_items']).catch(() => {});
  }
  // wat je op het scherm ziet: het concept als dat er is, anders de opgeslagen staat
  const displayItems = draftItems ?? items;
  const hasDraft = draftItems !== null;
  const checkedCount = displayItems.filter((i) => i.checked).length;

  /** elke bewerking gaat het concept in; pas Opslaan schrijft echt weg */
  const mutateDraft = useCallback(
    (fn: (rows: ItemRow[]) => ItemRow[]) => {
      setDraftItems((prev) => fn((prev ?? items).map((r) => ({ ...r }))));
    },
    [items]
  );

  async function discardDraftGuard(): Promise<boolean> {
    if (!draftItems) return true;
    const ok = await confirmDialog({
      title: 'Wijzigingen weggooien?',
      message: 'Je hebt niet-opgeslagen wijzigingen op deze lijst.',
      confirmLabel: 'Weggooien',
      destructive: true,
    });
    if (ok) {
      setDraftItems(null);
      setDraftCorrections([]);
      setSubstitutionFeedback([]);
    }
    return ok;
  }

  // weergave (owner 2026-07-13): áltijd gesorteerd per supermarkt; de enige
  // schakelaar is "supermarkt subtotalen" — groepskoppen mét subtotaal aan/uit
  const [showSubtotals, setShowSubtotals] = useState(false);

  /** "leeg de lijst" (owner 2026-07-10): alle items van dé lijst weg, met bevestiging */
  async function clearList() {
    if (!list || (displayItems.length === 0 && !hasDraft)) return;
    const ok = await confirmDialog({
      title: 'Lijst leegmaken?',
      message: 'Alle items verdwijnen van je boodschappenlijst — ook voor je huishouden.',
      confirmLabel: 'Leegmaken',
      destructive: true,
    });
    if (!ok) return;
    setDraftItems(null);
    setDraftCorrections([]);
    setSubstitutionFeedback([]);
    setDetailItem(null);
    for (const it of items) await deleteRow('list_items', it.id);
    invalidateShoppingSessionList(list.id);
    syncNow(['list_items']).catch(() => {});
    router.replace('/(tabs)/boodschappen'); // lege lijst = terug naar de start van de flow
  }

  // log: wie heeft als laatst iets toegevoegd (huishouden)
  const lastAdded = useMemo(() => {
    const withTime = items.filter((i) => i.created_at);
    if (!withTime.length) return null;
    const last = withTime.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]!;
    const who = memberName(members, last.added_by);
    return who ? { who, what: last.name } : null;
  }, [items, members]);

  // Cache-only read. De Boodschappen-tab heeft deze bundel normaal al gevuld;
  // een directe deep-link sluit aan op exact dezelfde single-flight warm-up.
  const pricing: ChainPricing[] | null =
    list && items.length > 0 && chainsLoaded
      ? getCachedPricing(list.id, myChains)
      : null;

  useEffect(() => {
    if (!list || items.length === 0 || !chainsLoaded || myChains.length === 0) return;
    void warmShoppingSession({
      listId: list.id,
      chains: myChains,
      revision: listRevision,
      items: itemDescriptors,
    });
  }, [list?.id, items.length, chainsLoaded, myChains.join(','), listRevision, itemDescriptors]);

  // matching v2 (Fase 5): het directe cross-supermarkt totaal van de server —
  // read-only naast de handmatige samenstelling; toont zichzelf pas als de
  // facet/graph-backfill matches oplevert.
  const { plan: basketPlan } = useBasketPlan(list?.id ?? null, chainsLoaded ? myChains : []);

  // prijsregels per keten per item (van de opgeslagen staat)
  const linesByChain = useMemo(() => {
    const m = new Map<string, Map<string, PricedLine>>();
    for (const c of pricing ?? []) m.set(c.chain_id, new Map(c.lines.map((l) => [l.item_id, l])));
    return m;
  }, [pricing]);

  /** regelprijs van dit item bij deze keten — draft-bewust: kale aantallen
   *  schalen lineair (bonus zit al in de serverregel per stuk), en een net
   *  gekozen product draagt zijn eigen stuksprijs (_unit_cents) mee. */
  const lineCentsAt = useCallback(
    (item: ItemRow, chain: string): number | null => {
      const line = linesByChain.get(chain)?.get(item.id);
      const match = item.matches?.[chain];
      const alt = item._alt_cents?.[chain];
      const pinnedUnit = match?.unit_cents;
      if (isCount(item)) {
        const unit =
          alt ??
          pinnedUnit ??
          (line?.matched && line.line_price_cents != null
            ? line.line_price_cents / Math.max(1, line.packs ?? 1)
            : null);
        const selectedQty = match?.selected_qty ?? countQty(item);
        return unit === null || unit === undefined ? null : Math.round(unit * selectedQty);
      }
      return alt ?? pinnedUnit ?? (
        line?.matched && line.line_price_cents != null ? line.line_price_cents : null
      );
    },
    [linesByChain]
  );

  /** productfoto + pack-meta van de gekozen sku bij een keten — uit de
   *  sessie-alternatieven (de geselecteerde sku staat daar altijd vooraan) */
  const lineProductFor = useCallback(
    (item: ItemRow, chain: string | null): ProductOption | null => {
      if (!chain) return null;
      const line = linesByChain.get(chain)?.get(item.id);
      const stored = item.matches?.[chain];
      const sku = stored?.sku_id ?? line?.sku_id;
      const fromSession = line?.alternatives?.find((a) => a.sku_id === sku);
      if (fromSession) return fromSession;
      if (stored?.sku_id && stored.product_name && stored.unit_cents != null) {
        return {
          sku_id: stored.sku_id,
          name: stored.product_name,
          price_cents: stored.unit_cents,
          image_url: stored.image_url,
          pack_size_value: stored.pack_size_value,
          pack_size_unit: stored.pack_size_unit,
          unit_price_cents_per_std: stored.unit_price_cents_per_std,
          std_unit: stored.std_unit,
        };
      }
      return line?.alternatives?.[0] ?? null;
    },
    [linesByChain]
  );

  /** Preserve the user's pre-batch product + supermarket choice inside the
   *  match JSON itself. This survives Opslaan, app restarts and another device. */
  const restorePointFor = useCallback(
    (item: ItemRow): MatchRestore => {
      const existing = restorePointOf(item);
      if (existing) return existing; // consecutive batch switches keep the first baseline
      const chain = chosenChainOf(item, myChains);
      const entry = chain ? item.matches?.[chain] : null;
      const pricedLine = chain ? linesByChain.get(chain)?.get(item.id) : null;
      const unitCents = chain
        ? item._alt_cents?.[chain] ?? entry?.unit_cents ?? (
            pricedLine?.line_price_cents != null
              ? Math.round(pricedLine.line_price_cents / Math.max(1, pricedLine.packs ?? 1))
              : null
          )
        : null;
      return {
        chain_id: chain,
        product_name: item.name,
        item_normalised: item.item_normalised ?? null,
        match: entry
          ? {
              ...withoutRestore(entry),
              ...(isCount(item) && entry.selected_qty == null ? { selected_qty: countQty(item) } : {}),
            }
          : null,
        unit_cents: unitCents,
        quantity: item.quantity,
      };
    },
    [myChains, linesByChain]
  );

  const hasOriginalChoices = useMemo(
    () => displayItems.some((item) => !!restorePointOf(item)),
    [displayItems]
  );

  const previewReviewLines = useMemo(() => {
    if (!substitutionPreview || !substitutionChain) return [];
    const activeItems = new Map(
      displayItems.filter((item) => !item.checked).map((item) => [item.id, item])
    );
    return substitutionPreview.lines.filter(
      (line) => {
        const item = activeItems.get(line.item_id);
        return !!item && (
          !reusableChainChoice(item.matches, substitutionChain) ||
          lineCentsAt(item, substitutionChain) == null
        );
      }
    );
  }, [substitutionPreview, substitutionChain, displayItems, lineCentsAt]);

  useEffect(() => {
    setPreviewStep((current) => Math.max(0, Math.min(current, Math.max(0, previewReviewLines.length - 1))));
  }, [previewReviewLines.length]);

  const currentPreviewLine = previewReviewLines[previewStep] ?? null;
  const currentPreviewItem = currentPreviewLine
    ? displayItems.find((item) => item.id === currentPreviewLine.item_id) ?? null
    : null;
  const currentPickerAisle = currentPreviewLine?.category_aisle_id ?? currentPreviewItem?.aisle_group_id ?? null;
  const currentPickerSourceChain = currentPreviewItem ? chosenChainOf(currentPreviewItem, myChains) : null;
  const currentPickerAnchorProduct = currentPreviewItem
    ? lineProductFor(currentPreviewItem, currentPickerSourceChain)
    : null;
  const currentPickerAnchor = currentPreviewItem ? {
    name: currentPickerAnchorProduct?.name ?? currentPreviewItem.name,
    pack_size_value: currentPickerAnchorProduct?.pack_size_value
      ?? (currentPickerSourceChain ? currentPreviewItem.matches?.[currentPickerSourceChain]?.pack_size_value : null)
      ?? null,
    pack_size_unit: currentPickerAnchorProduct?.pack_size_unit
      ?? (currentPickerSourceChain ? currentPreviewItem.matches?.[currentPickerSourceChain]?.pack_size_unit : null)
      ?? null,
    price_cents: currentPickerAnchorProduct?.price_cents
      ?? (currentPickerSourceChain ? currentPreviewItem.matches?.[currentPickerSourceChain]?.unit_cents : null)
      ?? 0,
    unit_price_cents_per_std: currentPickerAnchorProduct?.unit_price_cents_per_std
      ?? (currentPickerSourceChain ? currentPreviewItem.matches?.[currentPickerSourceChain]?.unit_price_cents_per_std : null)
      ?? null,
    std_unit: currentPickerAnchorProduct?.std_unit
      ?? (currentPickerSourceChain ? currentPreviewItem.matches?.[currentPickerSourceChain]?.std_unit : null)
      ?? null,
  } : null;
  const currentPickerServerRanks = currentPreviewLine?.alternatives?.map((option) => option.sku_id) ?? [];

  useEffect(() => {
    if (!substitutionChain || !currentPreviewItem) {
      setPickerCategory(null);
      setPickerCategoryError(null);
      setPickerCatalogResults(null);
      return;
    }
    let live = true;
    setPickerCategory(null);
    setPickerCategoryError(null);
    setPickerCatalogResults(null);
    setPickerCatalogLoading(true);
    resolveStoreCategory({
      term: currentPreviewItem.item_normalised ?? currentPreviewItem.name,
      aisle: currentPickerAisle,
      sourceChain: currentPickerSourceChain,
      sourceSku: currentPickerSourceChain ? currentPreviewItem.matches?.[currentPickerSourceChain]?.sku_id : null,
    })
      .then((category) => {
        if (!live) return;
        if (!category) {
          setPickerCategoryError('Voor dit product is nog geen veilige winkelcategorie gevonden.');
          setPickerCatalogLoading(false);
          return;
        }
        setPickerCategory(category);
      })
      .catch(() => {
        if (live) {
          setPickerCategoryError('De productcategorie kon niet worden geladen. Probeer het opnieuw.');
          setPickerCatalogLoading(false);
        }
      });
    return () => { live = false; };
  }, [substitutionChain, currentPreviewLine?.item_id, currentPickerAisle, myChains.join(',')]);

  useEffect(() => {
    const q = pickerCatalogSearch.trim();
    if (!substitutionChain || !pickerCategory || !currentPickerAnchor) return;
    const preparedSource = hasPreparedRecommendationCue(currentPickerAnchor.name);
    let live = true;
    setPickerCatalogLoading(true);
    setPickerCatalogResults(null);
    const timer = setTimeout(() => {
      (async () => {
        const products: ProductOption[] = [];
        let offset = 0;
        // Categorieën kunnen groter zijn dan één API-pagina. Haal echt alle
        // kandidaten op; zoeken blijft daarbij binnen exact dezelfde categorie.
        for (let page = 0; page < 20; page++) {
          const result = await fetchPanelProducts(pickerCategory.id, [substitutionChain], {
            ...(q ? { q } : {}),
            offset,
            limit: 300,
            sort: pickerCatalogSort,
            // Ordinary products start in the resolved subcategory. A typed
            // query or an explicitly prepared source widens retrieval because
            // retailers often file BBQ/skewers in a neighbouring shelf.
            // Prepared products frequently live in a neighbouring retailer
            // shelf. Load their complete department immediately; the strict
            // cue filter below keeps plain kipfilet out of the recommendation
            // list. Ordinary products retain the faster category-only path.
            scope: q || preparedSource ? 'department' : 'category',
          });
          const batch = (result?.products ?? []) as ProductOption[];
          products.push(...batch);
          if (!result?.has_more || batch.length === 0) break;
          offset += batch.length;
        }
        if (!live) return;
        // The safe API shortlist can contain the right prepared variant from a
        // neighbouring shelf (BBQ/skewers), while the resolved category itself
        // contains only plain kipfilet. Merge that shortlist into the initial
        // recommendation lane so the category fetch cannot hide it again.
        // For an explicit typed search, only the user's query results are used.
        const initialProducts = q
          ? products
          : [...(currentPreviewLine?.alternatives ?? []), ...products];
        const uniqueProducts = initialProducts.filter((product, index, all) =>
          all.findIndex((candidate) => candidate.sku_id === product.sku_id) === index
        );
        setPickerCatalogResults(pickerCatalogSort === 'aanbevolen'
          ? rankRecommendedProducts(uniqueProducts, {
              anchor: currentPickerAnchor,
              query: q,
              serverRankedSkus: currentPickerServerRanks,
            })
          : uniqueProducts);
      })()
        .catch(() => {
          if (live) setPickerCatalogResults([]);
        })
        .finally(() => {
          if (live) setPickerCatalogLoading(false);
        });
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [
    pickerCatalogSearch,
    pickerCatalogSort,
    substitutionChain,
    pickerCategory?.id,
    currentPreviewLine?.item_id,
    currentPickerAnchor?.name,
    currentPickerAnchor?.pack_size_value,
    currentPickerAnchor?.pack_size_unit,
    currentPickerAnchor?.price_cents,
    currentPickerAnchor?.unit_price_cents_per_std,
    currentPickerAnchor?.std_unit,
    currentPickerServerRanks.join(','),
    currentPreviewLine?.alternatives,
  ]);

  const openItems = useMemo(() => displayItems.filter((i) => !i.checked), [displayItems]);
  const uniformStoreCard = useMemo(() => {
    if (openItems.length === 0) return null;
    const first = chosenChainOf(openItems[0]!, myChains);
    return first && openItems.every((item) => chosenChainOf(item, myChains) === first) ? first : null;
  }, [openItems, myChains]);
  const activeStoreCard = selectedStoreCard ?? uniformStoreCard;
  // hoofdtotaal: alleen wat de user zelf koos, bij de keten waar die het koos
  const chosenTotal = useMemo(() => {
    let cents = 0;
    let chosen = 0;
    for (const item of openItems) {
      const chain = chosenChainOf(item, myChains);
      const c = chain ? lineCentsAt(item, chain) : null;
      if (c != null) {
        cents += c;
        chosen++;
      }
    }
    return { cents, chosen, open: openItems.length - chosen };
  }, [openItems, myChains, lineCentsAt]);

  // "Je bespaart" in de totaalkaart (owner-mockup 2026-07-14): actieve bonus-
  // besparing over de gekozen regels — alleen tonen als er echt iets te
  // besparen valt, nooit een verzonnen getal.
  const chosenSavings = useMemo(() => {
    let cents = 0;
    for (const item of openItems) {
      const chain = chosenChainOf(item, myChains);
      if (!chain) continue;
      const line = linesByChain.get(chain)?.get(item.id);
      if (line?.matched && (line.promo_savings_cents ?? 0) > 0) cents += line.promo_savings_cents!;
    }
    return cents;
  }, [openItems, myChains, linesByChain]);

  // per-supermarkt groepen met subtotalen (owner: schap-categorieën weg)
  const chainGroups = useMemo(() => {
    const by = new Map<string, ItemRow[]>();
    for (const it of displayItems) {
      const c = chosenChainOf(it, myChains) ?? '__none';
      (by.get(c) ?? by.set(c, []).get(c)!).push(it);
    }
    const order = [
      ...myChains.filter((c) => by.has(c)),
      ...[...by.keys()].filter((c) => c !== '__none' && !myChains.includes(c)),
      ...(by.has('__none') ? ['__none'] : []),
    ];
    return order.map((key) => {
      const chain = key === '__none' ? null : key;
      const groupItems = by.get(key)!;
      let subtotal = 0;
      let priced = 0;
      if (chain) {
        for (const it of groupItems) {
          if (it.checked) continue;
          const c = lineCentsAt(it, chain);
          if (c != null) {
            subtotal += c;
            priced++;
          }
        }
      }
      return { chain, items: groupItems, subtotal, priced };
    });
  }, [displayItems, myChains, lineCentsAt]);

  // platte lijst: altijd gesorteerd op supermarkt (owner 2026-07-13 default)
  const flatItems = useMemo(() => {
    const rank = (it: ItemRow) => {
      const c = chosenChainOf(it, myChains);
      if (!c) return 99;
      const i = myChains.indexOf(c);
      return i === -1 ? 98 : i;
    };
    return [...displayItems].sort((a, b) => rank(a) - rank(b));
  }, [displayItems, myChains]);

  // Supermarktkaarten tonen pas een prijs wanneer de gebruiker voor iedere
  // regel zelf een product in die winkel koos. Automatische matcherregels zijn
  // hier bewust volledig onzichtbaar en tellen nooit mee.
  const storeCards = useMemo(() => myChains.map((chain) => {
    let total = 0;
    let missing = 0;
    let unpriced = 0;
    for (const item of openItems) {
      if (!reusableChainChoice(item.matches, chain)) {
        missing++;
        continue;
      }
      const cents = lineCentsAt(item, chain);
      if (cents == null) unpriced++;
      else total += cents;
    }
    return {
      chain_id: chain,
      total_cents: total,
      complete: openItems.length > 0 && missing === 0 && unpriced === 0,
    };
  }), [myChains, openItems, lineCentsAt]);

  // Goedkoopste prakkie vergelijkt uitsluitend de concrete keuzes die de user
  // al heeft gemaakt. Zodra er een volledig geprijsd totaal is, blijft deze
  // optie beschikbaar: initiële lijst, één supermarkt, of mix over winkels.
  const cheapestSplit = useMemo<CheapestPlan | null>(() => {
    if (openItems.length === 0) return null;
    let total = 0;
    let missing = 0;
    const counts = new Map<string, number>();
    const choices = new Map<string, { chain: string; cents: number }>();
    for (const item of openItems) {
      let best: { chain: string; cents: number } | null = null;
      for (const chain of myChains) {
        if (!reusableChainChoice(item.matches, chain)) continue;
        const cents = lineCentsAt(item, chain);
        if (cents != null && (!best || cents < best.cents)) best = { chain, cents };
      }
      if (!best) { missing++; continue; }
      total += best.cents;
      counts.set(best.chain, (counts.get(best.chain) ?? 0) + 1);
      choices.set(item.id, best);
    }
    return missing === 0 ? { total, counts, choices, missing: 0 } : null;
  }, [openItems, myChains, lineCentsAt]);

  const cheapestPlanIsActive = !!cheapestSplit && openItems.every((item) =>
    cheapestSplit.choices.get(item.id)?.chain === chosenChainOf(item, myChains)
  );


  async function toggle(item: ItemRow) {
    // afvinken is winkel-modus: direct, tenzij er al een concept openstaat
    if (hasDraft || !items.some((i) => i.id === item.id)) {
      mutateDraft((rows) => rows.map((r) => (r.id === item.id ? { ...r, checked: !r.checked } : r)));
      return;
    }
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, checked: !item.checked }, item.id);
    syncNow(['list_items']).catch(() => {});
  }

  /** productkeuze (cross-chain): producttitel wordt de itemnaam, keuze in concept. */
  function pinProduct(item: ItemRow, option: CrossChainOption) {
    setSelectedStoreCard(null);
    const matches: Record<string, MatchEntry> = {};
    const unitCents = option.promo_price_cents ?? option.price_cents;
    matches[option.chain] = {
      sku_id: option.sku_id, confidence: 1, user_pinned: true, preferred: true,
      origin: 'user_confirmed', matcher_version: 'manual', unit_cents: unitCents,
      product_name: option.name,
      image_url: option.image_url,
      pack_size_value: option.pack_size_value,
      pack_size_unit: option.pack_size_unit,
      unit_price_cents_per_std: option.unit_price_cents_per_std,
      std_unit: option.std_unit,
      ...(isCount(item) ? { selected_qty: countQty(item) } : {}),
    };
    // de producttitel wordt de zichtbare naam, maar de mátchterm richting andere
    // ketens blijft de kale ingrediëntterm — nooit een brand-titel (owner 2026-07-07:
    // "AH volle melk" mag bij Jumbo niet via de AH-titel gematcht worden)
    const cleanTerm = item.item_normalised ?? item.name;
    mutateDraft((rows) =>
      rows.map((r) =>
        r.id === item.id
          ? {
              ...r,
              name: option.name,
              item_normalised: cleanTerm,
              matches,
              _alt_cents: { [option.chain]: unitCents },
            }
          : r
      )
    );
    setDraftCorrections((c) => [
      ...c,
      {
        chain_id: option.chain,
        item_normalised: item.item_normalised ?? item.name.toLowerCase(),
        chosen_sku_id: option.sku_id,
      },
    ]);
    setDetailItem(null);
  }

  /** owner: prullenbakje per regel — in het concept, dus altijd te annuleren */
  function removeItemRow(item: ItemRow) {
    mutateDraft((rows) => rows.filter((r) => r.id !== item.id));
    if (detailItem?.id === item.id) setDetailItem(null);
  }

  /** "Goedkoopste prakkie" → pas per item de goedkoopste betrouwbare keten toe. */
  function convertToSplit() {
    if (cheapestPlanIsActive) {
      setSelectedStoreCard(uniformStoreCard);
      return;
    }
    setSelectedStoreCard(null);
    mutateDraft((rows) =>
      rows.map((r) => {
        const best = cheapestSplit?.choices.get(r.id);
        if (!best) return r;
        const restore = restorePointFor(r);
        const matches: Record<string, MatchEntry> = {};
        for (const [c, entry] of Object.entries(r.matches ?? {})) {
          matches[c] = {
            ...entry,
            preferred: c === best.chain && !!reusableChainChoice(r.matches, c),
            ...(c === best.chain && !entry.restore ? { restore } : {}),
          };
        }
        return { ...r, matches, name: matches[best.chain]?.product_name ?? r.name };
      })
    );
  }

  /** Activeer een reeds volledig handmatig samengesteld winkelmandje. */
  function activateStoreComposition(chain: string) {
    mutateDraft((rows) => rows.map((item) => {
      if (item.checked || !reusableChainChoice(item.matches, chain)) return item;
      const restore = restorePointFor(item);
      const matches = Object.fromEntries(Object.entries(item.matches ?? {}).map(([key, entry]) => [
        key,
        {
          ...entry,
          preferred: key === chain && !!reusableChainChoice(item.matches, key),
          ...(key === chain && !entry.restore ? { restore } : {}),
        },
      ])) as Record<string, MatchEntry>;
      return { ...item, matches, name: matches[chain]?.product_name ?? item.name };
    }));
    setSelectedStoreCard(chain);
  }

  async function loadSubstitutionPreview(chain: string) {
    if (!list) return;
    setSubstitutionChain(chain);
    setPreviewStep(0);
    setPreviewChoices({});
    setPreviewQty({});
    setStagedPickSku(null);
    setPickerCatalogSearch('');
    setPickerCatalogResults(null);
    const cached = getCachedPreview(list.id, chain, SUBSTITUTION_POLICY);
    if (cached) {
      setSubstitutionLoading(false);
      setSubstitutionPreview(cached);
      return;
    }
    setSubstitutionPreview(null);
    setSubstitutionLoading(true);
    try {
      const preview = await loadCachedPreview(list.id, chain, SUBSTITUTION_POLICY);
      if (!preview) throw new Error('preview niet in sessie-cache');
      setSubstitutionPreview(preview);
    } catch {
      setSubstitutionChain(null);
      notice('Voorstel niet geladen', 'Open Boodschappen en probeer de eenmalige voorbereiding opnieuw.');
    } finally {
      setSubstitutionLoading(false);
    }
  }

  function closeSubstitutionPreview() {
    setSubstitutionChain(null);
    setSubstitutionPreview(null);
    setPreviewStep(0);
    setPreviewChoices({});
    setPreviewQty({});
    setStagedPickSku(null);
    setStagedQty(null);
    setPickerCatalogSearch('');
    setPickerCatalogSort('aanbevolen');
    setPickerCatalogResults(null);
    setPickerCatalogLoading(false);
    setPickerCategory(null);
    setPickerCategoryError(null);
  }

  /** Naar het volgende product; na het laatste product meteen toepassen en
   *  terug naar de lijst. Er is bewust geen extra bevestigingsscherm. */
  function advancePreviewStep(applyOptions?: ApplySubstitutionOptions) {
    setStagedPickSku(null);
    setStagedQty(null);
    setPickerCatalogSearch('');
    setPickerCatalogResults(null);
    if (previewStep < previewReviewLines.length - 1) setPreviewStep(previewStep + 1);
    else void applySubstitutionPreview(applyOptions);
  }

  function retreatPreviewStep() {
    if (previewStep <= 0) return;
    setStagedPickSku(null);
    setStagedQty(null);
    setPickerCatalogSearch('');
    setPickerCatalogResults(null);
    setPreviewStep(previewStep - 1);
  }

  function choosePreviewOption(itemId: string, option: ProductOption, qty?: number | null) {
    setPreviewChoices((current) => ({ ...current, [itemId]: option }));
    setPreviewQty((current) => {
      if (qty == null) {
        const { [itemId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [itemId]: qty };
    });
  }

  /** Pas uitsluitend producten toe waarop de gebruiker zelf heeft getikt. */
  async function applySubstitutionPreview(options: ApplySubstitutionOptions = {}) {
    if (saveInFlight.current) return;
    const preview = options.preview ?? substitutionPreview;
    const chain = options.chain ?? substitutionChain;
    const choices = options.choices ?? previewChoices;
    const quantities = options.quantities ?? previewQty;
    if (!preview || !chain) return;
    const previewLines = new Map(preview.lines.map((line) => [line.item_id, line]));
    const applicable = new Map<string, {
      line: PricedLine;
      reviewed: ProductOption;
    }>();
    for (const item of displayItems) {
      const line = previewLines.get(item.id);
      if (!line) continue;
      const reviewed = choices[item.id];
      if (reviewed) applicable.set(item.id, { line, reviewed });
    }
    const feedback: SubstitutionFeedback[] = [...applicable].map(([itemId, { reviewed }]) => ({
      item_id: itemId, chain_id: chain, candidate_sku_id: reviewed.sku_id, policy: preview.policy,
      action: 'user_confirmed', reliability: 1,
      reasons: ['handmatig gekozen in categorie'],
      matcher_version: preview.matcher_version ?? 'manual-category-v1',
    }));
    const corrections: Correction[] = displayItems.flatMap((item) => {
      const reviewed = applicable.get(item.id)?.reviewed;
      return reviewed
        ? [{ chain_id: chain, item_normalised: item.item_normalised ?? item.name.toLowerCase(), chosen_sku_id: reviewed.sku_id }]
        : [];
    });
    const nextRows = displayItems.map((r) => {
      const selected = applicable.get(r.id);
      if (!selected) return r;
      const { reviewed } = selected;
      const restore = restorePointFor(r);
      const matches: Record<string, MatchEntry> = {};
      for (const [c, entry] of Object.entries(r.matches ?? {})) {
        matches[c] = withoutPreferredForSwitch(entry, r);
      }
      const unitCents = reviewed.promo_price_cents ?? reviewed.price_cents;
      const chosenQty = isCount(r) ? quantities[r.id] ?? countQty(r) : undefined;
      const productName = reviewed.name;
      matches[chain] = {
        ...(r.matches?.[chain] ?? {}),
        sku_id: reviewed.sku_id,
        confidence: 1,
        user_pinned: true,
        preferred: true,
        origin: 'user_confirmed',
        policy: preview.policy,
        matcher_version: 'manual-category-v1',
        product_name: productName,
        image_url: reviewed.image_url,
        pack_size_value: reviewed.pack_size_value,
        pack_size_unit: reviewed.pack_size_unit,
        unit_price_cents_per_std: reviewed.unit_price_cents_per_std,
        std_unit: reviewed.std_unit,
        ...(chosenQty != null ? { selected_qty: chosenQty } : {}),
        restore,
        unit_cents: unitCents,
      };
      return {
        ...r,
        matches,
        name: productName ?? r.name,
        _alt_cents: { ...(r._alt_cents ?? {}), [chain]: unitCents },
      };
    });
    const nextFeedback = [...substitutionFeedback, ...feedback];
    const nextCorrections = [...draftCorrections, ...corrections];

    // Toon de voltooide samenstelling meteen, maar schrijf exact dezelfde
    // snapshot ook direct local-first weg. Zo blijven eerder samengestelde
    // ketens in `matches` behouden wanneer de gebruiker daarna naar AH/Jumbo
    // wisselt, de app sluit of tijdelijk offline gaat.
    setDraftItems(nextRows);
    setSubstitutionFeedback(nextFeedback);
    setDraftCorrections(nextCorrections);
    setSelectedStoreCard(chain);
    saveInFlight.current = true;
    setSavingDraft(true);
    try {
      const { feedbackSynced } = await persistDraftSnapshot(nextRows, nextCorrections, nextFeedback);
      clearPersistedDraftState(nextRows, nextCorrections, nextFeedback, feedbackSynced);
    } catch {
      notice(
        'Automatisch opslaan niet gelukt',
        'Je supermarktkeuzes staan nog als concept klaar. Tik op “Sla deze lijst op” om het opnieuw te proberen.'
      );
    } finally {
      saveInFlight.current = false;
      setSavingDraft(false);
      closeSubstitutionPreview();
    }
  }

  /** One-tap undo for the active Alles bij / Goedkoopste prakkie choice. The
   *  composed supermarket alternatives stay available for later switching. */
  function restoreOriginalChoices() {
    setSelectedStoreCard(null);
    if (!hasOriginalChoices) return;

    mutateDraft((rows) => rows.map((row) => {
      const restore = restorePointOf(row);
      if (!restore) return row;
      const matches: Record<string, MatchEntry> = {};
      const altCents = { ...(row._alt_cents ?? {}) };
      for (const [chain, entry] of Object.entries(row.matches ?? {})) {
        const { preferred: _preferred, restore: _restore, ...rest } = entry;
        matches[chain] = rest;
      }
      if (restore.chain_id && restore.match) {
        matches[restore.chain_id] = {
          ...restore.match,
          preferred: true,
          ...(restore.unit_cents != null && restore.match.unit_cents == null
            ? { unit_cents: restore.unit_cents }
            : {}),
        };
        if (restore.unit_cents != null) altCents[restore.chain_id] = restore.unit_cents;
      }
      return {
        ...row,
        name: restore.product_name,
        quantity: restore.quantity ?? row.quantity,
        item_normalised: restore.item_normalised ?? null,
        matches,
        _alt_cents: altCents,
      };
    }));
    closeSubstitutionPreview();
    setDetailItem(null);
  }

  function renameItem(item: ItemRow) {
    const next = nameDraft.trim();
    if (!next || next === item.name) return;
    setSelectedStoreCard(null);
    const renamed = (row: ItemRow): ItemRow => ({
      ...row,
      name: next,
      item_normalised: null,
      matches: {},
      _alt_cents: {},
    });
    mutateDraft((rows) => rows.map((r) => (r.id === item.id ? renamed(r) : r)));
    setDetailItem((d) => (d && d.id === item.id ? renamed(d) : d));
  }

  function bumpQty(item: ItemRow, delta: number) {
    const chain = chosenChainOf(item, myChains);
    const chainQty = isCount(item) && chain ? item.matches?.[chain]?.selected_qty : undefined;
    const current = (chainQty ?? Number(item.quantity)) || 1;
    const next = Math.max(1, Math.round((current + delta) * 100) / 100);
    const applyQty = (row: ItemRow): ItemRow => {
      if (isCount(row) && chain && row.matches?.[chain]) {
        return {
          ...row,
          matches: {
            ...row.matches,
            [chain]: { ...row.matches[chain]!, selected_qty: next },
          },
        };
      }
      return { ...row, quantity: next };
    };
    mutateDraft((rows) => rows.map((r) => (r.id === item.id ? applyQty(r) : r)));
    setDetailItem((d) => (d && d.id === item.id ? applyQty(d) : d));
  }

  const DEFAULT_LIST_NAME = 'Mijn boodschappen';

  /** owner 2026-07-14: Opslaan vraagt nu altijd een naam — vervangt de kale
   *  "Opslaan"-knop. Al eerder een echte naam gegeven? Dan staat die voorgevuld,
   *  zodat een volgende keer opslaan één tik blijft i.p.v. opnieuw typen. */
  function openSaveDraftSheet() {
    setDraftSaveName(list && list.name !== DEFAULT_LIST_NAME ? list.name : '');
    setSheet('saveDraft');
  }

  async function confirmSaveDraft() {
    if (!list) return;
    const name = draftSaveName.trim() || list.name || DEFAULT_LIST_NAME;
    if (name !== list.name) await upsertRow('lists', { name }, list.id);
    setSheet('none');
    await saveDraft();
  }

  /** Schrijf één onveranderlijke conceptsnapshot local-first weg. Zowel de
   *  gewone Opslaan-knop als een afgeronde Stel samen-wizard gebruikt dit pad. */
  async function persistDraftSnapshot(
    rows: ItemRow[],
    corrections: Correction[],
    feedback: SubstitutionFeedback[]
  ): Promise<{ feedbackSynced: boolean }> {
    if (!list) throw new Error('Geen actieve boodschappenlijst');
    const savedDescriptors = shoppingItemDescriptors(rows);
    const savedRevision = savedDescriptors.map((item) => item.fingerprint).sort().join('|');
    const base = new Map(items.map((i) => [i.id, i]));
    for (const row of rows) {
      const stored = base.get(row.id);
      base.delete(row.id);
      const fields = itemFields(row);
      if (!stored || JSON.stringify(itemFields(stored)) !== JSON.stringify(fields)) {
        await upsertRow('list_items', fields, row.id);
      }
    }
    for (const gone of base.keys()) await deleteRow('list_items', gone);
    for (const correction of corrections) {
      await upsertRow('match_corrections', correction as unknown as Record<string, unknown>);
    }
    await syncNow(['list_items', 'match_corrections']).catch(() => {});

    let feedbackSynced = feedback.length === 0;
    if (feedback.length) {
      const feedbackRes = await authedRequest(`/v1/lists/${list.id}/substitution-feedback`, {
        method: 'POST', body: JSON.stringify({ events: feedback }),
      }).catch(() => null);
      feedbackSynced = !!feedbackRes?.ok;
    }

    // Een inhoudelijke wijziging is de enige uitzondering op de immutable
    // sessiebundel: bouw precies één nieuwe scope en houd alle tabstanden
    // opnieuw samen in geheugen.
    void warmShoppingSession({
      listId: list.id,
      chains: myChains,
      revision: savedRevision,
      items: savedDescriptors,
    });
    return { feedbackSynced };
  }

  /** Wis alleen de snapshot die daadwerkelijk is opgeslagen. Als de gebruiker
   *  tijdens het opslaan alweer iets wijzigde, blijft dat nieuwere concept staan. */
  function clearPersistedDraftState(
    rows: ItemRow[],
    corrections: Correction[],
    feedback: SubstitutionFeedback[],
    feedbackSynced: boolean
  ) {
    setDraftItems((current) => current === rows ? null : current);
    setDraftCorrections((current) => current.filter((entry) => !corrections.includes(entry)));
    if (feedbackSynced) {
      setSubstitutionFeedback((current) => current.filter((entry) => !feedback.includes(entry)));
    }
  }

  /** Opslaan: het concept wordt de waarheid — diff tegen de opgeslagen staat. */
  async function saveDraft() {
    if (!draftItems || !list || saveInFlight.current) return;
    const rows = draftItems;
    const corrections = draftCorrections;
    const feedback = substitutionFeedback;
    saveInFlight.current = true;
    setSavingDraft(true);
    try {
      const { feedbackSynced } = await persistDraftSnapshot(rows, corrections, feedback);
      clearPersistedDraftState(rows, corrections, feedback, feedbackSynced);
    } catch {
      notice('Opslaan mislukt', 'Je wijzigingen staan nog als concept klaar. Probeer het opnieuw.');
    } finally {
      saveInFlight.current = false;
      setSavingDraft(false);
    }
  }

  function cancelDraft() {
    setDraftItems(null);
    setDraftCorrections([]);
    setSubstitutionFeedback([]);
    setDetailItem(null);
  }

  /** delen (owner 2026-07-07): met het hele huishouden (household_id) óf met
   *  losse huisgenoten (shared_with). Wie 'm ziet kan meeschrijven — afvinken
   *  en items syncen live via de gewone sync. */
  async function toggleShareHousehold() {
    if (!list) return;
    const hh = await activeHouseholdId();
    if (!hh) {
      notice('Nog geen groep', 'Maak eerst een groep aan op je Profiel — dan kun je lijsten delen.');
      return;
    }
    await upsertRow('lists', { household_id: list.household_id ? null : hh }, list.id);
    syncNow(['lists']).catch(() => {});
  }

  async function toggleShareMember(userId: string) {
    if (!list) return;
    const cur = (list.shared_with ?? []).filter(Boolean);
    const next = cur.includes(userId) ? cur.filter((u) => u !== userId) : [...cur, userId];
    await upsertRow('lists', { shared_with: next }, list.id);
    syncNow(['lists']).catch(() => {});
  }

  /** bewaar het huidige lijstje als favoriet (lijst zonder datum) */
  async function saveTemplate() {
    const name = templateName.trim() || list?.name || 'Mijn lijstje';
    if (displayItems.length === 0) return;
    const id = newId();
    await upsertRow('lists', { name, household_id: await activeHouseholdId() }, id);
    for (const it of displayItems) {
      await upsertRow('list_items', { ...itemFields({ ...it, list_id: id, checked: false }) }, newId());
    }
    setSheet('none');
    setTemplateName('');
    syncNow(['lists', 'list_items']).catch(() => {});
    notice('Lijstje bewaard', `“${name}” staat bij je opgeslagen lijstjes.`);
  }

  const initialOf = (userId: string | null | undefined) =>
    (memberName(members, userId) ?? '?').slice(0, 1).toUpperCase();
  // echte supermarkt-logo's i.p.v. initialen (owner 2026-07-07)
  const chainDot = (c: string, size = 18) => <ChainLogo id={c} size={size} />;

  // keten-pill zoals in de mockup: lichte merk-tint met merk-kleurige naam.
  // Lichte merkkleuren (Jumbo-geel) krijgen donkere tekst voor leesbaarheid.
  const LIGHT_BRAND_TEXT: Record<string, string> = { jumbo: '#8A6D00', dekamarkt: '#8A5410' };
  const chainPill = (c: string) => {
    const brand = CHAIN_BRAND[c] ?? { bg: '#75816F', fg: '#FFFFFF' };
    return (
      <View style={[styles.chainPillWrap, { backgroundColor: `${brand.bg}1C` }]}>
        <Text style={[styles.chainPillText, { color: LIGHT_BRAND_TEXT[c] ?? brand.bg }]}>{chainName(c)}</Text>
      </View>
    );
  };

  const itemRowView = (item: ItemRow, idx: number, groupChain: string | null, count: number, showChain = false) => {
    const chain = chosenChainOf(item, myChains);
    const cents = chain && !item.checked ? lineCentsAt(item, chain) : null;
    const displayCents = cents;
    const displayChain = chain;
    const line = chain ? linesByChain.get(chain)?.get(item.id) : undefined;
    const promoActive = !!line?.promo && (line?.promo_savings_cents ?? 0) > 0;
    const recipes = (item.provenance ?? []).map((p) => p.recipe_title ?? p.title).filter(Boolean);
    // de échte productnaam van de gekozen keten (owner 2026-07-08) — MAAR de
    // server-prijsregel mag alleen de naam leveren als hij bij hetzélfde
    // product hoort: na een wissel in het concept (wit → bruin brood) is de
    // regel nog van het oude product en zou de oude naam blijven staan terwijl
    // de prijs al meebewoog (owner-bug 2026-07-10).
    const pinnedSku = chain ? item.matches?.[chain]?.sku_id : undefined;
    const lineNameFresh = line?.matched && line.product_name && (!pinnedSku || line.sku_id === pinnedSku);
    const displayName = (!item.checked && lineNameFresh && line!.product_name) || item.name;
    const selectedPackQty = displayChain ? item.matches?.[displayChain]?.selected_qty : undefined;
    const qty = Math.max(1, Math.round((selectedPackQty ?? Number(item.quantity)) || 1));
    // productfoto + pack-meta van de gekozen sku (owner-mockup 2026-07-14)
    const product = lineProductFor(item, displayChain);
    const pack = product ? packLabel(product) : null;
    const metaParts = [
      qty > 1 ? `${qty}×` : null,
      item.unit && item.unit !== 'st' && item.unit !== 'stuks' ? `${String(item.quantity ?? '').replace('.', ',')} ${item.unit}` : null,
      pack?.split(' · ')[0] ?? null,
    ].filter(Boolean);
    return (
      <View key={item.id} style={[styles.itemCard, item.checked && { opacity: 0.55 }]}>
        <Pressable onPress={() => toggle(item)} hitSlop={6} accessibilityLabel={`Vink ${displayName} af`}>
          <View style={[styles.checkbox, item.checked && styles.checkboxOn]}>
            {item.checked ? <Check size={12} color={colors.onPrimary} strokeWidth={3} /> : null}
          </View>
        </Pressable>
        {product?.image_url ? (
          <Image
            source={{ uri: product.image_url }}
            style={styles.itemThumb}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={product.sku_id}
            transition={120}
          />
        ) : (
          <View style={[styles.itemThumb, styles.itemThumbEmpty]} />
        )}
        <Pressable style={{ flex: 1, minWidth: 0, gap: 2 }} onPress={() => setDetailItem(item)}>
          <Text style={[styles.itemName, item.checked && styles.checkedText]} numberOfLines={2}>
            {displayName}
          </Text>
          {metaParts.length ? (
            <Text style={styles.subline} numberOfLines={1}>{metaParts.join(' · ')}</Text>
          ) : null}
          <View style={styles.itemBadgeRow}>
            {members.length > 1 && item.added_by ? (
              <View style={styles.byChip}>
                <Text style={styles.byChipText}>{initialOf(item.added_by)}</Text>
              </View>
            ) : null}
            {recipes.length > 1 ? <Text style={styles.mergedBadge}>{recipes.length} recepten</Text> : null}
            {promoActive && !item.checked ? <Text style={styles.bonusBadge}>Bonus</Text> : null}
          </View>
        </Pressable>
        <Pressable onPress={() => setDetailItem(item)} hitSlop={8} style={styles.itemRight}>
          {displayChain ? chainPill(displayChain) : null}
          {displayCents != null ? (
            <Text style={[styles.price, item.checked && { color: '#B9C0B2' }]}>
              {formatEuroCents(displayCents)}
            </Text>
          ) : !item.checked ? (
            <Text style={styles.priceLoading}>Nog niet samengesteld</Text>
          ) : null}
        </Pressable>
      </View>
    );
  };

  const currentOriginalChain = currentPickerSourceChain;
  const currentOriginalProduct = currentPickerAnchorProduct;
  const selectablePreviewOptions = pickerCatalogResults ?? [];
  // Geen voorselectie: alleen een product waarop de user echt tikt telt.
  const currentPreviewChoice = currentPreviewLine
    ? selectablePreviewOptions.find((o) => o.sku_id === stagedPickSku)
      ?? previewChoices[currentPreviewLine.item_id]
      ?? null
    : null;
  // Begin altijd bij het bestaande lijst-aantal. Een kleiner alternatief leidt
  // nooit automatisch tot 2×/3×; alleen de gebruiker verhoogt de stepper.
  const previewQtyApplies = !!currentPreviewItem && isCount(currentPreviewItem);
  const currentPreviewMinQty = 1;
  const preferredPreviewQty = stagedQty
    ?? (currentPreviewLine && previewChoices[currentPreviewLine.item_id]?.sku_id === currentPreviewChoice?.sku_id
      ? previewQty[currentPreviewLine.item_id]
      : undefined)
    ?? (currentPreviewItem ? countQty(currentPreviewItem) : 1);
  const currentPreviewQty = Math.max(currentPreviewMinQty, preferredPreviewQty);
  const currentOriginalPackLabel = currentOriginalProduct ? packLabel(currentOriginalProduct) : null;
  const currentOriginalPriceCents = currentPreviewItem && currentOriginalChain
    ? lineCentsAt(currentPreviewItem, currentOriginalChain)
      ?? (currentOriginalProduct ? optionLineCents(currentPreviewItem, currentOriginalProduct) : null)
    : null;
  const isLastPreviewStep = previewStep >= previewReviewLines.length - 1;
  const previewProgressPercent = previewReviewLines.length > 0
    ? Math.min(100, ((previewStep + 1) / previewReviewLines.length) * 100)
    : 0;
  const canContinuePreview = currentPreviewChoice !== null;

  const saveExplicitCurrentChoice = () => {
    if (
      currentPreviewLine && currentPreviewChoice &&
      (stagedPickSku !== null || stagedQty !== null)
    ) {
      choosePreviewOption(
        currentPreviewLine.item_id,
        currentPreviewChoice,
        previewQtyApplies ? currentPreviewQty : null
      );
    }
  };

  const goToPreviousPreview = () => {
    saveExplicitCurrentChoice();
    retreatPreviewStep();
  };

  const goToNextPreview = () => {
    if (!currentPreviewLine || !canContinuePreview) return;
    let choices = previewChoices;
    let quantities = previewQty;
    if (currentPreviewChoice) {
      choices = { ...previewChoices, [currentPreviewLine.item_id]: currentPreviewChoice };
      if (previewQtyApplies) {
        quantities = { ...previewQty, [currentPreviewLine.item_id]: currentPreviewQty };
      }
      choosePreviewOption(
        currentPreviewLine.item_id,
        currentPreviewChoice,
        previewQtyApplies ? currentPreviewQty : null
      );
    }
    advancePreviewStep({ choices, quantities });
  };

  const visiblePickerOptions = pickerCatalogResults ?? [];
  const cheapestSplitMeta = cheapestSplit
    ? [...cheapestSplit.counts.entries()]
        .sort(([a], [b]) => myChains.indexOf(a) - myChains.indexOf(b))
        .map(([chain, count]) => `${count}× ${chainName(chain)}`)
        .join(' · ')
    : '';
  const shimmerTranslateX = prakkieShimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-180, 560],
  });
  const sparkleOpacity = prakkieShimmer.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.45, 1, 0.45],
  });
  const sparkleScale = prakkieShimmer.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.88, 1.12, 0.88],
  });
  const detailChain = detailItem ? chosenChainOf(detailItem, myChains) : null;
  const detailDisplayedQty = detailItem
    ? (isCount(detailItem) && detailChain ? detailItem.matches?.[detailChain]?.selected_qty : undefined)
      ?? detailItem.quantity
      ?? 1
    : 1;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 14 }]}>
      {/* flow-header (owner-mockup 2026-07-14): terug · gecentreerde titel ·
          potlood (hernoemen) · zoeken. Overige acties staan in de rij eronder. */}
      <View style={styles.flowHeader}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/boodschappen'))}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Terug"
          style={styles.backBtn}
        >
          <ChevronLeft size={20} color={colors.text} strokeWidth={2.4} />
        </Pressable>
        <Text style={styles.flowTitle} numberOfLines={1}>
          {list?.name && list.name !== 'Mijn boodschappen' ? list.name : 'Mijn boodschappenlijst'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
          <Pressable onPress={openSaveDraftSheet} hitSlop={8} accessibilityLabel="Lijst hernoemen">
            <Pencil size={17} color={colors.text} strokeWidth={2} />
          </Pressable>
          <Pressable onPress={() => router.push('/store/zoeken')} hitSlop={8} accessibilityLabel="Producten zoeken">
            <Search size={18} color={colors.text} strokeWidth={2.1} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {(
          <>
            {/* uitbreiden = winkelen: terug de winkel in (owner 2026-07-13,
                categorie-browsing is dé samenstel-weg) */}
            <View style={styles.resultControls}>
              <Pressable
                onPress={() => router.push('/(tabs)/boodschappen')}
                style={styles.backToListBtn}
                accessibilityRole="button"
                accessibilityLabel="Producten toevoegen"
              >
                <Plus size={13} color={colors.primary} strokeWidth={2.6} />
                <Text style={styles.backToListText}>toevoegen</Text>
              </Pressable>
              {templates.length > 0 ? (
                <Pressable
                  onPress={() => setSheet('load')}
                  style={styles.backToListBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Opgeslagen lijstjes"
                >
                  <Bookmark size={12} color={colors.primary} strokeWidth={2.4} />
                  <Text style={styles.backToListText}>lijstjes</Text>
                </Pressable>
              ) : null}
              <View style={{ flex: 1 }} />
              {displayItems.length > 0 ? (
                <Pressable
                  onPress={() => { setTemplateName(''); setSheet('save'); }}
                  hitSlop={8}
                  accessibilityLabel="Bewaar dit lijstje"
                >
                  <BookmarkPlus size={17} color={colors.primary} strokeWidth={2} />
                </Pressable>
              ) : null}
              {list ? (
                <Pressable onPress={() => setSheet('share')} hitSlop={8} accessibilityLabel="Lijst delen">
                  <Share2
                    size={16}
                    color={list.household_id || (list.shared_with ?? []).length ? colors.primary : '#B9C0B2'}
                    strokeWidth={2}
                  />
                </Pressable>
              ) : null}
              {displayItems.length > 0 ? (
                <Pressable onPress={clearList} hitSlop={8} accessibilityLabel="Leeg de lijst">
                  <Trash2 size={16} color={colors.danger} strokeWidth={2} />
                </Pressable>
              ) : null}
            </View>

            {/* Een prijs verschijnt pas nadat de user dit mandje zelf volledig
                heeft samengesteld. Geen stil matcheradvies in deze kaarten. */}
            {displayItems.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.bleedRow}
                contentContainerStyle={styles.chainCardRow}
              >
                {storeCards.map((s) => {
                  const isSelected = activeStoreCard === s.chain_id;
                  return (
                    <Pressable
                      key={s.chain_id}
                      onPress={() => s.complete
                        ? activateStoreComposition(s.chain_id)
                        : loadSubstitutionPreview(s.chain_id)}
                      style={[styles.chainCard, isSelected && styles.chainCardSelected]}
                      accessibilityRole="button"
                      accessibilityLabel={s.complete
                        ? `${chainName(s.chain_id)} samengesteld, ${formatEuroCents(s.total_cents)}`
                        : `Stel ${chainName(s.chain_id)} samen`}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <View style={styles.chainCardHeader}>
                        <ChainLogo id={s.chain_id} size={22} />
                        <Text style={styles.chainCardName} numberOfLines={1}>{chainName(s.chain_id)}</Text>
                      </View>
                      {s.complete ? (
                        <Text style={[styles.chainCardPrice, isSelected && { color: colors.primary }]}>
                          {formatEuroCents(s.total_cents)}
                        </Text>
                      ) : (
                        <View style={styles.composeStoreButton}>
                          <Text style={styles.composeStoreButtonText}>Stel samen</Text>
                        </View>
                      )}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            <Text style={styles.metaLine}>
              {displayItems.length} {displayItems.length === 1 ? 'artikel' : 'artikelen'}
              {checkedCount > 0 ? ` · ${checkedCount} afgevinkt` : ''}
              {lastAdded ? ` · laatst: ${lastAdded.who} — ${lastAdded.what}` : ''}
            </Text>

            {/* eerste inlaadslag (koud, nog geen prijzen): een balk in plaats
                van een leeg scherm dat op vastlopen lijkt (owner 2026-07-21) */}
            {displayItems.length > 0 && !pricing &&
             shoppingCache.status === 'warming' && shoppingCache.listId === list?.id ? (
              <LoadingBar label="Prijzen en producten voorbereiden…" />
            ) : null}

            {/* matching v2 (Fase 5): direct cross-supermarkt totaal + optimizer */}
            {displayItems.length > 0 ? <CrossChainTotal plan={basketPlan} /> : null}

            {displayItems.length === 0 ? (
              <View style={{ alignItems: 'center', gap: 12, marginTop: 30 }}>
                <Text style={type.meta}>Nog niets op de lijst.</Text>
                <Pressable onPress={() => router.push('/(tabs)/boodschappen')}>
                  <Text style={[type.body, { color: colors.primary, fontFamily: fonts.bodySemiBold }]}>
                    Blader door de winkel →
                  </Text>
                </Pressable>
              </View>
            ) : !showSubtotals ? (
              /* standaard: één platte lijst — losse kaarten met keten-pill per
                 regel (owner-mockup 2026-07-14) */
              <View style={styles.itemCardList}>
                {flatItems.map((item, idx) => itemRowView(item, idx, null, flatItems.length, true))}
              </View>
            ) : (
              chainGroups.map(({ chain, items: groupItems, subtotal, priced }) => (
                <View key={chain ?? 'none'}>
                  <View style={styles.groupHeader}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                      {chain ? chainDot(chain, 19) : null}
                      <Text style={[styles.groupTitle, !chain && { color: colors.textMuted2 }]}>
                        {chain ? chainName(chain).toUpperCase() : 'NOG TE KIEZEN'}
                      </Text>
                    </View>
                    {chain && priced > 0 ? (
                      <Text style={styles.groupSubtotal}>{formatEuroCents(subtotal)}</Text>
                    ) : null}
                  </View>
                  <View style={styles.itemCardList}>
                    {groupItems.map((item, idx) => itemRowView(item, idx, chain, groupItems.length))}
                  </View>
                </View>
              ))
            )}

            {hasOriginalChoices ? (
              <Pressable
                onPress={restoreOriginalChoices}
                style={styles.restoreChoicesButton}
                accessibilityRole="button"
                accessibilityLabel="Herstel mijn oorspronkelijke product- en supermarktkeuzes"
              >
                <View style={styles.restoreChoicesIcon}>
                  <RotateCcw size={17} color={colors.primary} strokeWidth={2.4} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.restoreChoicesTitle}>Herstel eigen keuzes</Text>
                  <Text style={styles.restoreChoicesText}>Zet alles terug naar vóór ‘Alles bij’ of ‘Goedkoopste prakkie’.</Text>
                </View>
              </Pressable>
            ) : null}

            {cheapestSplit ? (
              <Pressable
                onPress={convertToSplit}
                style={({ pressed }) => [styles.cheapestPrakkieWrap, pressed && styles.cheapestPrakkiePressed]}
                accessibilityRole="button"
                accessibilityLabel={`Goedkoopste prakkie, ${formatEuroCents(cheapestSplit.total)}, ${cheapestSplitMeta}`}
              >
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.cheapestSparkle,
                    styles.cheapestSparkleTop,
                    { opacity: sparkleOpacity, transform: [{ scale: sparkleScale }] },
                  ]}
                >
                  <Sparkles size={19} color="#DDBB62" strokeWidth={2.1} />
                </Animated.View>
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.cheapestSparkle,
                    styles.cheapestSparkleBottom,
                    { opacity: sparkleOpacity, transform: [{ scale: sparkleScale }] },
                  ]}
                >
                  <Star size={13} color="#F2D68B" fill="#F2D68B" strokeWidth={1.8} />
                </Animated.View>
                <LinearGradient
                  colors={['#173D25', '#2A5F38', '#6E5B22', '#2F6C42']}
                  locations={[0, 0.42, 0.72, 1]}
                  start={{ x: 0, y: 0.15 }}
                  end={{ x: 1, y: 0.85 }}
                  style={styles.cheapestPrakkieGradient}
                >
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.cheapestPrakkieShimmer,
                      { transform: [{ translateX: shimmerTranslateX }, { skewX: '-16deg' }] },
                    ]}
                  >
                    <LinearGradient
                      colors={['rgba(255,255,255,0)', 'rgba(255,255,255,.28)', 'rgba(255,255,255,0)']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={StyleSheet.absoluteFill}
                    />
                  </Animated.View>
                  <View style={styles.cheapestPrakkieIcon}>
                    <Sparkles size={20} color="#F5DE9A" strokeWidth={2.2} />
                  </View>
                  <View style={styles.cheapestPrakkieCopy}>
                    <Text style={styles.cheapestPrakkieTitle}>Goedkoopste prakkie</Text>
                    <Text style={styles.cheapestPrakkieMeta} numberOfLines={2}>
                      {cheapestSplit.missing > 0 ? 'Vanaf ' : ''}{formatEuroCents(cheapestSplit.total)} · {cheapestSplitMeta}
                      {cheapestSplit.missing > 0 ? ` · ${cheapestSplit.missing} zonder prijs` : ''}
                    </Text>
                  </View>
                  <ChevronRight size={20} color="#FFF7D8" strokeWidth={2.4} />
                </LinearGradient>
              </Pressable>
            ) : null}

          </>
        )}
      </ScrollView>

      {/* footer (owner-mockup 2026-07-14): Totaal-kaart + grote groene CTA.
          De chevron opent de per-supermarkt uitsplitsing; bij een concept komt
          er een Annuleer-link naast de CTA. */}
      {list && displayItems.length > 0 ? (
        <View style={[styles.footerWrap, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable
            style={styles.totalCard}
            onPress={() => setShowSubtotals(!showSubtotals)}
            accessibilityRole="button"
            accessibilityLabel="Toon uitsplitsing per supermarkt"
          >
            <View style={styles.totalIcon}>
              <Tag size={17} color={colors.primary} strokeWidth={2.1} />
            </View>
            <View style={{ gap: 1 }}>
              <Text style={styles.totalLabel}>Totaal</Text>
              <Text style={styles.totalValue}>{formatEuroCents(chosenTotal.cents)}</Text>
            </View>
            <View style={styles.totalDivider} />
            <View style={{ gap: 1, flex: 1 }}>
              {chosenSavings > 0 ? (
                <>
                  <Text style={styles.totalLabel}>Je bespaart</Text>
                  <Text style={[styles.totalValue, { color: colors.primary }]}>{formatEuroCents(chosenSavings)}</Text>
                </>
              ) : (
                <>
                  <Text style={styles.totalLabel}>Jouw keuzes</Text>
                  <Text style={styles.totalMeta}>
                    {chosenTotal.open > 0
                      ? `${chosenTotal.chosen} van ${openItems.length} gekozen`
                      : 'alles gekozen'}
                  </Text>
                </>
              )}
            </View>
            <ChevronRight size={19} color={colors.primary} strokeWidth={2.3} />
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {hasDraft ? (
              <Pressable onPress={cancelDraft} disabled={savingDraft} hitSlop={8} style={styles.cancelLink}>
                <Text style={styles.cancelLinkText}>Annuleer</Text>
              </Pressable>
            ) : null}
            <CTAButton
              label={savingDraft ? 'Opslaan…' : 'Sla deze lijst op'}
              onPress={openSaveDraftSheet}
              disabled={savingDraft}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}

      {/* "Kies alternatief" (owner-mockup 2026-07-14): full-screen picker per te
          controleren product — banner, origineel product, vergelijkbare
          producten met Kies-knoppen en sticky vorige/volgende-navigatie.
          EAN-only: alleen "Volgende" maakt een voorselectie
          definitief; overslaan = blijft bij de huidige supermarkt. */}
      {substitutionChain ? (
        <View style={[styles.pickerScreen, { paddingTop: insets.top + 14 }]}>
          {substitutionLoading || !substitutionPreview ? (
            <>
              <View style={styles.pickerHeader}>
                <Pressable onPress={closeSubstitutionPreview} hitSlop={10} style={styles.backBtn} accessibilityLabel="Terug">
                  <ChevronLeft size={20} color={colors.text} strokeWidth={2.4} />
                </Pressable>
                <Text style={styles.pickerTitle}>Kies alternatief</Text>
                <View style={{ width: 36 }} />
              </View>
              <View style={styles.pickerLoadingState}>
                <Text style={styles.pickerLoadingTitle}>Laatste prijzen ophalen</Text>
                <Text style={styles.pickerLoadingBody}>
                  We openen zo de juiste categorie bij {chainName(substitutionChain)}.
                </Text>
              </View>
            </>
          ) : currentPreviewLine && currentPreviewItem ? (
            <>
              <View style={styles.pickerHeader}>
                <Pressable
                  onPress={() => {
                    if (previewStep > 0) goToPreviousPreview();
                    else closeSubstitutionPreview();
                  }}
                  hitSlop={10}
                  style={styles.backBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Terug"
                >
                  <ChevronLeft size={20} color={colors.text} strokeWidth={2.4} />
                </Pressable>
                <Text style={styles.pickerTitle}>Kies alternatief</Text>
                <View style={{ width: 36 }} />
              </View>
              <View
                style={styles.pickerProgressTrack}
                accessibilityRole="progressbar"
                accessibilityLabel="Voortgang alternatieven kiezen"
                accessibilityValue={{ min: 0, max: previewReviewLines.length, now: previewStep + 1 }}
              >
                <View style={[styles.pickerProgressFill, { width: `${previewProgressPercent}%` }]} />
              </View>

              <ScrollView
                contentContainerStyle={styles.pickerContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.pickerBanner}>
                  <View style={styles.pickerBannerIcon}>
                    <AlertTriangle size={19} color="#B8860B" strokeWidth={2.2} />
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.pickerBannerTitle}>Kies zelf bij {chainName(substitutionChain)}</Text>
                    <Text style={styles.pickerBannerBody}>Start in hetzelfde winkelschap; typen zoekt ook in verwante schappen.</Text>
                  </View>
                </View>

                <Text style={styles.pickerSection}>Origineel product</Text>
                <View style={styles.pickerOriginalCard}>
                  {currentOriginalProduct?.image_url ? (
                    <Image source={{ uri: currentOriginalProduct.image_url }} style={styles.pickerThumb} contentFit="contain" />
                  ) : (
                    <View style={[styles.pickerThumb, styles.itemThumbEmpty]} />
                  )}
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <Text style={styles.pickerProductName} numberOfLines={2}>{currentPreviewItem.name}</Text>
                    {currentOriginalProduct ? (
                      <Text style={styles.subline} numberOfLines={1}>
                        {currentOriginalPackLabel?.split(' · ')[0] ?? ''}
                      </Text>
                    ) : null}
                    {currentOriginalChain ? (
                      <Text style={styles.subline}>
                        Oorspronkelijk bij <Text style={styles.pickerBoldMeta}>{chainName(currentOriginalChain)}</Text>
                      </Text>
                    ) : null}
                  </View>
                  {currentOriginalPriceCents != null ? (
                    <View style={styles.pickerOriginalPriceBlock}>
                      <Text style={styles.pickerPrice}>{formatEuroCents(currentOriginalPriceCents)}</Text>
                      {currentOriginalPackLabel?.split(' · ')[1] ? (
                        <Text style={styles.subline}>{currentOriginalPackLabel.split(' · ')[1]}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>

                <Text style={styles.pickerSection}>
                  {pickerCategory?.name_nl ?? 'Zelfde productcategorie'} bij {chainName(substitutionChain)}
                </Text>
                {pickerCategory ? (
                  <>
                    <View style={styles.pickerCatalogSearch}>
                      <Search size={15} color={colors.textMuted2} strokeWidth={2.2} />
                      <TextInput
                        value={pickerCatalogSearch}
                        onChangeText={setPickerCatalogSearch}
                        style={styles.pickerCatalogSearchInput}
                        placeholder={`Zoek binnen ${pickerCategory.name_nl}, bijv. 500 g…`}
                        placeholderTextColor={colors.textMuted2}
                        autoCapitalize="none"
                        returnKeyType="search"
                        accessibilityLabel={`Zoek binnen ${pickerCategory.name_nl} bij ${chainName(substitutionChain)}`}
                      />
                      {pickerCatalogSearch ? (
                        <Pressable
                          onPress={() => setPickerCatalogSearch('')}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Zoekopdracht wissen"
                        >
                          <X size={15} color={colors.textMuted2} />
                        </Pressable>
                      ) : null}
                    </View>
                    <View style={styles.pickerSortRow}>
                      {PICKER_SORTS.map((sortOption) => (
                        <Pressable
                          key={sortOption.key}
                          onPress={() => setPickerCatalogSort(sortOption.key)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: pickerCatalogSort === sortOption.key }}
                          style={[
                            styles.pickerSortChip,
                            pickerCatalogSort === sortOption.key && styles.pickerSortChipActive,
                          ]}
                        >
                          <Text style={[
                            styles.pickerSortChipText,
                            pickerCatalogSort === sortOption.key && styles.pickerSortChipTextActive,
                          ]}>
                            {sortOption.label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                ) : null}
                {pickerCatalogLoading ? (
                  <Text style={[type.meta, { paddingVertical: 8 }]}>Producten uit de categorie laden…</Text>
                ) : pickerCategoryError ? (
                  <Text style={[type.meta, { paddingVertical: 8, color: colors.danger }]}>{pickerCategoryError}</Text>
                ) : visiblePickerOptions.length === 0 ? (
                  <Text style={[type.meta, { paddingVertical: 8 }]}>
                    Geen producten in deze categorie gevonden.
                  </Text>
                ) : (
                  visiblePickerOptions.map((option) => {
                    const selected = currentPreviewChoice?.sku_id === option.sku_id;
                    const meta = packLabel(option);
                    const optionQty = selected
                      ? currentPreviewQty
                      : countQty(currentPreviewItem);
                    const optionTotalCents = previewQtyApplies
                      ? optionQty * (option.promo_price_cents ?? option.price_cents)
                      : option.line_price_cents ?? optionLineCents(currentPreviewItem, option);
                    return (
                      <View key={option.sku_id} style={[styles.pickerOptionCard, selected && styles.pickerOptionCardOn]}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                          {option.image_url ? (
                            <Image source={{ uri: option.image_url }} style={styles.pickerThumb} contentFit="contain" />
                          ) : (
                            <View style={[styles.pickerThumb, styles.itemThumbEmpty]} />
                          )}
                          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                            <Text style={styles.pickerProductName} numberOfLines={2}>{option.name}</Text>
                            {meta?.split(' · ')[0] ? (
                              <Text style={styles.subline}>{meta.split(' · ')[0]}</Text>
                            ) : null}
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 7 }}>
                              <Text style={styles.pickerPrice}>
                                {formatEuroCents(optionTotalCents)}
                              </Text>
                              {meta?.split(' · ')[1] ? (
                                <Text style={styles.subline}>{meta.split(' · ')[1]}</Text>
                              ) : null}
                            </View>
                            <View style={{ flexDirection: 'row' }}>{chainPill(substitutionChain)}</View>
                          </View>
                          <View style={styles.pickerOptionActions}>
                            {previewQtyApplies && selected ? (
                              <View style={styles.pickerQtyStepper}>
                                <Pressable
                                  onPress={() => setStagedQty(Math.max(currentPreviewMinQty, currentPreviewQty - 1))}
                                  disabled={currentPreviewQty <= currentPreviewMinQty}
                                  hitSlop={8}
                                  style={[
                                    styles.pickerQtyBtn,
                                    currentPreviewQty <= currentPreviewMinQty && styles.pickerQtyBtnDisabled,
                                  ]}
                                  accessibilityRole="button"
                                  accessibilityLabel="Minder"
                                  accessibilityState={{ disabled: currentPreviewQty <= currentPreviewMinQty }}
                                >
                                  <Minus size={14} color={colors.text} strokeWidth={2.4} />
                                </Pressable>
                                <Text style={styles.pickerQtyValue}>{currentPreviewQty}×</Text>
                                <Pressable
                                  onPress={() => setStagedQty(Math.min(Math.max(99, currentPreviewMinQty), currentPreviewQty + 1))}
                                  hitSlop={8}
                                  style={styles.pickerQtyBtn}
                                  accessibilityRole="button"
                                  accessibilityLabel="Meer"
                                >
                                  <Plus size={14} color={colors.text} strokeWidth={2.4} />
                                </Pressable>
                              </View>
                            ) : previewQtyApplies ? (
                              <Text style={styles.pickerCardQtyPill}>{optionQty}×</Text>
                            ) : null}
                            <Pressable
                              onPress={() => {
                                setStagedPickSku(option.sku_id);
                                setStagedQty(null); // nieuwe variant: begin bij het lijst-aantal
                                // Bewaar de expliciete kaartkeuze meteen in de
                                // wizard-state. De lijst zelf verandert pas bij
                                // Volgende, maar wissen/wijzigen van een
                                // cataloguszoekterm kan deze keuze nu niet meer
                                // stilletjes laten terugvallen op optie één.
                                choosePreviewOption(currentPreviewLine.item_id, option, null);
                              }}
                              style={[styles.kiesBtn, selected && styles.kiesBtnOn]}
                              accessibilityRole="button"
                              accessibilityState={{ selected }}
                              accessibilityLabel={`Kies ${option.name}`}
                            >
                              {selected ? <Check size={14} color={colors.onPrimary} strokeWidth={2.6} /> : null}
                              <Text style={styles.kiesBtnText}>{selected ? 'Gekozen' : 'Kies'}</Text>
                            </Pressable>
                          </View>
                        </View>
                      </View>
                    );
                  })
                )}
              </ScrollView>

              {currentPreviewLine ? (
                <View style={[styles.pickerFooter, { paddingBottom: insets.bottom + 12 }]}>
                  <View style={styles.pickerFooterNav}>
                    <Pressable
                      onPress={goToPreviousPreview}
                      disabled={previewStep === 0 || savingDraft}
                      style={[
                        styles.pickerPreviousBtn,
                        (previewStep === 0 || savingDraft) && styles.pickerNavBtnDisabled,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Vorige"
                      accessibilityState={{ disabled: previewStep === 0 || savingDraft }}
                    >
                      <ChevronLeft size={17} color={colors.primary} strokeWidth={2.4} />
                      <Text style={styles.pickerPreviousText}>Vorige</Text>
                    </Pressable>
                    <CTAButton
                      label={savingDraft ? 'Opslaan…' : isLastPreviewStep ? 'Terug naar overzicht' : 'Volgende'}
                      onPress={goToNextPreview}
                      disabled={!canContinuePreview || savingDraft}
                      style={styles.pickerNextBtn}
                    />
                  </View>
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

      {/* item-sheet: hoeveelheid, verwijderen, en DE productkeuze over ál je supers.
          KeyboardAvoidingView: het toetsenbord schoof over de typvelden (owner 2026-07-08) */}
      {detailItem ? (
        <KeyboardAvoidingView pointerEvents="box-none" behavior={Platform.OS === 'web' ? undefined : 'padding'} style={styles.sheetWrap}>
        <View style={[styles.sheet, styles.sheetInWrap, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <TextInput
              style={styles.nameEdit}
              value={nameDraft}
              onChangeText={setNameDraft}
              onEndEditing={() => renameItem(detailItem)}
              onSubmitEditing={() => renameItem(detailItem)}
              returnKeyType="done"
            />
            <Pressable onPress={() => setDetailItem(null)} hitSlop={10} accessibilityLabel="Productvenster sluiten">
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          <View style={styles.qtyRow}>
            <View style={styles.qtyStepper}>
              <Pressable onPress={() => bumpQty(detailItem, -1)} hitSlop={8} style={styles.qtyBtn}>
                <Minus size={15} color={colors.text} strokeWidth={2.2} />
              </Pressable>
              <Text style={styles.qtyValue}>
                {String(detailDisplayedQty).replace('.', ',')}{detailItem.unit ? ` ${detailItem.unit}` : '×'}
              </Text>
              <Pressable onPress={() => bumpQty(detailItem, 1)} hitSlop={8} style={styles.qtyBtn}>
                <Plus size={15} color={colors.text} strokeWidth={2.2} />
              </Pressable>
            </View>
            <Pressable style={styles.removeBtn} onPress={() => removeItemRow(detailItem)}>
              <Trash2 size={15} color={colors.danger} strokeWidth={2} />
              <Text style={styles.removeText}>Verwijder</Text>
            </Pressable>
          </View>

          <Text style={styles.sheetSection}>KIES JOUW PRODUCT — BESTE MATCHES EERST</Text>
          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {(() => {
              // al-gepinde ketens (bv. via de AI-resolver) horen er altijd bij,
              // ook als de user zijn standaard-supers ondertussen aangepast heeft —
              // anders verdwijnt de sheet's enige bewijs van wat er al gekozen is
              const pinnedByChain: PinnedByChain = {};
              for (const [c, m] of Object.entries(detailItem.matches ?? {})) {
                if (m?.user_pinned) pinnedByChain[c] = m.sku_id;
              }
              const sheetChains = [...new Set([...myChains, ...Object.keys(pinnedByChain)])];
              const currentChain = chosenChainOf(detailItem, myChains);
              return (
                <CrossChainOptions
                  term={detailItem.item_normalised ?? detailItem.name}
                  chains={sheetChains}
                  pinnedByChain={pinnedByChain}
                  currentSku={currentChain ? detailItem.matches?.[currentChain]?.sku_id ?? null : null}
                  onPick={(o) => pinProduct(detailItem, o)}
                />
              );
            })()}
          </ScrollView>
        </View>
        </KeyboardAvoidingView>
      ) : null}

      {/* bewaar-sheet: naam kiezen voor het opgeslagen lijstje */}
      {sheet === 'save' ? (
        <KeyboardAvoidingView pointerEvents="box-none" behavior={Platform.OS === 'web' ? undefined : 'padding'} style={styles.sheetWrap}>
        <View style={[styles.sheet, styles.sheetInWrap, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>Lijstje bewaren</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10} accessibilityLabel="Bewaarvenster sluiten">
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>
          <Text style={[type.meta, { marginTop: 2 }]}>
            Bewaar deze {displayItems.length} items als vast lijstje — laad ze later met één tik in een andere dag.
          </Text>
          <TextInput
            style={styles.templateNameInput}
            placeholder="Naam, bijv. Weekboodschappen basis"
            placeholderTextColor="#97A08F"
            value={templateName}
            onChangeText={setTemplateName}
            onSubmitEditing={saveTemplate}
            returnKeyType="done"
          />
          <CTAButton label="Bewaar lijstje" onPress={saveTemplate} style={{ marginTop: 4 }} />
        </View>
        </KeyboardAvoidingView>
      ) : null}

      {/* opslaan-sheet: naam voor je lijst (owner 2026-07-14) — vervangt de
          kale Opslaan-knop; al eerder genoemd, dan staat de naam voorgevuld */}
      {sheet === 'saveDraft' ? (
        <KeyboardAvoidingView pointerEvents="box-none" behavior={Platform.OS === 'web' ? undefined : 'padding'} style={styles.sheetWrap}>
        <View style={[styles.sheet, styles.sheetInWrap, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>Lijst opslaan</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10} accessibilityLabel="Opslaan sluiten">
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>
          <Text style={[type.meta, { marginTop: 2 }]}>Geef je lijst een naam.</Text>
          <TextInput
            style={styles.templateNameInput}
            placeholder="Naam, bijv. Weekboodschappen"
            placeholderTextColor="#97A08F"
            value={draftSaveName}
            onChangeText={setDraftSaveName}
            onSubmitEditing={confirmSaveDraft}
            returnKeyType="done"
            autoFocus
          />
          <CTAButton label="Sla deze lijst op" onPress={confirmSaveDraft} disabled={savingDraft} style={{ marginTop: 4 }} />
        </View>
        </KeyboardAvoidingView>
      ) : null}

      {/* laad-sheet: opgeslagen lijstjes (favorieten) bovenop je huidige lijst */}
      {sheet === 'load' ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>Opgeslagen lijstjes</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10} accessibilityLabel="Lijstjes sluiten">
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>
          <Text style={type.meta}>Tik om de items bovenop je huidige lijst te zetten — met je productkeuzes.</Text>
          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
            {templates.map((tpl) => (
              <View key={tpl.id} style={styles.templateRow}>
                <View style={styles.shareIcon}>
                  <Bookmark size={14} color={colors.primary} strokeWidth={2} />
                </View>
                <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => loadTemplate(tpl)}>
                  <Text style={[type.body, { fontSize: 13.5, fontFamily: fonts.bodySemiBold }]} numberOfLines={1}>
                    {tpl.name}
                  </Text>
                  <Text style={type.meta}>{templateCount(tpl.id)} items</Text>
                </Pressable>
                <Pressable onPress={() => removeTemplate(tpl)} hitSlop={8} accessibilityLabel={`Verwijder ${tpl.name}`}>
                  <Trash2 size={15} color="#B9C0B2" strokeWidth={2} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* deel-sheet: heel huishouden of losse huisgenoten (owner 2026-07-07) */}
      {sheet === 'share' && list ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>Lijst delen</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10} accessibilityLabel="Delen sluiten">
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>
          {household ? (
            <>
              <Text style={type.meta}>
                Wie de lijst ziet kan meeschrijven en afvinken — alles synct live.
              </Text>
              <Pressable style={styles.shareRow} onPress={toggleShareHousehold}>
                <View style={styles.shareIcon}>
                  <Users size={15} color={colors.primary} strokeWidth={2} />
                </View>
                <Text style={[type.body, { flex: 1, fontSize: 13.5 }]}>
                  Deel met heel “{household.name}”
                </Text>
                {list.household_id ? <Check size={16} color={colors.primary} strokeWidth={2.4} /> : null}
              </Pressable>
              {members.filter((m) => m.user_id !== myId).map((m) => {
                const on = (list.shared_with ?? []).includes(m.user_id);
                const naam = m.display_name ?? m.email ?? 'huisgenoot';
                return (
                  <Pressable key={m.user_id} style={styles.shareRow} onPress={() => toggleShareMember(m.user_id)}>
                    <View style={styles.shareIcon}>
                      <Text style={styles.shareInitial}>{naam.slice(0, 1).toUpperCase()}</Text>
                    </View>
                    <Text style={[type.body, { flex: 1, fontSize: 13.5 }]} numberOfLines={1}>Deel met {naam}</Text>
                    {on ? <Check size={16} color={colors.primary} strokeWidth={2.4} /> : null}
                  </Pressable>
                );
              })}
              {members.filter((m) => m.user_id !== myId).length === 0 ? (
                <Text style={type.meta}>
                  Nog geen huisgenoten — nodig iemand uit via je Profiel (alleen de admin kan uitnodigen).
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={type.meta}>
              Delen werkt via je huishouden. Maak er een aan op je Profiel en nodig huisgenoten uit — daarna
              kun je hier per lijst kiezen met wie je hem deelt.
            </Text>
          )}
        </View>
      ) : null}

    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 260, gap: 10 },
  flowHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingBottom: 10,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  flowTitle: { flex: 1, fontFamily: fonts.bodySemiBold, fontSize: 17, color: colors.text, textAlign: 'center' },

  // --- owner-mockup 2026-07-14: lijstscherm ---
  bleedRow: { marginHorizontal: -20 },
  chainCardRow: { paddingHorizontal: 20, gap: 10, flexDirection: 'row' },
  chainCard: {
    width: 146, minHeight: 82, justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderSubtle, paddingVertical: 11, paddingHorizontal: 12,
    gap: 9,
  },
  chainCardSelected: { borderColor: colors.primary, borderWidth: 1.5 },
  chainCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  chainCardName: { flex: 1, fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  chainCardPrice: { fontSize: 17, fontFamily: fonts.bodyBold, color: colors.text },
  composeStoreButton: {
    alignSelf: 'flex-start', borderRadius: radius.pill,
    backgroundColor: colors.badgeBg, paddingHorizontal: 10, paddingVertical: 5,
  },
  composeStoreButtonText: { fontSize: 11.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
  allesChipRow: { paddingHorizontal: 20, gap: 9, flexDirection: 'row' },
  allesChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface,
    borderRadius: radius.control, borderWidth: 1, borderColor: colors.borderSubtle,
    paddingVertical: 10, paddingHorizontal: 13, ...shadows.card,
  },
  allesChipText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  itemCardList: { gap: 9 },
  itemCard: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    backgroundColor: colors.surface, borderRadius: radius.listCard,
    borderWidth: 1, borderColor: colors.borderSubtle,
    paddingVertical: 11, paddingHorizontal: 12, ...shadows.card,
  },
  itemThumb: { width: 52, height: 52, borderRadius: 8 },
  itemThumbEmpty: { backgroundColor: colors.surfaceMuted },
  itemBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  itemRight: { alignItems: 'flex-end', gap: 6, minWidth: 62 },
  chainPillWrap: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3.5 },
  chainPillText: { fontSize: 11, fontFamily: fonts.bodySemiBold },
  totalCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.listCard,
    borderWidth: 1, borderColor: colors.borderSubtle,
    paddingVertical: 12, paddingHorizontal: 14, marginBottom: 10, ...shadows.card,
  },
  totalIcon: {
    width: 40, height: 40, borderRadius: 11, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  totalLabel: { fontSize: 11.5, fontFamily: fonts.body, color: colors.textMuted },
  totalValue: { fontSize: 17, fontFamily: fonts.bodyBold, color: colors.text },
  totalMeta: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  totalDivider: { width: 1, alignSelf: 'stretch', backgroundColor: colors.borderSubtle, marginVertical: 2 },
  cancelLink: { paddingHorizontal: 4, paddingVertical: 10 },
  cancelLinkText: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.textMuted },

  // --- owner-mockup 2026-07-14: Kies alternatief (full-screen picker) ---
  pickerScreen: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: colors.bg,
  },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingBottom: 10,
  },
  pickerTitle: { flex: 1, fontSize: 17, fontFamily: fonts.bodySemiBold, color: colors.text, textAlign: 'center' },
  pickerLoadingState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 34, gap: 5 },
  pickerLoadingTitle: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.text },
  pickerLoadingBody: { fontSize: 12, lineHeight: 16, fontFamily: fonts.body, color: colors.textMuted2, textAlign: 'center' },
  pickerProgressTrack: {
    height: 5, marginHorizontal: 20, marginBottom: 10, borderRadius: 3,
    overflow: 'hidden', backgroundColor: colors.borderControl,
  },
  pickerProgressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.primary },
  pickerContent: { paddingHorizontal: 20, paddingBottom: 24, gap: 10 },
  pickerBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#FDF6E3', borderRadius: radius.lg,
    borderWidth: 1, borderColor: 'rgba(184,134,11,0.18)',
    paddingVertical: 14, paddingHorizontal: 14,
  },
  pickerBannerIcon: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(246,196,69,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  pickerBannerTitle: { fontSize: 14.5, fontFamily: fonts.bodyBold, color: colors.text },
  pickerBannerBody: { fontSize: 12.5, fontFamily: fonts.body, color: colors.textSoft, lineHeight: 17 },
  pickerSection: { fontSize: 14.5, fontFamily: fonts.bodyBold, color: colors.text, marginTop: 6 },
  pickerCatalogSearch: {
    minHeight: 43, flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingHorizontal: 12, borderRadius: radius.control, backgroundColor: colors.surfaceMuted,
    borderWidth: 1, borderColor: colors.borderControl,
  },
  pickerCatalogSearchInput: { flex: 1, padding: 0, fontSize: 13, color: colors.text },
  pickerSortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 2 },
  pickerSortChip: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderControl, backgroundColor: colors.surface,
  },
  pickerSortChipActive: { backgroundColor: colors.tabPill, borderColor: colors.primary },
  pickerSortChipText: { fontFamily: fonts.bodySemiBold, fontSize: 11.5, color: colors.textSoft },
  pickerSortChipTextActive: { color: colors.primary },
  pickerOriginalCard: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    backgroundColor: colors.surface, borderRadius: radius.listCard,
    borderWidth: 1, borderColor: colors.borderSubtle,
    paddingVertical: 13, paddingHorizontal: 13, ...shadows.card,
  },
  pickerThumb: { width: 62, height: 62, borderRadius: 9 },
  pickerProductName: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text },
  pickerBoldMeta: { fontFamily: fonts.bodyBold, color: colors.text },
  pickerOriginalPriceBlock: { alignItems: 'flex-end', gap: 2 },
  pickerOptionCard: {
    backgroundColor: colors.surface, borderRadius: radius.listCard,
    borderWidth: 1, borderColor: colors.borderSubtle,
    paddingVertical: 12, paddingHorizontal: 13, gap: 8, ...shadows.card,
  },
  pickerOptionCardOn: { borderColor: colors.primary, borderWidth: 1.5 },
  pickerBadge: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.badgeBg, borderRadius: radius.pill,
    paddingHorizontal: 9, paddingVertical: 4,
  },
  pickerBadgeText: { fontSize: 11, fontFamily: fonts.bodySemiBold, color: colors.primary },
  pickerPrice: { fontSize: 16.5, fontFamily: fonts.bodyBold, color: colors.text },
  kiesBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingHorizontal: 17, paddingVertical: 10,
  },
  kiesBtnOn: { backgroundColor: colors.primaryBright },
  kiesBtnText: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  pickerOptionActions: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  pickerMoreBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.surface, borderRadius: radius.control,
    borderWidth: 1, borderColor: colors.borderControl,
    paddingVertical: 12,
  },
  pickerMoreText: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.primary },
  pickerFooter: {
    paddingHorizontal: 14, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surface,
  },
  pickerFooterNav: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  pickerPreviousBtn: {
    minWidth: 112, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    backgroundColor: colors.surface, borderRadius: radius.cta,
    borderWidth: 1, borderColor: colors.borderControl, paddingHorizontal: 16,
  },
  pickerPreviousText: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.primary },
  pickerNavBtnDisabled: { opacity: 0.35 },
  pickerNextBtn: { flex: 1 },
  pickerCardQtyPill: {
    fontSize: 12, fontFamily: fonts.bodyBold, color: colors.primary,
    backgroundColor: colors.surface, borderRadius: radius.pill, overflow: 'hidden',
    paddingHorizontal: 9, paddingVertical: 5,
  },
  pickerQtyStepper: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.surfaceMuted, borderRadius: radius.pill,
    paddingHorizontal: 6, paddingVertical: 4,
  },
  pickerQtyBtn: {
    width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  pickerQtyBtnDisabled: { opacity: 0.35 },
  pickerQtyValue: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.text, minWidth: 26, textAlign: 'center' },
  title: { fontFamily: fonts.display, fontSize: 31, lineHeight: 34, color: colors.text },
  dayPickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 2 },
  dayChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface,
    borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9,
    borderWidth: 1, borderColor: colors.borderControl,
    shadowColor: '#1E2B1B', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  dayChipText: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  dayPickHint: { fontSize: 11, color: colors.textMuted2 },
  prakkieIntro: { fontSize: 12.5, lineHeight: 18, color: colors.textMuted, marginBottom: 4 },
  prakkieItemRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.surface, borderRadius: radius.control,
    borderWidth: 1, borderColor: colors.borderSubtle, paddingHorizontal: 14,
    ...shadows.card,
  },
  prakkieInput: { flex: 1, fontFamily: fonts.body, fontSize: 14, color: colors.text, paddingVertical: 13 },
  prakkieQtyInput: {
    width: 118, fontFamily: fonts.body, fontSize: 12, color: colors.textSoft, paddingVertical: 13,
    textAlign: 'right', borderLeftWidth: 1, borderLeftColor: 'rgba(34,48,30,0.07)', paddingLeft: 10,
  },
  resultControls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  backToListBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6 },
  backToListText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.primary },
  sortPill: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderControl,
  },
  sortPillOn: { backgroundColor: colors.badgeBg, borderColor: 'rgba(42,95,56,0.25)' },
  sortPillText: { fontSize: 11, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  sortPillTextOn: { color: colors.primary },
  busyLogoRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 6 },
  busyLogo: { opacity: 0.3, transform: [{ scale: 1 }] },
  busyLogoActive: { opacity: 1, transform: [{ scale: 1.25 }] },
  prakkieAddRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: 'rgba(34,48,30,0.16)',
    borderRadius: 13, paddingVertical: 13, marginTop: 2,
  },
  prakkieAddText: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted2 },
  prakkieBusyBox: { alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 90, paddingHorizontal: 20 },
  prakkieQuota: { fontSize: 11, color: colors.textMuted2, textAlign: 'center', marginTop: 6 },
  quotaBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', marginTop: 12,
    backgroundColor: colors.quotaBg, borderWidth: 1, borderColor: colors.quotaBorder,
    borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6,
  },
  quotaBadgeText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.quota },
  startBtns: { gap: 9, marginTop: 6 },
  startBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.listCard,
    paddingHorizontal: 14, paddingVertical: 12, ...shadows.card,
  },
  startIcon: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  startBtnTitle: { flex: 1, fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  startCount: {
    fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.primary,
    backgroundColor: colors.badgeBg, borderRadius: radius.pill, overflow: 'hidden',
    paddingHorizontal: 8, paddingVertical: 2,
  },
  shelfBtn: {
    marginTop: 8, borderRadius: radius.listCard, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderSubtle,
    alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14, gap: 2,
    ...shadows.card,
  },
  shelfEmoji: { fontSize: 18, letterSpacing: 3 },
  shelfTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  shelfSub: { fontSize: 11, color: colors.textMuted },
  calOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(20,28,17,0.38)' },
  calSheet: { gap: 12, paddingTop: 14 },
  calHandle: { width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(34,48,30,0.14)', alignSelf: 'center' },
  calTitle: { fontSize: 15.5, fontFamily: fonts.bodyBold, color: colors.text },
  calClose: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#F1EDE2', alignItems: 'center', justifyContent: 'center' },
  calHint: { fontSize: 11.5, color: colors.textMuted },
  calNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  calNavLabel: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text },
  calRow: { flexDirection: 'row', gap: 4 },
  calWeekDay: { flex: 1, textAlign: 'center', fontSize: 10.5, fontFamily: fonts.bodyBold, color: colors.textMuted2 },
  calCell: { flex: 1, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 2 },
  calCellSelected: { backgroundColor: colors.badgeBg, borderWidth: 1.5, borderColor: colors.primary },
  calCellText: { fontSize: 13.5, color: colors.text },
  calCellTextSelected: { fontFamily: fonts.bodyBold, color: colors.primary },
  calDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
  dayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  dayTitle: { fontFamily: fonts.display, fontSize: 21, lineHeight: 25, color: colors.text },
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tab: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.textSoft },
  tabTextActive: { color: colors.onPrimary },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surfaceMuted,
    borderRadius: radius.control, paddingHorizontal: 15, paddingVertical: 12,
  },
  searchInput: { flex: 1, fontSize: 13.5, color: colors.text, padding: 0 },
  resultsCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6,
  },
  plainAddRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)',
  },
  plainAddIcon: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  plainAddText: { flex: 1, fontSize: 12.5, color: colors.text, fontFamily: fonts.bodySemiBold },
  metaLine: { fontSize: 12, color: colors.textMuted },
  groupHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 8, marginBottom: 7, paddingHorizontal: 2,
  },
  groupTitle: {
    fontSize: 11.5, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: colors.textMuted,
  },
  groupSubtotal: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.textSoft },
  groupCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
    borderRadius: radius.listCard, overflow: 'hidden',
    ...shadows.card,
  },
  itemRow: { paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 11 },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  checkbox: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 1.8, borderColor: 'rgba(34,48,30,.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  itemNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  qtyStepperRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  qtyMini: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.surfaceMuted,
    borderWidth: 1, borderColor: colors.borderControl, alignItems: 'center', justifyContent: 'center',
  },
  qtyMiniValue: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.text },
  aisleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 4 },
  aisleCard: {
    flexBasis: '47%', flexGrow: 1, paddingVertical: 10, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.surface, borderRadius: radius.control,
    borderWidth: 1, borderColor: colors.borderSubtle,
    ...shadows.card,
  },
  aisleThumb: { width: 40, height: 40, borderRadius: 8, backgroundColor: colors.surfaceMuted },
  aisleThumbEmpty: { backgroundColor: '#EDE7D8' },
  aisleCardText: { flex: 1, fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  itemName: { fontSize: 14, color: colors.text, flexShrink: 1 },
  checkedText: { textDecorationLine: 'line-through', color: '#97A08F' },
  byChip: {
    width: 17, height: 17, borderRadius: 9, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  byChipText: { fontSize: 9, fontFamily: fonts.bodyBold, color: colors.primary },
  mergedBadge: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: colors.badgeBg, color: colors.primary, fontSize: 9.5, fontFamily: fonts.bodyBold,
  },
  bonusBadge: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: colors.bonus, color: colors.bonusText, fontSize: 9.5, fontFamily: fonts.bodyBold,
  },
  subline: { fontSize: 10.5, color: '#97A08F', marginTop: 2 },
  priceCol: { alignItems: 'flex-end', gap: 1 },
  price: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  priceLoading: { fontSize: 10.5, fontFamily: fonts.bodyMedium, color: colors.textMuted2 },
  adviceRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 11 },
  adviceRowGrey: { opacity: 0.55 },
  restoreChoicesButton: {
    flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 12,
    paddingHorizontal: 13, paddingVertical: 11, borderRadius: radius.control,
    backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: 'rgba(46,107,62,.2)',
  },
  restoreChoicesIcon: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  restoreChoicesTitle: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.primary },
  restoreChoicesText: { marginTop: 1, fontSize: 10.5, color: colors.textMuted },
  cheapestPrakkieWrap: {
    position: 'relative', marginTop: 11, marginHorizontal: 2, borderRadius: 19,
    overflow: 'visible', ...shadows.cta,
  },
  cheapestPrakkiePressed: { opacity: 0.91, transform: [{ scale: 0.992 }] },
  cheapestPrakkieGradient: {
    minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, paddingHorizontal: 15, borderRadius: 19, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(245,222,154,.45)',
  },
  cheapestPrakkieShimmer: {
    position: 'absolute', top: -28, bottom: -28, width: 90,
  },
  cheapestPrakkieIcon: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,247,216,.13)', borderWidth: 1, borderColor: 'rgba(255,247,216,.24)',
  },
  cheapestPrakkieCopy: { flex: 1, minWidth: 0, gap: 3 },
  cheapestPrakkieTitle: { fontSize: 15, fontFamily: fonts.bodyBold, color: '#FFF9E8' },
  cheapestPrakkieMeta: { fontSize: 11, lineHeight: 15, fontFamily: fonts.bodyMedium, color: 'rgba(255,249,232,.78)' },
  cheapestSparkle: { position: 'absolute', zIndex: 3 },
  cheapestSparkleTop: { right: 13, top: -9 },
  cheapestSparkleBottom: { left: 16, bottom: -7 },
  missingHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 5 },
  missingName: { flex: 1, fontSize: 12.5, color: colors.text },
  missingCta: { fontSize: 11, fontFamily: fonts.bodyBold, color: colors.primary },
  adviceName: { fontSize: 13.5, color: colors.text, fontFamily: fonts.bodySemiBold },
  adviceBest: { fontSize: 10.5, color: colors.primary, fontFamily: fonts.bodyBold },
  adviceSave: { fontSize: 10.5, color: colors.primary, fontFamily: fonts.bodyBold },
  advicePrice: { fontSize: 13.5, fontFamily: fonts.bodyBold, color: colors.text },
  adviceFootnote: { fontSize: 10, color: colors.textMuted, marginTop: 6, paddingHorizontal: 2 },
  substitutionSheet: { maxHeight: '94%', zIndex: 30 },
  estimateCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 13, paddingVertical: 11,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
    borderRadius: radius.control,
  },
  estimateLabel: {
    fontSize: 8.5, letterSpacing: 0.65, fontFamily: fonts.bodyBold, color: colors.textMuted2,
  },
  estimatePrice: { marginTop: 1, fontSize: 19, fontFamily: fonts.bodyBold, color: colors.primary },
  estimateMeta: { marginTop: 2, fontSize: 10.5, lineHeight: 14, color: colors.textMuted },
  progressHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  progressLabel: { fontSize: 9.5, letterSpacing: 0.55, fontFamily: fonts.bodyBold, color: colors.textSoft },
  progressCount: { fontSize: 10.5, fontFamily: fonts.bodyBold, color: colors.primary },
  progressTrack: {
    height: 7, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.borderControl,
  },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: colors.primary },
  wizardScroll: { maxHeight: 370 },
  wizardProductCard: {
    paddingHorizontal: 13, paddingVertical: 11, gap: 4, borderRadius: radius.control,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  wizardEyebrow: { fontSize: 8.5, letterSpacing: 0.55, fontFamily: fonts.bodyBold, color: colors.textMuted2 },
  wizardOriginalName: { fontSize: 14.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  wizardSuggestionRow: {
    marginTop: 6, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.borderSubtle,
    flexDirection: 'row', alignItems: 'center', gap: 9,
  },
  wizardSuggestionName: { fontSize: 12.5, lineHeight: 16, fontFamily: fonts.bodySemiBold, color: colors.text },
  wizardSuggestionPrice: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.primary },
  keepCurrentButton: {
    minHeight: 42, paddingHorizontal: 12, borderRadius: radius.control, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderControl,
  },
  keepCurrentButtonOn: { backgroundColor: colors.badgeBg, borderColor: colors.primary },
  keepCurrentText: { fontSize: 11.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  wizardNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginTop: 1,
  },
  wizardArrow: {
    width: 58, height: 54, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  wizardArrowDisabled: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderControl },
  wizardNavText: { fontSize: 12, fontFamily: fonts.bodyBold, color: colors.textSoft },
  wizardDoneCard: {
    minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13,
    borderRadius: radius.control, backgroundColor: colors.badgeBg,
    borderWidth: 1, borderColor: 'rgba(46,107,62,.2)',
  },
  splitIcon: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  splitIconText: { fontSize: 8.5, fontFamily: fonts.bodyBold, color: colors.primary },
  footerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  footerCard: {
    backgroundColor: colors.darkGlass, borderRadius: 19, paddingVertical: 15, paddingHorizontal: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    shadowColor: '#1A2417', shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: 12 }, elevation: 12,
  },
  footerLabel: { fontSize: 11, color: 'rgba(253,251,246,.6)' },
  footerTotal: { fontSize: 20, fontFamily: fonts.bodyBold, color: colors.cream },
  cancelBtn: {
    paddingHorizontal: 13, paddingVertical: 9, borderRadius: radius.pill,
    borderWidth: 1, borderColor: 'rgba(253,251,246,.35)',
  },
  cancelBtnText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: 'rgba(253,251,246,.85)' },
  saveBtn: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: radius.pill, backgroundColor: colors.primary,
  },
  saveBtnText: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.onPrimary },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.bg,
    borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: 20, gap: 9,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
  // typ-sheets in een KeyboardAvoidingView: absolute → relative, anders negeert
  // de absolute positionering de keyboard-padding
  sheetWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' },
  sheetInWrap: { position: 'relative' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  nameEdit: {
    flex: 1, fontSize: 16, fontFamily: fonts.bodyBold, color: colors.text, padding: 0,
    borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.15)', paddingBottom: 3,
  },
  sheetSection: {
    fontSize: 11, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: colors.textMuted, marginTop: 8,
  },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  qtyStepper: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 5,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.1)',
  },
  qtyBtn: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surface, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  qtyValue: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text, minWidth: 40, textAlign: 'center' },
  removeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 4 },
  removeText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.danger },
  templateNameInput: {
    backgroundColor: colors.surfaceMuted, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', fontSize: 13.5, color: colors.text, marginTop: 4,
  },
  templateRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11 },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10 },
  shareIcon: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  shareInitial: { fontSize: 12, fontFamily: fonts.bodyBold, color: colors.primary },
  savedListsBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  savedListsText: { fontSize: 11.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
});
