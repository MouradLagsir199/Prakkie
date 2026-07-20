import { formatEuroCents, type StorePanel, type StorePanelSort } from '@prakkie/shared';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Search, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LijstFooter } from '../../components/store/LijstFooter';
import { CrossChainList, type CrossChainOption } from '../../components/prakkie/ProductOptions';
import { fetchPanelProducts, useDepartment } from '../../store/api';
import { useBoodschappenLijst } from '../../store/lijst';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Categorie-pagina (owner-redesign 2026-07-12): subcategorieën als chips
 * bovenaan, de producten van de gekozen subcategorie er direct onder — alle
 * supers door elkaar, goedkoopste eerst. Eén tik op een rij = op je lijstje.
 * Geen tussenschermen: kiezen en verder.
 */

const SORTS: { key: StorePanelSort; label: string }[] = [
  { key: 'aanbevolen', label: 'Aanbevolen' },
  { key: 'prijs', label: 'Prijs' },
  { key: 'eenheidsprijs', label: 'Per kilo/liter' },
  { key: 'bonus', label: 'Bonus' },
];

export default function CategoriePagina() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { dept } = useLocalSearchParams<{ dept: string }>();
  const { data, chains } = useDepartment(dept ?? null);
  const { count, lastAdded, add } = useBoodschappenLijst();

  const panels = useMemo(() => (data?.panels ?? []).filter((p) => p.product_count > 0), [data]);
  const [panelId, setPanelId] = useState<number | null>(null);
  const panel: StorePanel | null = panels.find((p) => p.id === panelId) ?? panels[0] ?? null;

  const [sort, setSort] = useState<StorePanelSort>('aanbevolen');
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<CrossChainOption[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [searchCoverage, setSearchCoverage] = useState<'none' | 'partial' | 'exact' | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);
  const queryRevision = useRef(0);
  const searchTerm = search.trim();
  const isSearching = searchTerm.length > 0;

  useEffect(() => {
    if (!panel || !chains) return;
    const revision = ++queryRevision.current;
    let live = true;
    if (!search.trim()) {
      setOptions(null);
      setTotal(0);
    }
    setLoadingMore(false);
    setLoading(true);
    setLoadError(false);
    setSearchCoverage(null);
    const t = setTimeout(async () => {
      const departmentSearch = !!search.trim();
      const res = await fetchPanelProducts(panel.id, chains, {
        sort,
        q: search,
        scope: departmentSearch ? 'department' : 'category',
        offset: 0,
        limit: 60,
      });
      if (!live || revision !== queryRevision.current) return;
      if (!res) {
        setOptions([]);
        setTotal(0);
        setLoadError(true);
        setLoading(false);
        return;
      }
      setOptions((res?.products ?? []) as CrossChainOption[]);
      setTotal(res?.total ?? 0);
      setSearchCoverage(res.search_coverage ?? null);
      setLoading(false);
    }, search.trim() ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [panel?.id, chains?.join(','), sort, search, reloadRevision]);

  function pickPanel(p: StorePanel) {
    setPanelId(p.id);
    setSearch(''); // nieuwe subcategorie = schone zoekopdracht
  }

  async function loadMoreProducts() {
    if (!panel || !chains || !options || loadingMore || options.length >= total) return;
    const revision = queryRevision.current;
    setLoadingMore(true);
    try {
      const res = await fetchPanelProducts(panel.id, chains, {
        sort,
        q: search,
        scope: isSearching ? 'department' : 'category',
        offset: options.length,
        limit: 60,
      });
      if (revision !== queryRevision.current) return;
      if (!res) {
        setLoadError(true);
        return;
      }
      setTotal(res.total ?? total);
      setSearchCoverage(res.search_coverage ?? searchCoverage);
      setOptions((current) => {
        const merged = [...(current ?? []), ...(res.products as CrossChainOption[])];
        const seen = new Set<string>();
        return merged.filter((option) => {
          const key = `${option.chain}:${option.sku_id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    } finally {
      if (revision === queryRevision.current) setLoadingMore(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/boodschappen'))}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Terug"
            style={styles.backBtn}
          >
            <ChevronLeft size={20} color={colors.text} strokeWidth={2.4} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title} numberOfLines={1}>{data?.department.name_nl ?? '…'}</Text>
            {panel ? (
              <Text style={type.meta}>
                {isSearching
                  ? loading ? 'Zoeken…' : `${total} resultaten in ${data?.department.name_nl ?? 'de afdeling'}`
                  : `${total || panel.product_count} producten · ${panel.chain_count} ${panel.chain_count === 1 ? 'supermarkt' : 'supermarkten'}`}
              </Text>
            ) : null}
          </View>
        </View>

        {panels.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.panelRow}
            style={styles.bleed}
          >
            {isSearching ? (
              <View style={[styles.panelChip, styles.panelChipActive]} accessibilityRole="text">
                <Search size={13} color={colors.primary} strokeWidth={2.2} />
                <Text style={[styles.panelChipText, styles.panelChipTextActive]} numberOfLines={1}>
                  Heel {data?.department.name_nl ?? 'de afdeling'}
                </Text>
              </View>
            ) : null}
            {panels.map((p) => {
              const active = !isSearching && p.id === panel?.id;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => pickPanel(p)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.panelChip, active && styles.panelChipActive]}
                >
                  {p.image_url ? (
                    <Image source={{ uri: p.image_url }} style={styles.panelThumb} contentFit="contain" />
                  ) : null}
                  <Text style={[styles.panelChipText, active && styles.panelChipTextActive]} numberOfLines={1}>
                    {p.name_nl}
                  </Text>
                  {p.promo_count > 0 ? <View style={styles.panelDot} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      {data && panels.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>Binnenkort in de winkel</Text>
          <Text style={[type.meta, { textAlign: 'center' }]}>
            Deze categorie vullen we nog — kijk snel weer even.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.searchBar}>
            <Search size={14} color={colors.textMuted2} strokeWidth={2.1} />
            <TextInput
              style={styles.searchInput}
              placeholder={data ? `Zoek in ${data.department.name_nl.toLowerCase()}…` : 'Zoeken…'}
              placeholderTextColor={colors.textMuted2}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              returnKeyType="done"
            />
            {loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
            {search ? (
              <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Zoekopdracht wissen">
                <X size={14} color={colors.textMuted2} />
              </Pressable>
            ) : null}
          </View>

          {isSearching && !loading && !loadError && searchCoverage === 'partial' ? (
            <View style={styles.searchNotice}>
              <Text style={styles.searchNoticeTitle}>Geen exacte combinatie gevonden</Text>
              <Text style={styles.searchNoticeBody}>
                Dit zijn de beste matches voor delen van “{searchTerm}” in {data?.department.name_nl ?? 'deze afdeling'}.
              </Text>
            </View>
          ) : null}

          <View style={styles.sortRow}>
            {SORTS.map((s) => (
              <Pressable
                key={s.key}
                onPress={() => setSort(s.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: sort === s.key }}
                style={[styles.sortChip, sort === s.key && styles.sortChipActive]}
              >
                <Text style={[styles.sortChipText, sort === s.key && styles.sortChipTextActive]}>{s.label}</Text>
              </Pressable>
            ))}
          </View>

          {!isSearching && panel && panel.min_price_cents != null ? (
            <Text style={[type.meta, { marginBottom: 4 }]}>vanaf {formatEuroCents(panel.min_price_cents)}</Text>
          ) : null}

          {loadError ? (
            <View style={styles.errorWrap}>
              <Text style={styles.emptyTitle}>Zoeken lukte even niet</Text>
              <Pressable
                style={styles.retryButton}
                onPress={() => setReloadRevision((value) => value + 1)}
                accessibilityRole="button"
              >
                <Text style={styles.loadMoreText}>Opnieuw proberen</Text>
              </Pressable>
            </View>
          ) : options === null ? (
            <Text style={[type.meta, { paddingVertical: 12 }]}>Producten laden…</Text>
          ) : options.length === 0 && !loading ? (
            <Text style={[type.meta, { paddingVertical: 12 }]}> 
              Niets gevonden{search ? ` voor “${search}”` : ''} bij jouw supermarkten.
            </Text>
          ) : (
            <CrossChainList
              options={options}
              maxRows={options.length}
              onPick={(opt) =>
                add({
                  chain: opt.chain,
                  sku_id: opt.sku_id,
                  name: opt.name,
                  unit_cents: opt.promo_price_cents ?? opt.price_cents,
                  // de intent-term van het product zelf als die meekomt, anders
                  // de subcategorie-naam — voedt de wissel-zoeker in de item-sheet
                  term: (opt as { head_term?: string; category_name?: string }).head_term
                    ?? (opt as { category_name?: string }).category_name
                    ?? panel?.name_nl
                    ?? null,
                })
              }
            />
          )}
          {!loading && !loadError && options && options.length < total ? (
            <Pressable
              style={styles.loadMoreButton}
              onPress={loadMoreProducts}
              disabled={loadingMore}
              accessibilityRole="button"
              accessibilityLabel={`Toon meer producten, ${total - options.length} resterend`}
            >
              <Text style={styles.loadMoreText}>
                {loadingMore ? 'Meer producten laden…' : `Toon meer (${total - options.length} resterend)`}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      )}

      <LijstFooter count={count} lastAdded={lastAdded} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, gap: 12, paddingBottom: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  title: { fontFamily: fonts.display, fontSize: 22, lineHeight: 26, color: colors.text },
  bleed: { marginHorizontal: -20 },
  panelRow: { paddingHorizontal: 20, gap: 8, flexDirection: 'row' },
  panelChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderControl, borderRadius: radius.pill,
    paddingLeft: 7, paddingRight: 13, paddingVertical: 6,
  },
  panelChipActive: { backgroundColor: colors.tabPill, borderColor: colors.primary },
  panelThumb: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFFFFF' },
  panelChipText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft, maxWidth: 150 },
  panelChipTextActive: { color: colors.primary },
  panelDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.bonusFlag },
  listContent: { paddingHorizontal: 20, paddingBottom: 130 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8,
    backgroundColor: colors.surface, borderRadius: radius.control,
    borderWidth: 1, borderColor: colors.borderControl, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, fontSize: 13.5, fontFamily: fonts.body, color: colors.text, paddingVertical: 9 },
  searchNotice: {
    marginBottom: 8, borderRadius: radius.control, paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: 'rgba(46,107,62,.18)',
  },
  searchNoticeTitle: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.primary },
  searchNoticeBody: { marginTop: 2, fontSize: 10.5, lineHeight: 14, fontFamily: fonts.body, color: colors.textSoft },
  sortRow: { flexDirection: 'row', gap: 6, paddingBottom: 8 },
  sortChip: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderControl, backgroundColor: colors.surface,
  },
  sortChipActive: { backgroundColor: colors.tabPill, borderColor: colors.primary },
  sortChipText: { fontFamily: fonts.bodySemiBold, fontSize: 11.5, color: colors.textSoft },
  sortChipTextActive: { color: colors.primary },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 40, paddingBottom: 120 },
  emptyTitle: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.text },
  errorWrap: { alignItems: 'center', gap: 10, paddingVertical: 20 },
  retryButton: {
    minHeight: 40, paddingHorizontal: 18, borderRadius: radius.control,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.badgeBg,
    borderWidth: 1, borderColor: 'rgba(46,107,62,.2)',
  },
  loadMoreButton: {
    minHeight: 44, marginTop: 10, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: 'rgba(46,107,62,.2)',
  },
  loadMoreText: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.primary },
});
