import { useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChipRow } from '../../components/prakkie/ChipRow';
import { RecipeCard } from '../../components/prakkie/RecipeCard';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { SearchBar } from '../../components/prakkie/SearchBar';
import { useEntityRows } from '../../data';
import { sortRecipes, toCard, type RecipeRowData } from '../../data/recipes';
import { colors, type } from '../../theme/tokens';

const SORTS = [
  { key: 'nieuwste', label: 'Nieuwste eerst' },
  { key: 'a-z', label: 'A–Z' },
  { key: 'tijd', label: 'Bereidingstijd' },
  { key: 'prijs', label: 'Prijs p.p.' },
] as const;

/** Recepten — bibliotheek (home) on the live offline cache. Mockup 01. */
export default function ReceptenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState('alles');
  const [sortIdx, setSortIdx] = useState(0);
  const { rows, loading } = useEntityRows('recipes');

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

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <FlatList
        data={filtered}
        keyExtractor={(r) => r.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.headerBlock}>
            <ScreenHeader title="Mijn recepten" greetingName="" avatarInitial="P" />
            <SearchBar placeholder="Zoek op titel of ingrediënt…" value={query} onChangeText={setQuery} />
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
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.cardCell}>
            <RecipeCard recipe={item} onPress={() => router.push(`/recipe/${item.id}`)} />
          </View>
        )}
        ListEmptyComponent={
          <Text style={[type.meta, styles.empty]}>
            {loading
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
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sortControl: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  gridRow: { gap: 12, marginBottom: 12 },
  cardCell: { flex: 1 },
  empty: { textAlign: 'center', marginTop: 32 },
});
