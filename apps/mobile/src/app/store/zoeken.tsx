import { useRouter } from 'expo-router';
import type { StorePanelSort } from '@prakkie/shared';
import { ChevronLeft, Search, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LijstFooter } from '../../components/store/LijstFooter';
import { CrossChainList, type CrossChainOption } from '../../components/prakkie/ProductOptions';
import { searchStoreProducts, useMyChains } from '../../store/api';
import { useBoodschappenLijst } from '../../store/lijst';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Zoeken over de hele winkel (owner-redesign 2026-07-12): één zoekveld, alle
 * supers tegelijk via de vrije cataloguszoeker. Anders dan de ingrediëntmatcher
 * blijft "sinaasappeljam" één productnaam en worden kleine typefouten opgevangen.
 */
type SearchSort = Exclude<StorePanelSort, 'aanbevolen'>;

const SORTS: { key: SearchSort; label: string }[] = [
  { key: 'prijs', label: 'Prijs' },
  { key: 'eenheidsprijs', label: 'Per kilo/liter' },
  { key: 'bonus', label: 'Bonus' },
];

export default function StoreZoeken() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const chains = useMyChains();
  const { count, lastAdded, add } = useBoodschappenLijst();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<SearchSort>('prijs');
  const [options, setOptions] = useState<CrossChainOption[] | null>(null);
  const [total, setTotal] = useState(0);
  const [coverage, setCoverage] = useState<'none' | 'partial' | 'exact' | 'fuzzy' | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const queryRevision = useRef(0);
  const chainKey = chains?.join(',') ?? '';
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const revision = ++queryRevision.current;
    if (!debounced || !chains?.length) {
      setOptions(null);
      setTotal(0);
      setCoverage(null);
      setLoading(false);
      setLoadError(false);
      return;
    }
    let live = true;
    setOptions(null);
    setTotal(0);
    setCoverage(null);
    setLoading(true);
    setLoadError(false);
    void searchStoreProducts(debounced, chains, { limit: 60, sort }).then((result) => {
      if (!live || revision !== queryRevision.current) return;
      if (!result) {
        setOptions([]);
        setLoadError(true);
      } else {
        setOptions(result.products as CrossChainOption[]);
        setTotal(result.total);
        setCoverage(result.search_coverage ?? null);
      }
      setLoading(false);
    });
    return () => { live = false; };
  }, [debounced, chainKey, sort, reloadRevision]);

  async function loadMoreProducts() {
    if (!debounced || !chains?.length || !options || loadingMore || options.length >= total) return;
    const revision = queryRevision.current;
    setLoadingMore(true);
    const result = await searchStoreProducts(debounced, chains, { offset: options.length, limit: 60, sort });
    if (revision === queryRevision.current && result) {
      setTotal(result.total);
      setCoverage(result.search_coverage ?? coverage);
      setOptions((current) => {
        const merged = [...(current ?? []), ...(result.products as CrossChainOption[])];
        const seen = new Set<string>();
        return merged.filter((option) => {
          const key = `${option.chain}:${option.sku_id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    } else if (revision === queryRevision.current && !result) {
      setLoadError(true);
    }
    if (revision === queryRevision.current) setLoadingMore(false);
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/boodschappen'))}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Terug"
          style={styles.backBtn}
        >
          <ChevronLeft size={20} color={colors.text} strokeWidth={2.4} />
        </Pressable>
        <View style={styles.searchBar}>
          <Search size={16} color={colors.textMuted2} strokeWidth={2.1} />
          <TextInput
            style={styles.searchInput}
            placeholder="Zoek product, merk of inhoud (bijv. 500 g)…"
            placeholderTextColor={colors.textMuted2}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoFocus
            returnKeyType="search"
            accessibilityLabel="Zoek producten, merken of verpakkingsinhoud"
          />
          {loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
          {search ? (
            <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Zoekopdracht wissen">
              <X size={15} color={colors.textMuted2} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {!debounced ? (
          <View style={styles.hintWrap}>
            <Text style={styles.hintTitle}>Waar ben je naar op zoek?</Text>
            <Text style={[type.meta, { textAlign: 'center' }]}>
              Typ een product of merk — je ziet meteen de prijzen bij al je supermarkten.
            </Text>
          </View>
        ) : loadError ? (
          <View style={styles.hintWrap}>
            <Text style={styles.hintTitle}>Zoeken lukte even niet</Text>
            <Pressable style={styles.retryButton} onPress={() => setReloadRevision((value) => value + 1)}>
              <Text style={styles.buttonText}>Opnieuw proberen</Text>
            </Pressable>
          </View>
        ) : options === null ? (
          <Text style={[type.meta, { paddingVertical: 12 }]}>Zoeken…</Text>
        ) : options.length === 0 ? (
          <Text style={[type.meta, { paddingVertical: 12 }]}>
            Niets gevonden voor “{debounced}” — probeer een ander woord.
          </Text>
        ) : (
          <>
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
            <Text style={[type.meta, { marginBottom: 6 }]}>{total} resultaten</Text>
            <CrossChainList
              options={options}
              maxRows={options.length}
              onPick={(opt) => add({
                chain: opt.chain,
                sku_id: opt.sku_id,
                name: opt.name,
                term: (opt as { head_term?: string }).head_term ?? debounced,
                unit_cents: opt.promo_price_cents ?? opt.price_cents,
              })}
            />
            {options.length < total ? (
              <Pressable style={styles.loadMoreButton} onPress={loadMoreProducts} disabled={loadingMore}>
                <Text style={styles.buttonText}>
                  {loadingMore ? 'Meer laden…' : `Toon meer (${total - options.length} resterend)`}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>

      <LijstFooter count={count} lastAdded={lastAdded} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 10 },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  searchBar: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceMuted, borderRadius: radius.lg,
    paddingHorizontal: 13, height: 44,
  },
  searchInput: { flex: 1, fontSize: 13.5, fontFamily: fonts.body, color: colors.text, paddingVertical: 0 },
  listContent: { paddingHorizontal: 20, paddingBottom: 130 },
  hintWrap: { alignItems: 'center', gap: 6, paddingTop: 60, paddingHorizontal: 30 },
  hintTitle: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.text },
  searchNotice: {
    marginBottom: 8, borderRadius: radius.control, paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: 'rgba(46,107,62,.18)',
  },
  noticeTitle: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.primary },
  noticeBody: { marginTop: 2, fontSize: 10.5, fontFamily: fonts.body, color: colors.textSoft },
  sortRow: { flexDirection: 'row', gap: 6, paddingBottom: 8 },
  sortChip: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderControl, backgroundColor: colors.surface,
  },
  sortChipActive: { backgroundColor: colors.tabPill, borderColor: colors.primary },
  sortChipText: { fontFamily: fonts.bodySemiBold, fontSize: 11.5, color: colors.textSoft },
  sortChipTextActive: { color: colors.primary },
  retryButton: {
    minHeight: 40, paddingHorizontal: 18, borderRadius: radius.control,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.badgeBg,
  },
  loadMoreButton: {
    minHeight: 44, marginTop: 10, borderRadius: radius.control,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.badgeBg,
    borderWidth: 1, borderColor: 'rgba(46,107,62,.2)',
  },
  buttonText: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.primary },
});
