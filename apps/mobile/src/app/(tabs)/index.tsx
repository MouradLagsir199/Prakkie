import { ChevronDown } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChipRow } from '../../components/prakkie/ChipRow';
import { RecipeCard } from '../../components/prakkie/RecipeCard';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { SearchBar } from '../../components/prakkie/SearchBar';
import { FIXTURE_COLLECTIONS, FIXTURE_RECIPES, FIXTURE_USER } from '../../fixtures/recipes';
import { colors, type } from '../../theme/tokens';

/** Recepten — bibliotheek (home). Contract: tab_designs_ui/html/01_Recepten_bibliotheek.html */
export default function ReceptenScreen() {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [activeCollection, setActiveCollection] = useState('alles');

  const filtered = useMemo(() => {
    let list = FIXTURE_RECIPES;
    if (activeCollection !== 'alles') {
      list = list.filter((r) => r.collections.includes(activeCollection));
    }
    const q = query.trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter(
        (r) => r.title.toLowerCase().includes(q) || r.keyIngredients.some((i) => i.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [query, activeCollection]);

  const chips = [
    { key: 'alles', label: `Alles · ${FIXTURE_RECIPES.length}` },
    ...FIXTURE_COLLECTIONS.map((c) => ({ key: c, label: c })),
  ];

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
            <ScreenHeader title="Mijn recepten" greetingName={FIXTURE_USER.name} avatarInitial={FIXTURE_USER.initial} />
            <SearchBar placeholder="Zoek op titel of ingrediënt…" value={query} onChangeText={setQuery} />
            <ChipRow chips={chips} activeKey={activeCollection} onSelect={setActiveCollection} />
            <View style={styles.metaRow}>
              <Text style={type.meta}>
                {filtered.length} {filtered.length === 1 ? 'recept' : 'recepten'}
              </Text>
              <Pressable accessibilityRole="button" style={styles.sortControl}>
                <Text style={[type.meta, { color: colors.textSoft }]}>Nieuwste eerst</Text>
                <ChevronDown size={14} strokeWidth={1.9} color={colors.textSoft} />
              </Pressable>
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.cardCell}>
            <RecipeCard recipe={item} />
          </View>
        )}
        ListEmptyComponent={
          <Text style={[type.meta, styles.empty]}>Geen recepten gevonden. Probeer een andere zoekterm.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 120, // clear the floating tab bar
  },
  headerBlock: {
    gap: 14,
    marginBottom: 14,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sortControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  gridRow: {
    gap: 12,
    marginBottom: 12,
  },
  cardCell: {
    flex: 1,
  },
  empty: {
    textAlign: 'center',
    marginTop: 32,
  },
});
