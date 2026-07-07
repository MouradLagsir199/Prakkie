import { formatEuroCents } from '@prakkie/shared';
import {
  Bookmark, BookmarkPlus, Check, ChevronLeft, ChevronRight, Minus, Plus, Search, Trash2, X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CrossChainList,
  CrossChainOptions,
  ProductOptions,
  useCrossChainOptions,
  type CrossChainOption,
  type ProductOption,
} from '../../components/prakkie/ProductOptions';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { addDays, CHAIN_BRAND, chainChip, chainName, mondayOf, weekRangeLabel } from '../../data/chains';
import { activeHouseholdId, loadHousehold, memberName, type MemberInfo } from '../../data/households';
import { kv } from '../../data/kv';
import { confirmDialog, notice } from '../../lib/dialogs';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Boodschappen v3 (owner UX 2026-07-07, derde iteratie):
 *  - week-strip met puntjes; zoek-eerst over ál je supers (banden, prijs-oplopend);
 *  - DRAFT-model: elke lijst-bewerking is een concept tot je op Opslaan tikt —
 *    Annuleren gooit alles weg (afvinken in de winkel blijft wél direct);
 *  - lijst gegroepeerd per supermarkt met subtotalen (schap-categorieën weg);
 *  - prullenbakje per regel; "Alles bij X" tikbaar → heel lijstje wisselt (in draft);
 *  - opgeslagen lijstjes: bewaar als favoriet + laad in een andere dag;
 *  - aantal ×2 = prijs ×2 (bonusprijs telt per stuk mee, server-side gefixt).
 */

interface ListRow { id: string; name: string; week_start?: string | null; household_id?: string | null }
interface MatchEntry { sku_id: string; confidence?: number; user_pinned?: boolean; preferred?: boolean }
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
interface PricedLine {
  item_id: string; matched: boolean; sku_id?: string; product_name?: string;
  packs?: number; line_price_cents?: number; promo?: unknown; promo_savings_cents?: number; confidence?: number;
}
interface ChainPricing {
  chain_id: string; total_cents: number; matched: number; unmatched: string[]; lines: PricedLine[];
}
interface Correction { chain_id: string; item_normalised: string; chosen_sku_id: string }

const ALL_CHAINS = ['ah', 'jumbo', 'plus', 'dirk', 'spar', 'aldi'];
const MONTHS_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DAYS_NL = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const MIN_CONFIDENCE = 0.45;

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dutchDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00`);
  return `${d.getDate()} ${MONTHS_NL[d.getMonth()]}`;
};

/** de keuze van de user voor dit item: eerst expliciet verkozen, dan gepind */
function chosenChainOf(item: ItemRow, myChains: string[]): string | null {
  const m = item.matches ?? {};
  const preferred = Object.keys(m).find((c) => m[c]?.preferred && m[c]?.user_pinned);
  if (preferred) return preferred;
  return [...myChains, ...Object.keys(m)].find((c) => m[c]?.user_pinned) ?? null;
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

export default function BoodschappenScreen() {
  const insets = useSafeAreaInsets();
  const { rows: listRows } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [myChains, setMyChains] = useState<string[]>(['ah']);
  const [pricing, setPricing] = useState<ChainPricing[] | null>(null);
  const [detailItem, setDetailItem] = useState<ItemRow | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [members, setMembers] = useState<MemberInfo[]>([]);
  // het draft-model: null = live (opgeslagen) weergave; anders het concept
  const [draftItems, setDraftItems] = useState<ItemRow[] | null>(null);
  const [draftCorrections, setDraftCorrections] = useState<Correction[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'save' | 'load'>('none');
  const [templateName, setTemplateName] = useState('');
  // grijze "Alles bij X"-rij uitgeklapt: welke keten, en voor welk item de
  // alternatieven-kiezer openstaat (één tegelijk — anders wordt het een muur)
  const [expandedChain, setExpandedChain] = useState<string | null>(null);
  const [resolveItemId, setResolveItemId] = useState<string | null>(null);

  // naam-bewerken in de item-sheet: draft volgt het geopende item
  useEffect(() => {
    setNameDraft(detailItem?.name ?? '');
  }, [detailItem?.id]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // jouw supers uit Profiel: kv-cache direct, /v1/me als waarheid
  useEffect(() => {
    (async () => {
      try {
        const cached = await kv.getItem('prakkie.mychains');
        if (cached) {
          const arr = (JSON.parse(cached) as string[]).filter((c) => ALL_CHAINS.includes(c));
          if (arr.length) setMyChains(arr);
        }
      } catch { /* cache is optioneel */ }
      try {
        const res = await authedRequest('/v1/me');
        if (res.ok) {
          const me = (await res.json()) as { home_chain_ids?: string[] };
          const arr = (me.home_chain_ids ?? []).filter((c) => ALL_CHAINS.includes(c));
          if (arr.length) {
            setMyChains(arr);
            kv.setItem('prakkie.mychains', JSON.stringify(arr)).catch(() => {});
          }
        }
      } catch { /* offline: cache/fallback */ }
    })();
    loadHousehold().then((h) => setMembers(h.members)).catch(() => {});
  }, []);

  const lists = useMemo(
    () => listRows.map((r) => ({ ...(r.row as unknown as ListRow), id: r.id })),
    [listRows]
  );
  const dateOf = (l: ListRow) => (l.week_start ?? '').slice(0, 10);
  const dotDates = useMemo(() => new Set(lists.map(dateOf).filter(Boolean)), [lists]);
  // opgeslagen lijstjes = lijsten zonder datum (templates)
  const templates = useMemo(() => lists.filter((l) => !dateOf(l)), [lists]);

  // week-strip: 7 dagen, pijlen wisselen van week
  const weekStart = useMemo(() => mondayOf(weekOffset), [weekOffset]);
  const weekDays = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)),
    [weekStart]
  );

  const dayLists = useMemo(
    () => lists.filter((l) => dateOf(l) === selectedDate),
    [lists, selectedDate]
  );
  const list = dayLists.find((l) => l.id === activeListId) ?? dayLists[0] ?? null;
  const items = useMemo(
    () => itemRows.map((r) => r.row as unknown as ItemRow).filter((i) => list && i.list_id === list.id),
    [itemRows, list]
  );
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
    }
    return ok;
  }

  async function shiftWeek(delta: number) {
    if (!(await discardDraftGuard())) return;
    const idx = weekDays.indexOf(selectedDate);
    const next = mondayOf(weekOffset + delta);
    setWeekOffset(weekOffset + delta);
    setSelectedDate(addDays(next, idx >= 0 ? idx : 0));
    setDetailItem(null);
  }
  async function selectDay(date: string) {
    if (date === selectedDate) return;
    if (!(await discardDraftGuard())) return;
    setSelectedDate(date);
    setDetailItem(null);
  }
  async function jumpToToday() {
    if (!(await discardDraftGuard())) return;
    setWeekOffset(0);
    setSelectedDate(todayIso());
  }

  // log: wie heeft als laatst iets toegevoegd (huishouden)
  const lastAdded = useMemo(() => {
    const withTime = items.filter((i) => i.created_at);
    if (!withTime.length) return null;
    const last = withTime.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]!;
    const who = memberName(members, last.added_by);
    return who ? { who, what: last.name } : null;
  }, [items, members]);

  const refreshPricing = useCallback(async () => {
    if (!list || items.length === 0) {
      setPricing(null);
      return;
    }
    try {
      await syncNow(['lists', 'list_items']);
      const res = await authedRequest(`/v1/lists/${list.id}/price?chains=${myChains.join(',')}`);
      if (res.ok) setPricing(((await res.json()) as { chains: ChainPricing[] }).chains);
    } catch {
      /* offline — lijst blijft bruikbaar */
    }
  }, [list?.id, items.length, myChains.join(',')]);

  useEffect(() => {
    const t = setTimeout(refreshPricing, 350);
    return () => clearTimeout(t);
  }, [refreshPricing]);

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
      const alt = item._alt_cents?.[chain];
      if (isCount(item)) {
        const unit =
          alt ??
          (line?.matched && line.line_price_cents != null
            ? line.line_price_cents / Math.max(1, line.packs ?? 1)
            : null);
        return unit === null || unit === undefined ? null : Math.round(unit * countQty(item));
      }
      return line?.matched && line.line_price_cents != null ? line.line_price_cents : alt ?? null;
    },
    [linesByChain]
  );

  /** alleen betrouwbare regels tellen mee in totalen: gepind of hoge confidence */
  const reliableCentsAt = useCallback(
    (item: ItemRow, chain: string): number | null => {
      const pinnedHere = !!item.matches?.[chain]?.user_pinned;
      const line = linesByChain.get(chain)?.get(item.id);
      if (!pinnedHere && !(line?.matched && (line.confidence ?? 0) >= MIN_CONFIDENCE)) return null;
      return lineCentsAt(item, chain);
    },
    [linesByChain, lineCentsAt]
  );

  const openItems = useMemo(() => displayItems.filter((i) => !i.checked), [displayItems]);

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

  // Waar ga je halen? — alles-bij-X per super + slim verdelen; niet-complete
  // supers grijs zonder totaal (een half totaal zou liegen)
  const storeAdvice = useMemo(() => {
    if (!pricing || openItems.length === 0) return null;
    const singles = myChains
      .filter((c) => linesByChain.has(c))
      .map((c) => {
        let total = 0;
        const missingItems: ItemRow[] = [];
        for (const item of openItems) {
          const cents = reliableCentsAt(item, c);
          if (cents != null) total += cents;
          else missingItems.push(item);
        }
        return { chain_id: c, total_cents: total, missing: missingItems.length, missingItems, complete: missingItems.length === 0 };
      })
      .sort((a, b) => Number(b.complete) - Number(a.complete) || a.total_cents - b.total_cents || a.missing - b.missing);
    if (!singles.length) return null;
    const best = singles[0]!.complete ? singles[0]! : null;

    let split: { total: number; counts: Map<string, number>; missing: number } | null = null;
    if (myChains.length >= 2) {
      let total = 0;
      let missing = 0;
      const counts = new Map<string, number>();
      for (const item of openItems) {
        let bestLine: { chain: string; cents: number } | null = null;
        for (const c of myChains) {
          const cents = reliableCentsAt(item, c);
          if (cents != null && (bestLine === null || cents < bestLine.cents)) bestLine = { chain: c, cents };
        }
        if (!bestLine) { missing++; continue; }
        total += bestLine.cents;
        counts.set(bestLine.chain, (counts.get(bestLine.chain) ?? 0) + 1);
      }
      split = { total, counts, missing };
    }
    const savings = split && best ? best.total_cents - split.total : 0;
    return { singles, best, split, savings };
  }, [pricing, openItems, myChains, linesByChain, reliableCentsAt]);

  // zoekresultaten over ál je supers
  const searchOptions = useCrossChainOptions(searchDebounced || null, myChains);

  async function toggle(item: ItemRow) {
    // afvinken is winkel-modus: direct, tenzij er al een concept openstaat
    if (hasDraft || !items.some((i) => i.id === item.id)) {
      mutateDraft((rows) => rows.map((r) => (r.id === item.id ? { ...r, checked: !r.checked } : r)));
      return;
    }
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, checked: !item.checked }, item.id);
    syncNow(['list_items']).catch(() => {});
  }

  async function newList(date: string): Promise<string> {
    const id = newId();
    await upsertRow(
      'lists',
      {
        name: dayLists.length ? `Lijst ${dayLists.length + 1}` : `Boodschappen ${dutchDate(date)}`,
        week_start: date,
        household_id: await activeHouseholdId(), // gedeeld met het huishouden
      },
      id
    );
    setActiveListId(id);
    syncNow(['lists']).catch(() => {});
    return id;
  }

  /** zoek-eerst: in het concept — mét productkeuze (tap op resultaat) of zonder. */
  async function addFromSearch(option?: CrossChainOption) {
    const typed = search.trim();
    if (!typed) return;
    setSearch('');
    setSearchDebounced('');
    const listId = list?.id ?? (await newList(selectedDate));
    const itemId = newId();
    const fresh: ItemRow = {
      id: itemId,
      list_id: listId,
      name: option ? option.name : typed,
      quantity: null,
      unit: null,
      aisle_group_id: null,
      checked: false,
      is_manual: true,
      item_normalised: null,
      ...(option
        ? {
            matches: { [option.chain]: { sku_id: option.sku_id, confidence: 1, user_pinned: true, preferred: true } },
            _alt_cents: { [option.chain]: option.promo_price_cents ?? option.price_cents },
          }
        : {}),
    };
    mutateDraft((rows) => [...rows, fresh]);
    if (option) {
      setDraftCorrections((c) => [
        ...c,
        { chain_id: option.chain, item_normalised: typed.toLowerCase(), chosen_sku_id: option.sku_id },
      ]);
    }
    // verrijking (hoeveelheid/normalisatie op de gétypte term) — offline geen punt
    try {
      const res = await authedRequest(`/v1/match?item=${encodeURIComponent(typed)}&chains=${myChains[0]}`);
      if (res.ok) {
        const body = (await res.json()) as {
          item: string; aisle_group_id: number | null; quantity: number | null; unit: string | null;
        };
        setDraftItems((rows) =>
          rows
            ? rows.map((r) =>
                r.id === itemId
                  ? {
                      ...r,
                      ...(option ? {} : { name: body.quantity != null ? body.item : typed }),
                      quantity: body.quantity,
                      unit: body.unit,
                      item_normalised: body.item,
                      aisle_group_id: body.aisle_group_id,
                    }
                  : r
              )
            : rows
        );
      }
    } catch { /* offline: item blijft staan */ }
  }

  /** productkeuze (cross-chain): producttitel wordt de itemnaam, keuze in concept. */
  function pinProduct(item: ItemRow, option: CrossChainOption) {
    const matches: Record<string, MatchEntry> = {};
    for (const [c, entry] of Object.entries(item.matches ?? {})) {
      const { preferred: _preferred, ...rest } = entry;
      matches[c] = rest;
    }
    matches[option.chain] = { sku_id: option.sku_id, confidence: 1, user_pinned: true, preferred: true };
    const unitCents = option.promo_price_cents ?? option.price_cents;
    mutateDraft((rows) =>
      rows.map((r) =>
        r.id === item.id
          ? { ...r, name: option.name, matches, _alt_cents: { ...(r._alt_cents ?? {}), [option.chain]: unitCents } }
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

  /** "Alles bij Aldi" → heel lijstje wisselt naar de producten daar (in concept) */
  async function convertAllTo(chain: string) {
    const ok = await confirmDialog({
      title: `Alles bij ${chainName(chain)}?`,
      message: 'Elk item wisselt naar het gematchte product daar. Items zonder match blijven zoals ze waren. Niks is definitief tot je op Opslaan tikt.',
      confirmLabel: 'Wissel',
    });
    if (!ok) return;
    mutateDraft((rows) =>
      rows.map((r) => {
        const line = linesByChain.get(chain)?.get(r.id);
        if (!(line?.matched && line.sku_id)) return r;
        const matches: Record<string, MatchEntry> = {};
        for (const [c, entry] of Object.entries(r.matches ?? {})) {
          const { preferred: _preferred, ...rest } = entry;
          matches[c] = rest;
        }
        matches[chain] = { sku_id: line.sku_id, confidence: 1, user_pinned: true, preferred: true };
        const unitCents =
          line.line_price_cents != null ? Math.round(line.line_price_cents / Math.max(1, line.packs ?? 1)) : null;
        return {
          ...r,
          matches,
          name: line.product_name ?? r.name,
          ...(unitCents != null ? { _alt_cents: { ...(r._alt_cents ?? {}), [chain]: unitCents } } : {}),
        };
      })
    );
  }

  /** alternatief kiezen voor een ontbrekend product bij keten X: maakt het item
   *  daar betrouwbaar-gematcht (pin zónder preferred — de groep van het item
   *  verandert niet, alleen "Alles bij X" wordt compleet en dus tikbaar). */
  function resolveAlternative(item: ItemRow, chain: string, option: ProductOption) {
    const unitCents = option.promo_price_cents ?? option.price_cents;
    mutateDraft((rows) =>
      rows.map((r) =>
        r.id === item.id
          ? {
              ...r,
              matches: { ...(r.matches ?? {}), [chain]: { sku_id: option.sku_id, confidence: 1, user_pinned: true } },
              _alt_cents: { ...(r._alt_cents ?? {}), [chain]: unitCents },
            }
          : r
      )
    );
    setDraftCorrections((c) => [
      ...c,
      { chain_id: chain, item_normalised: item.item_normalised ?? item.name.toLowerCase(), chosen_sku_id: option.sku_id },
    ]);
    setResolveItemId(null);
  }

  function renameItem(item: ItemRow) {
    const next = nameDraft.trim();
    if (!next || next === item.name) return;
    mutateDraft((rows) => rows.map((r) => (r.id === item.id ? { ...r, name: next, item_normalised: null } : r)));
    setDetailItem((d) => (d && d.id === item.id ? { ...d, name: next, item_normalised: null } : d));
  }

  function bumpQty(item: ItemRow, delta: number) {
    const current = Number(item.quantity) || 1;
    const next = Math.max(1, Math.round((current + delta) * 100) / 100);
    mutateDraft((rows) => rows.map((r) => (r.id === item.id ? { ...r, quantity: next } : r)));
    setDetailItem((d) => (d && d.id === item.id ? { ...d, quantity: next } : d));
  }

  /** Opslaan: het concept wordt de waarheid — diff tegen de opgeslagen staat. */
  async function saveDraft() {
    if (!draftItems || !list) return;
    setSavingDraft(true);
    try {
      const base = new Map(items.map((i) => [i.id, i]));
      for (const d of draftItems) {
        const b = base.get(d.id);
        base.delete(d.id);
        const fields = itemFields(d);
        if (!b || JSON.stringify(itemFields(b)) !== JSON.stringify(fields)) {
          await upsertRow('list_items', fields, d.id);
        }
      }
      for (const gone of base.keys()) await deleteRow('list_items', gone);
      for (const corr of draftCorrections) await upsertRow('match_corrections', corr as unknown as Record<string, unknown>);
      setDraftItems(null);
      setDraftCorrections([]);
      await syncNow(['list_items', 'match_corrections']).catch(() => {});
      refreshPricing();
    } finally {
      setSavingDraft(false);
    }
  }

  function cancelDraft() {
    setDraftItems(null);
    setDraftCorrections([]);
    setDetailItem(null);
  }

  /** hele lijst weg — met bevestiging; items gaan mee. */
  async function removeList(target: ListRow) {
    const ok = await confirmDialog({
      title: 'Lijst verwijderen?',
      message: `“${target.name}” en alle items verdwijnen — ook voor je huishouden.`,
      confirmLabel: 'Verwijderen',
      destructive: true,
    });
    if (!ok) return;
    const children = itemRows
      .map((r) => ({ id: r.id, row: r.row as unknown as ItemRow }))
      .filter((r) => r.row.list_id === target.id);
    for (const c of children) await deleteRow('list_items', c.id);
    await deleteRow('lists', target.id);
    setActiveListId(null);
    setPricing(null);
    setDraftItems(null);
    setDraftCorrections([]);
    syncNow(['lists', 'list_items']).catch(() => {});
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

  /** laad een opgeslagen lijstje in de geselecteerde dag (in concept) */
  async function loadTemplate(template: ListRow) {
    const tplItems = itemRows
      .map((r) => r.row as unknown as ItemRow)
      .filter((i) => i.list_id === template.id);
    if (!tplItems.length) {
      notice('Leeg lijstje', 'Dit opgeslagen lijstje heeft geen items.');
      return;
    }
    const listId = list?.id ?? (await newList(selectedDate));
    mutateDraft((rows) => [
      ...rows,
      ...tplItems.map((it) => ({ ...it, id: newId(), list_id: listId, checked: false, _alt_cents: undefined })),
    ]);
    setSheet('none');
  }

  async function removeTemplate(template: ListRow) {
    const ok = await confirmDialog({
      title: 'Opgeslagen lijstje verwijderen?',
      message: `“${template.name}” verdwijnt uit je opgeslagen lijstjes.`,
      confirmLabel: 'Verwijderen',
      destructive: true,
    });
    if (!ok) return;
    const children = itemRows
      .map((r) => ({ id: r.id, row: r.row as unknown as ItemRow }))
      .filter((r) => r.row.list_id === template.id);
    for (const c of children) await deleteRow('list_items', c.id);
    await deleteRow('lists', template.id);
    syncNow(['lists', 'list_items']).catch(() => {});
  }

  const qtyLabel = (i: ItemRow) =>
    i.quantity ? ` · ${String(i.quantity).replace('.', ',')}${i.unit ? ` ${i.unit}` : ' st'}` : '';
  const initialOf = (userId: string | null | undefined) =>
    (memberName(members, userId) ?? '?').slice(0, 1).toUpperCase();
  const chainDot = (c: string, size = 18) => {
    const brand = CHAIN_BRAND[c];
    if (!brand) return null;
    return (
      <View style={[styles.chainDot, { backgroundColor: brand.bg, width: size, height: size, borderRadius: size / 2 }]}>
        <Text style={[styles.chainDotText, { color: brand.fg, fontSize: size < 20 ? 7 : 8 }]}>{chainChip(c)}</Text>
      </View>
    );
  };

  const searching = searchDebounced.length > 0;
  const templateCount = (t: ListRow) =>
    itemRows.filter((r) => (r.row as unknown as ItemRow).list_id === t.id).length;

  const itemRowView = (item: ItemRow, idx: number, groupChain: string | null, count: number) => {
    const chain = chosenChainOf(item, myChains);
    const cents = chain && !item.checked ? lineCentsAt(item, chain) : null;
    const line = chain ? linesByChain.get(chain)?.get(item.id) : undefined;
    const promoActive = !!line?.promo && (line?.promo_savings_cents ?? 0) > 0;
    const recipes = (item.provenance ?? []).map((p) => p.recipe_title ?? p.title).filter(Boolean);
    return (
      <View key={item.id} style={[styles.itemRow, idx < count - 1 && styles.itemBorder]}>
        <Pressable onPress={() => toggle(item)} hitSlop={6}>
          <View style={[styles.checkbox, item.checked && styles.checkboxOn]}>
            {item.checked ? <Check size={12} color={colors.onPrimary} strokeWidth={3} /> : null}
          </View>
        </Pressable>
        <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => setDetailItem(item)}>
          <View style={styles.itemNameRow}>
            <Text style={[styles.itemName, item.checked && styles.checkedText]} numberOfLines={1}>
              {item.name}
              {qtyLabel(item)}
            </Text>
            {members.length > 1 && item.added_by ? (
              <View style={styles.byChip}>
                <Text style={styles.byChipText}>{initialOf(item.added_by)}</Text>
              </View>
            ) : null}
            {recipes.length > 1 ? <Text style={styles.mergedBadge}>{recipes.length} recepten</Text> : null}
            {promoActive && !item.checked ? <Text style={styles.bonusBadge}>Bonus</Text> : null}
          </View>
          {!item.checked && recipes.length && !chain ? (
            <Text style={styles.subline} numberOfLines={1}>uit: {recipes.join(' + ')}</Text>
          ) : null}
        </Pressable>
        <Pressable onPress={() => setDetailItem(item)} hitSlop={8} style={styles.priceCol}>
          {chain && cents != null ? (
            <Text style={[styles.price, item.checked && { color: '#B9C0B2' }]}>{formatEuroCents(cents)}</Text>
          ) : !item.checked ? (
            <View style={styles.choosePill}>
              <Text style={styles.choosePillText}>Kies</Text>
            </View>
          ) : null}
        </Pressable>
        {/* owner: verwijderen zonder eerst te hoeven openen — en altijd annuleerbaar */}
        <Pressable onPress={() => removeItemRow(item)} hitSlop={8} accessibilityLabel={`Verwijder ${item.name}`}>
          <Trash2 size={15} color="#B9C0B2" strokeWidth={2} />
        </Pressable>
      </View>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Boodschappen</Text>

        {/* week-strip: 7 dagen, puntjes = dagen met een lijst */}
        <View style={styles.weekCard}>
          <View style={styles.weekHeader}>
            <Pressable onPress={() => shiftWeek(-1)} hitSlop={10} accessibilityLabel="Vorige week">
              <ChevronLeft size={18} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
            <Pressable onPress={jumpToToday} hitSlop={6} accessibilityLabel="Naar vandaag">
              <Text style={styles.weekLabel}>{weekRangeLabel(weekStart)}</Text>
            </Pressable>
            <Pressable onPress={() => shiftWeek(1)} hitSlop={10} accessibilityLabel="Volgende week">
              <ChevronRight size={18} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
          </View>
          <View style={styles.weekRow}>
            {weekDays.map((date, i) => {
              const selected = date === selectedDate;
              const isToday = date === todayIso();
              return (
                <Pressable key={date} style={styles.weekCell} onPress={() => selectDay(date)}>
                  <Text style={[styles.weekdayLabel, selected && { color: colors.primary }]}>{DAYS_NL[i]}</Text>
                  <View style={[styles.weekDay, isToday && styles.weekToday, selected && styles.weekSelected]}>
                    <Text style={[styles.weekDayText, selected && { color: colors.onPrimary, fontFamily: fonts.bodyBold }]}>
                      {Number(date.slice(8))}
                    </Text>
                  </View>
                  <View style={[styles.weekDot, { opacity: dotDates.has(date) ? 1 : 0 }]} />
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.dayHeader}>
          <Text style={styles.dayTitle}>{dutchDate(selectedDate)}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            {displayItems.length > 0 ? (
              <Pressable
                onPress={() => { setTemplateName(list?.name ?? ''); setSheet('save'); }}
                hitSlop={8}
                accessibilityLabel="Bewaar dit lijstje"
              >
                <BookmarkPlus size={17} color={colors.primary} strokeWidth={2} />
              </Pressable>
            ) : null}
            <Pressable onPress={() => setSheet('load')} hitSlop={8} accessibilityLabel="Opgeslagen lijstjes">
              <Bookmark size={16} color={templates.length ? colors.primary : '#B9C0B2'} strokeWidth={2} />
            </Pressable>
            {list ? (
              <Pressable onPress={() => removeList(list)} hitSlop={8} accessibilityLabel="Lijst verwijderen">
                <Trash2 size={16} color={colors.danger} strokeWidth={2} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {dayLists.length > 1 ? (
          <View style={styles.tabs}>
            {dayLists.map((l) => (
              <Pressable
                key={l.id}
                onPress={async () => {
                  if (l.id === list?.id) return;
                  if (!(await discardDraftGuard())) return;
                  setActiveListId(l.id);
                }}
                style={[styles.tab, list?.id === l.id && styles.tabActive]}
              >
                <Text style={[styles.tabText, list?.id === l.id && styles.tabTextActive]}>{l.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* zoek-eerst: één balk voor ál je supers — werkt ook zonder lijst */}
        <View style={styles.searchBar}>
          <Search size={15} color="#97A08F" strokeWidth={2.2} />
          <TextInput
            style={styles.searchInput}
            placeholder="Zoek en vergelijk: melk, roomboter, hagelslag…"
            placeholderTextColor="#97A08F"
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={() => addFromSearch()}
            returnKeyType="done"
            autoCapitalize="none"
          />
          {search ? (
            <Pressable onPress={() => { setSearch(''); setSearchDebounced(''); }} hitSlop={8}>
              <X size={15} color="#97A08F" />
            </Pressable>
          ) : null}
        </View>

        {searching ? (
          <View style={styles.resultsCard}>
            <Pressable style={styles.plainAddRow} onPress={() => addFromSearch()}>
              <View style={styles.plainAddIcon}>
                <Plus size={14} color={colors.primary} strokeWidth={2.6} />
              </View>
              <Text style={styles.plainAddText}>
                Zet “{searchDebounced}” op de lijst <Text style={{ color: '#97A08F' }}>— product later kiezen</Text>
              </Text>
            </Pressable>
            {searchOptions === null ? (
              <Text style={[type.meta, { paddingVertical: 10 }]}>Prijzen vergelijken…</Text>
            ) : searchOptions.length === 0 ? (
              <Text style={[type.meta, { paddingVertical: 10 }]}>
                Geen producten gevonden bij {myChains.map(chainName).join(', ')}.
              </Text>
            ) : (
              <CrossChainList options={searchOptions} maxRows={30} onPick={(opt) => addFromSearch(opt)} />
            )}
          </View>
        ) : null}

        {list || displayItems.length > 0 ? (
          <>
            <Text style={styles.metaLine}>
              {displayItems.length} items · {checkedCount} afgevinkt
              {lastAdded ? ` · laatst: ${lastAdded.who} — ${lastAdded.what}` : ''}
            </Text>

            {chainGroups.length === 0 ? (
              <Text style={[type.meta, { textAlign: 'center', marginTop: 30 }]}>
                Nog niets op de lijst. Zoek hierboven, laad een opgeslagen lijstje, of voeg toe vanuit een recept.
              </Text>
            ) : (
              chainGroups.map(({ chain, items: groupItems, subtotal, priced }) => (
                <View key={chain ?? 'none'}>
                  <View style={styles.groupHeader}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                      {chain ? chainDot(chain, 18) : null}
                      <Text style={styles.groupTitle}>{chain ? chainName(chain).toUpperCase() : 'NOG TE KIEZEN'}</Text>
                    </View>
                    {chain && priced > 0 ? (
                      <Text style={styles.groupSubtotal}>{formatEuroCents(subtotal)}</Text>
                    ) : null}
                  </View>
                  <View style={styles.groupCard}>
                    {groupItems.map((item, idx) => itemRowView(item, idx, chain, groupItems.length))}
                  </View>
                </View>
              ))
            )}

            {/* Waar ga je halen? — tik een complete super aan om ALLES daarheen te wisselen */}
            {storeAdvice ? (
              <View style={{ marginTop: 6 }}>
                <Text style={styles.groupTitle}>WAAR GA JE HALEN?</Text>
                <View style={styles.groupCard}>
                  {storeAdvice.singles.map((s, idx) => (
                    <View key={s.chain_id}>
                      <Pressable
                        onPress={() =>
                          s.complete
                            ? convertAllTo(s.chain_id)
                            : (setExpandedChain(expandedChain === s.chain_id ? null : s.chain_id), setResolveItemId(null))
                        }
                        style={[
                          styles.adviceRow,
                          (idx < storeAdvice.singles.length - 1 || storeAdvice.split) && styles.itemBorder,
                          !s.complete && styles.adviceRowGrey,
                        ]}
                      >
                        {chainDot(s.chain_id, 22)}
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.adviceName}>
                            Alles bij {chainName(s.chain_id)}
                            {storeAdvice.best && s.chain_id === storeAdvice.best.chain_id ? (
                              <Text style={styles.adviceBest}>  · voordeligste</Text>
                            ) : null}
                          </Text>
                          <Text style={styles.subline}>
                            {s.complete
                              ? 'tik om het hele lijstje hierheen te wisselen'
                              : `${s.missing} product${s.missing === 1 ? '' : 'en'} ontbreek${s.missing === 1 ? 't' : 'en'} — tik om alternatieven te kiezen`}
                          </Text>
                        </View>
                        <Text style={styles.advicePrice}>{s.complete ? `± ${formatEuroCents(s.total_cents)}` : '—'}</Text>
                      </Pressable>
                      {/* uitgeklapt: per ontbrekend product de app-suggesties bij deze super */}
                      {!s.complete && expandedChain === s.chain_id ? (
                        <View style={styles.missingWrap}>
                          {s.missingItems.map((mi) => (
                            <View key={mi.id} style={styles.missingItem}>
                              <Pressable
                                style={styles.missingHeader}
                                onPress={() => setResolveItemId(resolveItemId === mi.id ? null : mi.id)}
                              >
                                <Text style={styles.missingName} numberOfLines={1}>{mi.name}</Text>
                                <Text style={styles.missingCta}>
                                  {resolveItemId === mi.id ? 'sluit' : 'kies alternatief'}
                                </Text>
                              </Pressable>
                              {resolveItemId === mi.id ? (
                                <ProductOptions
                                  term={mi.item_normalised ?? mi.name}
                                  chain={s.chain_id}
                                  currentSku={mi.matches?.[s.chain_id]?.user_pinned ? mi.matches[s.chain_id]!.sku_id : null}
                                  onPick={(o) => resolveAlternative(mi, s.chain_id, o)}
                                  maxRows={3}
                                  searchable={false}
                                />
                              ) : null}
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  ))}
                  {storeAdvice.split ? (
                    <View style={styles.adviceRow}>
                      <View style={styles.splitIcon}>
                        <Text style={styles.splitIconText}>{storeAdvice.split.counts.size}×</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.adviceName}>
                          Slim verdelen
                          {storeAdvice.savings > 0 ? (
                            <Text style={styles.adviceSave}>  · bespaar {formatEuroCents(storeAdvice.savings)}</Text>
                          ) : null}
                        </Text>
                        <Text style={styles.subline} numberOfLines={1}>
                          {storeAdvice.savings > 0 || !storeAdvice.best
                            ? [
                                [...storeAdvice.split.counts.entries()].map(([c, n]) => `${chainName(c)} ${n}`).join(' · '),
                                storeAdvice.split.missing > 0 ? `mist ${storeAdvice.split.missing}` : null,
                              ].filter(Boolean).join(' · ')
                            : 'één winkel is hier al het voordeligst'}
                        </Text>
                      </View>
                      {storeAdvice.savings > 0 || !storeAdvice.best ? (
                        <Text style={[styles.advicePrice, { color: colors.primary }]}>± {formatEuroCents(storeAdvice.split.total)}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                <Text style={styles.adviceFootnote}>
                  ± schatting op beste match per item — jouw eigen keuzes tellen exact mee.
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={[type.meta, { textAlign: 'center', marginTop: 20 }]}>
            Nog geen boodschappen op {dutchDate(selectedDate)}. Zoek hierboven je eerste item — de lijst maakt zichzelf.
          </Text>
        )}
      </ScrollView>

      {/* footer: bij een concept wordt dit de Opslaan/Annuleren-balk */}
      {hasDraft ? (
        <View style={[styles.footerWrap, { paddingBottom: insets.bottom + 96 }]}>
          <View style={styles.footerCard}>
            <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
              <Text style={styles.footerLabel}>Niet opgeslagen</Text>
              <Text style={styles.footerTotal}>{formatEuroCents(chosenTotal.cents)}</Text>
              <Text style={[styles.footerLabel, { color: 'rgba(253,251,246,.75)' }]}>
                {chosenTotal.open > 0 ? `${chosenTotal.open} nog te kiezen` : 'alles gekozen'}
              </Text>
            </View>
            <Pressable onPress={cancelDraft} style={styles.cancelBtn} disabled={savingDraft}>
              <Text style={styles.cancelBtnText}>Annuleer</Text>
            </Pressable>
            <Pressable onPress={saveDraft} style={styles.saveBtn} disabled={savingDraft}>
              <Text style={styles.saveBtnText}>{savingDraft ? 'Opslaan…' : 'Opslaan'}</Text>
            </Pressable>
          </View>
        </View>
      ) : list && displayItems.length > 0 ? (
        <View style={[styles.footerWrap, { paddingBottom: insets.bottom + 96 }]}>
          <View style={styles.footerCard}>
            <View style={{ gap: 2, flex: 1 }}>
              <Text style={styles.footerLabel}>Jouw keuzes ({chosenTotal.chosen} van {openItems.length})</Text>
              <Text style={styles.footerTotal}>{formatEuroCents(chosenTotal.cents)}</Text>
              <Text style={[styles.footerLabel, { color: 'rgba(253,251,246,.75)' }]}>
                {chosenTotal.open > 0
                  ? `${chosenTotal.open} item${chosenTotal.open === 1 ? '' : 's'} nog te kiezen`
                  : 'alles gekozen — geen verrassingen'}
              </Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* item-sheet: hoeveelheid, verwijderen, en DE productkeuze over ál je supers */}
      {detailItem ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <TextInput
              style={styles.nameEdit}
              value={nameDraft}
              onChangeText={setNameDraft}
              onEndEditing={() => renameItem(detailItem)}
              onSubmitEditing={() => renameItem(detailItem)}
              returnKeyType="done"
            />
            <Pressable onPress={() => setDetailItem(null)} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          <View style={styles.qtyRow}>
            <View style={styles.qtyStepper}>
              <Pressable onPress={() => bumpQty(detailItem, -1)} hitSlop={8} style={styles.qtyBtn}>
                <Minus size={15} color={colors.text} strokeWidth={2.2} />
              </Pressable>
              <Text style={styles.qtyValue}>
                {String(detailItem.quantity ?? 1).replace('.', ',')}{detailItem.unit ? ` ${detailItem.unit}` : '×'}
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
            <CrossChainOptions
              term={detailItem.item_normalised ?? detailItem.name}
              chains={myChains}
              currentSku={(() => {
                const c = chosenChainOf(detailItem, myChains);
                return c ? detailItem.matches?.[c]?.sku_id ?? null : null;
              })()}
              onPick={(o) => pinProduct(detailItem, o)}
            />
          </ScrollView>
        </View>
      ) : null}

      {/* bewaar-sheet: naam kiezen voor het opgeslagen lijstje */}
      {sheet === 'save' ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>Lijstje bewaren</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10}>
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
          <Pressable style={styles.sheetCta} onPress={saveTemplate}>
            <Text style={styles.sheetCtaText}>Bewaar lijstje</Text>
          </Pressable>
        </View>
      ) : null}

      {/* laad-sheet: kies uit opgeslagen lijstjes */}
      {sheet === 'load' ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>Opgeslagen lijstjes</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>
          {templates.length === 0 ? (
            <Text style={[type.meta, { paddingVertical: 12 }]}>
              Nog geen opgeslagen lijstjes. Bewaar er eentje via het bladwijzer-plusje boven je lijst.
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: 340 }} showsVerticalScrollIndicator={false}>
              {templates.map((t, idx) => (
                <View key={t.id} style={[styles.templateRow, idx < templates.length - 1 && styles.itemBorder]}>
                  <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => loadTemplate(t)}>
                    <Text style={styles.itemName} numberOfLines={1}>{t.name}</Text>
                    <Text style={styles.subline}>{templateCount(t)} items · tik om in {dutchDate(selectedDate)} te laden</Text>
                  </Pressable>
                  <Pressable onPress={() => removeTemplate(t)} hitSlop={8} accessibilityLabel={`Verwijder ${t.name}`}>
                    <Trash2 size={15} color="#B9C0B2" strokeWidth={2} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 260, gap: 10 },
  title: { fontFamily: fonts.display, fontSize: 29, lineHeight: 32, color: colors.text },
  weekCard: {
    backgroundColor: colors.surface, borderRadius: 18, padding: 12, gap: 8,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
  },
  weekHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2 },
  weekLabel: { fontFamily: fonts.bodySemiBold, fontSize: 13.5, color: colors.text },
  weekRow: { flexDirection: 'row' },
  weekCell: { flex: 1, alignItems: 'center', gap: 3 },
  weekdayLabel: { fontSize: 10, fontFamily: fonts.bodyBold, color: colors.textMuted },
  weekDay: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  weekToday: { borderWidth: 1.5, borderColor: colors.primary },
  weekSelected: { backgroundColor: colors.primary },
  weekDayText: { fontSize: 13, color: colors.text },
  weekDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.primary },
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
    flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.surface,
    borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
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
  chainDot: { alignItems: 'center', justifyContent: 'center' },
  chainDotText: { fontFamily: fonts.bodyBold },
  groupHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 8, marginBottom: 7, paddingHorizontal: 2,
  },
  groupTitle: {
    fontSize: 11.5, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: colors.textMuted,
  },
  groupSubtotal: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.textSoft },
  groupCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 16, overflow: 'hidden',
  },
  itemRow: { paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 11 },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  checkbox: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 1.8, borderColor: 'rgba(34,48,30,.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  itemNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
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
  choosePill: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill,
    backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: 'rgba(46,107,62,.25)',
  },
  choosePillText: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.primary },
  adviceRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 11 },
  adviceRowGrey: { opacity: 0.55 },
  missingWrap: {
    backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)',
    paddingHorizontal: 14, paddingVertical: 4,
  },
  missingItem: { paddingVertical: 4 },
  missingHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 5 },
  missingName: { flex: 1, fontSize: 12.5, color: colors.text },
  missingCta: { fontSize: 11, fontFamily: fonts.bodyBold, color: colors.primary },
  adviceName: { fontSize: 13.5, color: colors.text, fontFamily: fonts.bodySemiBold },
  adviceBest: { fontSize: 10.5, color: colors.primary, fontFamily: fonts.bodyBold },
  adviceSave: { fontSize: 10.5, color: colors.primary, fontFamily: fonts.bodyBold },
  advicePrice: { fontSize: 13.5, fontFamily: fonts.bodyBold, color: colors.text },
  adviceFootnote: { fontSize: 10, color: colors.textMuted, marginTop: 6, paddingHorizontal: 2 },
  splitIcon: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  splitIconText: { fontSize: 8.5, fontFamily: fonts.bodyBold, color: colors.primary },
  footerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  footerCard: {
    backgroundColor: '#22301E', borderRadius: 18, padding: 14, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', gap: 10,
    shadowColor: '#22301E', shadowOpacity: 0.3, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 10,
  },
  footerLabel: { fontSize: 11, color: 'rgba(253,251,246,.6)' },
  footerTotal: { fontSize: 19, fontFamily: fonts.bodyBold, color: '#FDFBF6' },
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
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 9,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
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
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.bg,
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
    backgroundColor: colors.bg, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', fontSize: 13.5, color: colors.text, marginTop: 4,
  },
  templateRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11 },
  sheetCta: {
    backgroundColor: colors.primary, borderRadius: radius.pill, paddingVertical: 12,
    alignItems: 'center', marginTop: 4,
  },
  sheetCtaText: { fontSize: 14, fontFamily: fonts.bodyBold, color: colors.onPrimary },
});
