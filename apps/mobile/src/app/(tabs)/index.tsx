import { useRouter } from 'expo-router';
import { Archive, ChevronDown } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChipRow } from '../../components/prakkie/ChipRow';
import { RecipeCard } from '../../components/prakkie/RecipeCard';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { SearchBar } from '../../components/prakkie/SearchBar';
import { useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { setPendingReview } from '../../data/import-flow';
import { sortRecipes, toCard, type RecipeRowData } from '../../data/recipes';
import type { FixtureRecipe } from '../../fixtures/recipes';
import { colors, radius, type } from '../../theme/tokens';

interface DiscoverItem {
  id: string;
  title: string;
  site_name: string;
  image_url: string | null;
  time_total_min: number | null;
  price_per_portion_cents: number | null;
}

const SORTS = [
  { key: 'nieuwste', label: 'Nieuwste eerst' },
  { key: 'a-z', label: 'A–Z' },
  { key: 'tijd', label: 'Bereidingstijd' },
  { key: 'prijs', label: 'Prijs p.p.' },
] as const;

/** Recepten — bibliotheek (home) + Ontdek segment (WS7). Mockup 01 + docs/04 §4. */
export default function ReceptenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState('alles');
  const [sortIdx, setSortIdx] = useState(0);
  const [segment, setSegment] = useState<'mijn' | 'ontdek'>('mijn');
  const [discover, setDiscover] = useState<DiscoverItem[]>([]);
  const { rows, loading } = useEntityRows('recipes');

  useEffect(() => {
    if (segment !== 'ontdek') return;
    const t = setTimeout(async () => {
      try {
        const res = await authedRequest(`/v1/discover${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`);
        if (res.ok) setDiscover(((await res.json()) as { items: DiscoverItem[] }).items);
      } catch {
        /* offline: Ontdek is online-only */
      }
    }, query ? 350 : 0);
    return () => clearTimeout(t);
  }, [segment, query]);

  async function saveFromOntdek(item: DiscoverItem) {
    try {
      const res = await authedRequest(`/v1/discover/${item.id}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { recipe: RecipeRowData & { origin?: string }; site_name: string };
      setPendingReview({ recipe: body.recipe, warnings: [], importId: '' });
      router.push('/review');
    } catch {
      Alert.alert('Even geen verbinding', 'Ontdek-recepten openen vereist internet.');
    }
  }

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) for (const t of ((row.row as unknown as RecipeRowData).tags ?? [])) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows;
    if (activeTag !== 'alles') {
      list = list.filter((row) => ((row.row as unknown as RecipeRowData).tags ?? []).includes(activeTag));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((row) => {
        const r = row.row as unknown as RecipeRowData;
        return (
          r.title.toLowerCase().includes(q) ||
          (r.ingredients ?? []).some((i) => (i.item_normalised ?? i.raw_text ?? '').toLowerCase().includes(q))
        );
      });
    }
    return sortRecipes(list, SORTS[sortIdx]!.key).map(toCard);
  }, [rows, query, activeTag, sortIdx]);

  const chips = [{ key: 'alles', label: `Alles · ${rows.length}` }, ...tags.map((t) => ({ key: t, label: t }))];

  const ontdekCards: (FixtureRecipe & { site: string })[] = discover.map((d) => ({
    id: d.id,
    title: d.title,
    imageUrl: d.image_url ?? 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=500&q=60',
    timeTotalMin: d.time_total_min ?? 0,
    pricePerPortionCents: d.price_per_portion_cents ?? 0,
    bonusTip: false,
    collections: [],
    keyIngredients: [],
    site: d.site_name,
  }));

  const data = segment === 'mijn' ? filtered : ontdekCards;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <FlatList
        data={data}
        keyExtractor={(r) => r.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.headerBlock}>
            <ScreenHeader title="Recepten" greetingName="" avatarInitial="P" />
            <View style={styles.segmentRow}>
              <View style={styles.segment}>
                {(['mijn', 'ontdek'] as const).map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setSegment(s)}
                    style={[styles.segmentBtn, segment === s && styles.segmentActive]}
                  >
                    <Text style={[type.chip, segment === s && { color: colors.onPrimary }]}>
                      {s === 'mijn' ? 'Mijn recepten' : 'Ontdek'}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Pressable accessibilityLabel="Voorraadkast" onPress={() => router.push('/pantry')} style={styles.pantryBtn}>
                <Archive size={18} strokeWidth={1.9} color={colors.textSoft} />
              </Pressable>
            </View>
            <SearchBar
              placeholder={segment === 'mijn' ? 'Zoek op titel of ingrediënt…' : 'Zoek ook in Ontdek…'}
              value={query}
              onChangeText={setQuery}
            />
            {segment === 'mijn' ? (
              <>
                <ChipRow chips={chips} activeKey={activeTag} onSelect={setActiveTag} />
                <View style={styles.metaRow}>
                  <Text style={type.meta}>
                    {filtered.length} {filtered.length === 1 ? 'recept' : 'recepten'}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.sortControl}
                    onPress={() => setSortIdx((sortIdx + 1) % SORTS.length)}
                  >
                    <Text style={[type.meta, { color: colors.textSoft }]}>{SORTS[sortIdx]!.label}</Text>
                    <ChevronDown size={14} strokeWidth={1.9} color={colors.textSoft} />
                  </Pressable>
                </View>
              </>
            ) : (
              <Text style={type.meta}>Recepten van Nederlandse sites — bewaar ze in je eigen bibliotheek.</Text>
            )}
          </View>
        }
        renderItem={({ item }) =>
          segment === 'mijn' ? (
            <View style={styles.cardCell}>
              <RecipeCard recipe={item} onPress={() => router.push(`/recipe/${item.id}`)} />
            </View>
          ) : (
            <View style={styles.cardCell}>
              <RecipeCard
                recipe={item}
                sourceAttribution={`via ${(item as FixtureRecipe & { site: string }).site}`}
                onPress={() => saveFromOntdek(discover.find((d) => d.id === item.id)!)}
              />
            </View>
          )
        }
        ListEmptyComponent={
          <Text style={[type.meta, styles.empty]}>
            {segment === 'ontdek'
              ? 'Ontdek laden… (internet vereist)'
              : loading
                ? 'Recepten laden…'
                : 'Nog geen recepten. Tik op + en plak een link van Instagram, TikTok of een receptenblog.'}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingBottom: 120 },
  headerBlock: { gap: 14, marginBottom: 14 },
  segmentRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  segment: {
    flex: 1, flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill,
    padding: 4, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  segmentBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.pill },
  segmentActive: { backgroundColor: colors.primary },
  pantryBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sortControl: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  gridRow: { gap: 12, marginBottom: 12 },
  cardCell: { flex: 1 },
  empty: { textAlign: 'center', marginTop: 32 },
});
