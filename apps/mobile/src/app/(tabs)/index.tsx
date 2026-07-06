import { formatPricePerPortion } from '@prakkie/shared';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Archive, Check, ChevronDown } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChipRow } from '../../components/prakkie/ChipRow';
import { RecipeCard } from '../../components/prakkie/RecipeCard';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { SearchBar } from '../../components/prakkie/SearchBar';
import { useEntityRows } from '../../data';
import { authedRequest, currentUser } from '../../data/api';
import { setPendingReview } from '../../data/import-flow';
import { RECIPE_SORTS, recipeImage, sortRecipes, toCard, type RecipeRowData, type RecipeSort } from '../../data/recipes';
import type { FixtureRecipe } from '../../fixtures/recipes';
import { colors, fonts, radius, type } from '../../theme/tokens';

interface DiscoverItem {
  id: string; title: string; site_name: string; image_url: string | null;
  time_total_min: number | null; price_per_portion_cents: number | null;
}

/** Recepten — mockup 01 (grid) + mockup 02 (search mode with ingredient
 *  AND-chips + sort card) + the Ontdek segment (docs/04 §4). */
export default function ReceptenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState('alles');
  const [sort, setSort] = useState<RecipeSort>('nieuwste');
  const [sortOpen, setSortOpen] = useState(false);
  const [segment, setSegment] = useState<'mijn' | 'ontdek'>('mijn');
  const [discover, setDiscover] = useState<DiscoverItem[]>([]);
  const [userName, setUserName] = useState('');
  const { rows, loading } = useEntityRows('recipes');

  useEffect(() => {
    currentUser().then((u) => setUserName(u?.display_name ?? '')).catch(() => {});
  }, []);

  const [discoverState, setDiscoverState] = useState<'idle' | 'loading' | 'done' | 'offline'>('idle');
  useEffect(() => {
    if (segment !== 'ontdek') return;
    setDiscoverState('loading');
    const t = setTimeout(async () => {
      try {
        const res = await authedRequest(`/v1/discover${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`);
        if (res.ok) {
          setDiscover(((await res.json()) as { items: DiscoverItem[] }).items);
          setDiscoverState('done');
        } else setDiscoverState('offline');
      } catch {
        setDiscoverState('offline'); // Ontdek is online-only
      }
    }, query ? 350 : 0);
    return () => clearTimeout(t);
  }, [segment, query]);

  async function saveFromOntdek(item: DiscoverItem) {
    try {
      const res = await authedRequest(`/v1/discover/${item.id}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { recipe: RecipeRowData };
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

  // mockup 02: every search token must match (alle gekozen ingrediënten)
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = segment === 'mijn' && tokens.length > 0;

  const filtered = useMemo(() => {
    let list = rows;
    if (activeTag !== 'alles' && !searching) {
      list = list.filter((row) => ((row.row as unknown as RecipeRowData).tags ?? []).includes(activeTag));
    }
    if (tokens.length) {
      list = list.filter((row) => {
        const r = row.row as unknown as RecipeRowData;
        const hay = [
          r.title.toLowerCase(),
          ...(r.ingredients ?? []).map((i) => (i.item_normalised ?? i.raw_text ?? '').toLowerCase()),
        ];
        return tokens.every((t) => hay.some((h) => h.includes(t)));
      });
    }
    return sortRecipes(list, sort);
  }, [rows, tokens.join(' '), activeTag, sort, searching]);

  const gridCards = useMemo(() => filtered.map(toCard), [filtered]);
  const sortLabel = RECIPE_SORTS.find((s) => s.key === sort)!.label;
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

  const header = (
    <View style={styles.headerBlock}>
      <ScreenHeader
        title={searching ? 'Zoeken' : 'Mijn recepten'}
        greetingName={searching ? '' : userName}
        avatarInitial={(userName || 'P').slice(0, 1).toUpperCase()}
        onAvatarPress={() => router.push('/profiel')}
      />
      <View style={styles.segmentRow}>
        <View style={styles.segment}>
          {(['mijn', 'ontdek'] as const).map((s) => (
            <Pressable key={s} onPress={() => setSegment(s)} style={[styles.segmentBtn, segment === s && styles.segmentActive]}>
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

      {searching ? (
        <>
          <View style={styles.tokenRow}>
            {tokens.map((t) => (
              <Pressable
                key={t}
                style={styles.tokenChip}
                onPress={() => setQuery(tokens.filter((x) => x !== t).join(' '))}
              >
                <Text style={styles.tokenText}>{t}</Text>
                <Text style={[styles.tokenText, { fontFamily: fonts.body }]}>✕</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.searchHint}>Filter op ingrediënt — recepten met alle gekozen ingrediënten</Text>
        </>
      ) : segment === 'mijn' ? (
        <ChipRow chips={chips} activeKey={activeTag} onSelect={setActiveTag} />
      ) : (
        <Text style={type.meta}>Recepten van Nederlandse sites — bewaar ze in je eigen bibliotheek.</Text>
      )}

      {segment === 'mijn' ? (
        <View style={styles.metaRow}>
          <Text style={type.meta}>
            {searching
              ? `${filtered.length} ${filtered.length === 1 ? 'recept' : 'recepten'}${tokens.length > 1 ? ` met ${tokens.join(' + ')}` : ''}`
              : `${filtered.length} ${filtered.length === 1 ? 'recept' : 'recepten'}`}
          </Text>
          <Pressable accessibilityRole="button" style={styles.sortControl} onPress={() => setSortOpen(!sortOpen)}>
            <Text style={styles.sortText}>{searching ? 'Sorteer' : sortLabel}</Text>
            <ChevronDown size={11} strokeWidth={2.5} color={colors.primary} />
          </Pressable>
        </View>
      ) : null}

      {sortOpen ? (
        <View style={styles.sortCard}>
          {RECIPE_SORTS.map((s) => (
            <Pressable
              key={s.key}
              style={[styles.sortRow, sort === s.key && styles.sortRowActive]}
              onPress={() => {
                setSort(s.key);
                setSortOpen(false);
              }}
            >
              <Text style={[styles.sortRowText, sort === s.key && { fontFamily: fonts.bodySemiBold }]}>{s.label}</Text>
              {sort === s.key ? <Check size={14} color={colors.primary} strokeWidth={2.5} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );

  // mockup 02: search results as horizontal rows with key ingredients
  const searchRow = (row: (typeof filtered)[number]) => {
    const r = row.row as unknown as RecipeRowData;
    const total = (r.time_prep_min ?? 0) + (r.time_cook_min ?? 0);
    const ing = (r.ingredients ?? []).map((i) => i.item_normalised).filter(Boolean).slice(0, 4).join(' · ');
    return (
      <Pressable key={r.id} style={styles.resultRow} onPress={() => router.push(`/recipe/${r.id}`)}>
        <Image source={{ uri: recipeImage(r) }} style={styles.resultThumb} contentFit="cover" />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={styles.resultTitle} numberOfLines={1}>{r.title}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {total > 0 ? <Text style={styles.resultMeta}>{total} min</Text> : null}
            {r.price_cache?.per_portion_cents ? (
              <Text style={styles.pricePill}>{formatPricePerPortion(r.price_cache.per_portion_cents)}</Text>
            ) : null}
          </View>
          {ing ? <Text style={styles.resultIngredients} numberOfLines={1}>{ing}</Text> : null}
        </View>
      </Pressable>
    );
  };

  if (searching) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <FlatList
          data={filtered}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={header}
          renderItem={({ item }) => searchRow(item)}
          ListEmptyComponent={<Text style={[type.meta, styles.empty]}>Geen recepten met {tokens.join(' + ')}.</Text>}
        />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <FlatList
        data={segment === 'mijn' ? gridCards : ontdekCards}
        keyExtractor={(r) => r.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={header}
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
          segment === 'ontdek' ? (
            // R1/R2 — eerlijke Ontdek-staten: laden ≠ geen resultaat ≠ offline
            <View style={{ gap: 10, alignItems: 'center' }}>
              <Text style={[type.meta, styles.empty]}>
                {discoverState === 'loading' || discoverState === 'idle'
                  ? 'Ontdek laadt…'
                  : discoverState === 'offline'
                    ? 'Ontdek heeft internet nodig — controleer je verbinding.'
                    : query.trim()
                      ? `Niets gevonden voor “${query.trim()}” — Ontdek groeit elke nacht.`
                      : 'Nog niets in Ontdek — kijk later nog eens.'}
              </Text>
              {discoverState === 'done' && query.trim() ? (
                <Pressable onPress={() => router.push('/import')}>
                  <Text style={[type.body, { color: colors.primary, fontFamily: fonts.bodySemiBold }]}>
                    Zelf importeren via een link →
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <Text style={[type.meta, styles.empty]}>
              {loading
                ? 'Recepten laden…'
                : 'Nog geen recepten. Tik op + en plak een link van Instagram, TikTok of een receptenblog.'}
            </Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 130 },
  headerBlock: { gap: 14, marginBottom: 14 },
  segmentRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  segment: {
    flex: 1, flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.pill,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', padding: 3, gap: 3,
  },
  segmentBtn: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radius.pill },
  segmentActive: { backgroundColor: colors.primary },
  pantryBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  tokenRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tokenChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.pill, backgroundColor: colors.badgeBg,
  },
  tokenText: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.primary },
  searchHint: { fontSize: 12, color: colors.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sortControl: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sortText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
  sortCard: {
    backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    paddingVertical: 4, marginTop: -6,
  },
  sortRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 9, marginHorizontal: 4,
  },
  sortRowActive: { backgroundColor: colors.badgeBg },
  sortRowText: { fontSize: 13.5, color: colors.text, fontFamily: fonts.body },
  gridRow: { gap: 14, marginBottom: 14 },
  cardCell: { flex: 1 },
  resultRow: {
    flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: colors.surface,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.08)', borderRadius: 16, padding: 10, marginBottom: 10,
  },
  resultThumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: '#EDE7D8' },
  resultTitle: { fontSize: 14.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  resultMeta: { fontSize: 11.5, color: colors.textMuted },
  pricePill: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: colors.badgeBg, color: colors.primary, fontSize: 10.5, fontFamily: fonts.bodyBold,
  },
  resultIngredients: { fontSize: 11, color: '#97A08F' },
  empty: { textAlign: 'center', marginTop: 32 },
});
