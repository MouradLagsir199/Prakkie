import { formatEuroCents, formatPricePerPortion } from '@prakkie/shared';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Check, ChevronDown, Heart, SlidersHorizontal, Sparkles, Users } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChipRow } from '../../components/prakkie/ChipRow';
import { FilterSlider } from '../../components/prakkie/FilterSlider';
import { RecipeCard } from '../../components/prakkie/RecipeCard';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { SearchBar } from '../../components/prakkie/SearchBar';
import { TourTarget } from '../../components/prakkie/OnboardingTour';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest, currentUser } from '../../data/api';
import { setPendingReview } from '../../data/import-flow';
import { kv } from '../../data/kv';
import { RECIPE_SORTS, recipeImage, sortRecipes, toCard, type RecipeRowData, type RecipeSort } from '../../data/recipes';
import type { FixtureRecipe } from '../../fixtures/recipes';
import { notice } from '../../lib/dialogs';
import { colors, fonts, radius, type } from '../../theme/tokens';

interface DiscoverItem {
  id: string; title: string; site_name: string; source_url: string | null; image_url: string | null;
  time_total_min: number | null; price_per_portion_cents: number | null;
}

/** Recepten (owner 2026-07-07, 2e iteratie): Ontdek is hét scherm — geen
 *  segment-pil meer. "Mijn recepten" is een filterchip (alles wat je liket of
 *  importeert), plus schuifbare filters op prijs p.p. en bereidingstijd. */
export default function ReceptenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState('alles');
  const [sort, setSort] = useState<RecipeSort>('nieuwste');
  const [sortOpen, setSortOpen] = useState(false);
  // bibliotheek-weergave: 'mijn' (eigen recepten) of 'gedeeld' (groep);
  // beide uit = de Ontdek-feed (owner 2026-07-07 avond)
  const [libView, setLibView] = useState<'ontdek' | 'mijn' | 'gedeeld'>('ontdek');
  const showMine = libView !== 'ontdek';
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [maxPrice, setMaxPrice] = useState<number | null>(null); // cents p.p.
  const [maxTime, setMaxTime] = useState<number | null>(null); // minuten
  const [discover, setDiscover] = useState<DiscoverItem[]>([]);
  const [userName, setUserName] = useState('');
  const [myId, setMyId] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [liking, setLiking] = useState<string | null>(null);
  // "Genereer recept" bij lege zoekresultaten (owner 2026-07-10): vierde AI-actie
  const [generating, setGenerating] = useState(false);
  const [generateQuota, setGenerateQuota] = useState<{ used: number; limit: number } | null>(null);
  const { rows, loading } = useEntityRows('recipes');

  useEffect(() => {
    authedRequest('/v1/me/quota')
      .then(async (r) => {
        if (!r.ok) return;
        const q = (await r.json()) as { generate?: { used: number; limit: number } };
        if (q.generate) setGenerateQuota(q.generate);
      })
      .catch(() => {});
  }, []);

  async function generateRecipe() {
    const q = query.trim();
    if (!q || generating) return;
    setGenerating(true);
    try {
      const res = await authedRequest('/v1/recipes/generate', { method: 'POST', body: JSON.stringify({ query: q }) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 402) {
        notice('Genereer-tegoed op', String(body.message ?? 'Je genereer-tegoed voor deze maand is op.'));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      if (body.quota) setGenerateQuota(body.quota as { used: number; limit: number });
      // via het review-scherm: de gebruiker leest na en bewaart zelf
      setPendingReview({
        recipe: { id: '', ...(body.recipe as object) } as RecipeRowData,
        warnings: ['AI-gegenereerd recept — lees de stappen en hoeveelheden even na'],
        importId: '',
      });
      router.push('/review');
    } catch {
      notice('Even geen verbinding', 'Recept genereren vereist internet — probeer het zo nog eens.');
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    currentUser().then((u) => {
      setUserName(u?.display_name ?? '');
      setMyId(u?.id ?? null);
    }).catch(() => {});
    kv.getItem('prakkie.avatar').then((v) => setAvatarUrl(v || null)).catch(() => {});
  }, []);

  const [discoverState, setDiscoverState] = useState<'idle' | 'loading' | 'done' | 'offline'>('idle');
  const [discoverError, setDiscoverError] = useState('');
  useEffect(() => {
    if (showMine) return;
    setDiscoverState('loading');
    const t = setTimeout(async () => {
      try {
        const res = await authedRequest(`/v1/discover${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`);
        if (res.ok) {
          setDiscover(((await res.json()) as { items: DiscoverItem[] }).items);
          setDiscoverState('done');
        } else {
          setDiscoverError(`HTTP ${res.status}`);
          setDiscoverState('offline');
        }
      } catch (e) {
        // Ontdek is online-only — toon de échte reden i.p.v. te gokken
        setDiscoverError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        setDiscoverState('offline');
      }
    }, query ? 350 : 0);
    return () => clearTimeout(t);
  }, [showMine, query]);

  /** geliket = het recept staat (via bron-URL) al in je eigen bibliotheek */
  const likedByUrl = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of rows) {
      const url = (row.row as unknown as RecipeRowData).source_url;
      if (url) m.set(String(url), row.id);
    }
    return m;
  }, [rows]);

  async function toggleLike(item: DiscoverItem) {
    if (liking) return;
    const existing = item.source_url ? likedByUrl.get(item.source_url) : undefined;
    if (existing) {
      await deleteRow('recipes', existing);
      syncNow(['recipes']).catch(() => {});
      return;
    }
    setLiking(item.id);
    try {
      const res = await authedRequest(`/v1/discover/${item.id}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { source_url: string; recipe: RecipeRowData & { origin?: string } };
      const r = body.recipe;
      await upsertRow(
        'recipes',
        {
          title: r.title,
          origin: r.origin ?? 'crawled_save',
          source_url: r.source_url ?? body.source_url ?? item.source_url ?? null,
          source_platform: r.source_platform ?? 'blog',
          source_author: r.source_author ?? null,
          images: r.images ?? (item.image_url ? [item.image_url] : []),
          servings_base: r.servings_base ?? 2,
          time_prep_min: r.time_prep_min ?? null,
          time_cook_min: r.time_cook_min ?? null,
          ingredients: r.ingredients ?? [],
          steps: r.steps ?? [],
          tags: r.tags ?? [],
          cuisine: r.cuisine ?? null,
          diet_flags: (r as { diet_flags?: string[] }).diet_flags ?? [],
          missing_fields: r.missing_fields ?? [],
        },
        newId()
      );
      syncNow(['recipes']).catch(() => {});
    } catch {
      notice('Even geen verbinding', 'Liken vereist internet — probeer het zo nog eens.');
    } finally {
      setLiking(null);
    }
  }

  async function openFromOntdek(item: DiscoverItem) {
    try {
      const res = await authedRequest(`/v1/discover/${item.id}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { recipe: RecipeRowData };
      setPendingReview({ recipe: body.recipe, warnings: [], importId: '' });
      router.push('/review');
    } catch {
      notice('Even geen verbinding', 'Ontdek-recepten openen vereist internet.');
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
  const searching = showMine && tokens.length > 0;

  const filtered = useMemo(() => {
    let list = rows;
    // 'mijn' = eigen recepten (lokaal-nieuw zonder owner telt als eigen);
    // 'gedeeld' = alles dat in het groep gedeeld is (door wie dan ook)
    if (libView === 'mijn') {
      list = list.filter((row) => {
        const r = row.row as unknown as RecipeRowData;
        return !r.owner_id || !myId || r.owner_id === myId;
      });
    } else if (libView === 'gedeeld') {
      list = list.filter((row) => !!(row.row as unknown as RecipeRowData).household_id);
    }
    if (activeTag !== 'alles' && !searching) {
      list = list.filter((row) => ((row.row as unknown as RecipeRowData).tags ?? []).includes(activeTag));
    }
    if (maxPrice !== null) {
      list = list.filter((row) => {
        const pp = (row.row as unknown as RecipeRowData).price_cache?.per_portion_cents;
        return pp != null && pp <= maxPrice;
      });
    }
    if (maxTime !== null) {
      list = list.filter((row) => {
        const r = row.row as unknown as RecipeRowData;
        const total = (r.time_prep_min ?? 0) + (r.time_cook_min ?? 0);
        return total > 0 && total <= maxTime;
      });
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
  }, [rows, tokens.join(' '), activeTag, sort, searching, maxPrice, maxTime]);

  // dezelfde schuif-filters over de Ontdek-feed (client-side; feed is al binnen)
  const discoverFiltered = useMemo(
    () =>
      discover.filter(
        (d) =>
          (maxPrice === null || (d.price_per_portion_cents != null && d.price_per_portion_cents <= maxPrice)) &&
          (maxTime === null || (d.time_total_min != null && d.time_total_min > 0 && d.time_total_min <= maxTime))
      ),
    [discover, maxPrice, maxTime]
  );

  const gridCards = useMemo(() => filtered.map(toCard), [filtered]);
  const sortLabel = RECIPE_SORTS.find((s) => s.key === sort)!.label;
  const chips = [{ key: 'alles', label: `Alles · ${rows.length}` }, ...tags.map((t) => ({ key: t, label: t }))];

  const ontdekCards: (FixtureRecipe & { site: string })[] = discoverFiltered.map((d) => ({
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

  const filterCount = (maxPrice !== null ? 1 : 0) + (maxTime !== null ? 1 : 0);
  const filterSummary = [
    maxPrice !== null ? `≤ ${formatEuroCents(maxPrice)} p.p.` : null,
    maxTime !== null ? `≤ ${maxTime} min` : null,
  ].filter(Boolean).join(' · ');

  const header = (
    <View style={styles.headerBlock}>
      <ScreenHeader
        title={searching ? 'Zoeken' : libView === 'mijn' ? 'Mijn recepten' : libView === 'gedeeld' ? 'Gedeeld' : 'Ontdek'}
        avatarInitial={(userName || 'P').slice(0, 1).toUpperCase()}
        avatarUrl={avatarUrl}
        onAvatarPress={() => router.push('/profiel')}
      />
      <TourTarget targetId="recipes-search">
        <SearchBar
          placeholder={showMine ? 'Zoek op titel of ingrediënt…' : 'Zoek in Ontdek…'}
          value={query}
          onChangeText={setQuery}
        />
      </TourTarget>

      {/* filterbalk: Mijn recepten en Gedeeld (groep) zijn filters, geen tabbladen */}
      <TourTarget targetId="recipes-filters">
      <View style={styles.filterRow}>
        <Pressable
          onPress={() => setLibView(libView === 'mijn' ? 'ontdek' : 'mijn')}
          style={[styles.filterChip, libView === 'mijn' && styles.filterChipOn]}
        >
          <Heart
            size={13}
            strokeWidth={2.2}
            color={libView === 'mijn' ? colors.onPrimary : colors.textSoft}
            fill={libView === 'mijn' ? colors.onPrimary : 'transparent'}
          />
          <Text style={[styles.filterChipText, libView === 'mijn' && { color: colors.onPrimary }]}>Mijn recepten</Text>
        </Pressable>
        <Pressable
          onPress={() => setLibView(libView === 'gedeeld' ? 'ontdek' : 'gedeeld')}
          style={[styles.filterChip, libView === 'gedeeld' && styles.filterChipOn]}
        >
          <Users size={13} strokeWidth={2.2} color={libView === 'gedeeld' ? colors.onPrimary : colors.textSoft} />
          <Text style={[styles.filterChipText, libView === 'gedeeld' && { color: colors.onPrimary }]}>Gedeeld</Text>
        </Pressable>
        <Pressable
          onPress={() => setFiltersOpen(!filtersOpen)}
          style={[styles.filterChip, (filtersOpen || filterCount > 0) && styles.filterChipActive]}
        >
          <SlidersHorizontal size={13} strokeWidth={2.2} color={filterCount > 0 || filtersOpen ? colors.primary : colors.textSoft} />
          <Text style={[styles.filterChipText, (filterCount > 0 || filtersOpen) && { color: colors.primary }]}>
            {filterSummary || 'Filters'}
          </Text>
        </Pressable>
      </View>
      </TourTarget>

      {filtersOpen ? (
        <View style={styles.sliderCard}>
          <FilterSlider
            label="Prijs per portie"
            value={maxPrice}
            min={100}
            max={1000}
            step={25}
            format={(v) => (v === null ? 'alles' : `≤ ${formatEuroCents(v)}`)}
            onChange={setMaxPrice}
          />
          <FilterSlider
            label="Bereidingstijd"
            value={maxTime}
            min={5}
            max={120}
            step={5}
            format={(v) => (v === null ? 'alles' : `≤ ${v} min`)}
            onChange={setMaxTime}
          />
          <Text style={styles.sliderHint}>Schuif helemaal naar rechts voor geen limiet.</Text>
        </View>
      ) : null}

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
      ) : showMine ? (
        <ChipRow chips={chips} activeKey={activeTag} onSelect={setActiveTag} />
      ) : (
        <Text style={type.meta}>Tik het hartje om te bewaren in Mijn recepten.</Text>
      )}

      {showMine ? (
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

      {sortOpen && showMine ? (
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
      <View style={[styles.screen, { paddingTop: insets.top + 24 }]}>
        {/* key: zoeklijst (1 kolom) en grid (2 kolommen) mogen nooit dezelfde
            FlatList-instantie hergebruiken — numColumns wisselen crasht RN */}
        <FlatList
          key="search"
          data={filtered}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={header}
          renderItem={({ item }) => searchRow(item)}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', gap: 14, marginTop: 32 }}>
              <Text style={type.meta}>Geen recepten met {tokens.join(' + ')}.</Text>
              {/* niets gevonden ≠ doodlopen: AI schrijft het recept (owner 2026-07-10) */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Genereer recept"
                onPress={generateRecipe}
                disabled={generating}
                style={[styles.generateBtn, generating && { opacity: 0.7 }]}
              >
                {generating ? (
                  <ActivityIndicator size="small" color={colors.quota} />
                ) : (
                  <Sparkles size={16} color={colors.quota} strokeWidth={2.2} />
                )}
                <View style={{ flexShrink: 1 }}>
                  <Text style={styles.generateTitle}>
                    {generating ? 'Recept schrijven…' : `Genereer recept voor “${query.trim()}”`}
                  </Text>
                  <Text style={styles.generateSub}>
                    AI schrijft een compleet recept met stappen en hoeveelheden
                    {generateQuota
                      ? ` · nog ${Math.max(0, generateQuota.limit - generateQuota.used)} van ${generateQuota.limit} deze maand`
                      : ''}
                  </Text>
                </View>
              </Pressable>
            </View>
          }
        />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 24 }]}>
      <FlatList
        key="grid"
        data={showMine ? gridCards : ontdekCards}
        keyExtractor={(r) => r.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={header}
        renderItem={({ item }) =>
          showMine ? (
            <View style={styles.cardCell}>
              <RecipeCard recipe={item} onPress={() => router.push(`/recipe/${item.id}`)} />
            </View>
          ) : (
            <View style={styles.cardCell}>
              <RecipeCard
                recipe={item}
                sourceAttribution={`via ${(item as FixtureRecipe & { site: string }).site}`}
                onPress={() => openFromOntdek(discover.find((d) => d.id === item.id)!)}
                liked={(() => {
                  const d = discover.find((x) => x.id === item.id);
                  return !!(d?.source_url && likedByUrl.has(d.source_url));
                })()}
                onToggleLike={() => toggleLike(discover.find((d) => d.id === item.id)!)}
              />
            </View>
          )
        }
        ListEmptyComponent={
          !showMine ? (
            // R1/R2 — eerlijke Ontdek-staten: laden ≠ geen resultaat ≠ offline
            <View style={{ gap: 10, alignItems: 'center' }}>
              <Text style={[type.meta, styles.empty]}>
                {discoverState === 'loading' || discoverState === 'idle'
                  ? 'Ontdek laadt…'
                  : discoverState === 'offline'
                    ? 'Ontdek heeft internet nodig — controleer je verbinding.'
                    : filterCount > 0 && discover.length > 0
                      ? 'Niets binnen je filters — schuif ze wat ruimer.'
                      : query.trim()
                        ? `Niets gevonden voor “${query.trim()}” — Ontdek groeit elke nacht.`
                        : 'Nog niets in Ontdek — kijk later nog eens.'}
              </Text>
              {discoverState === 'offline' && discoverError ? (
                <Text style={[type.meta, { fontSize: 10.5, color: '#B9836B', textAlign: 'center' }]}>
                  technisch detail: {discoverError}
                </Text>
              ) : null}
              {discoverState === 'done' && query.trim() ? (
                <>
                  {/* niets gevonden ≠ doodlopen: AI schrijft het recept — ook in
                      de Ontdek-zoek, niet alleen achter "Mijn recepten" (owner 2026-07-10) */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Genereer recept"
                    onPress={generateRecipe}
                    disabled={generating}
                    style={[styles.generateBtn, generating && { opacity: 0.7 }]}
                  >
                    {generating ? (
                      <ActivityIndicator size="small" color={colors.quota} />
                    ) : (
                      <Sparkles size={16} color={colors.quota} strokeWidth={2.2} />
                    )}
                    <View style={{ flexShrink: 1 }}>
                      <Text style={styles.generateTitle}>
                        {generating ? 'Recept schrijven…' : `Genereer recept voor “${query.trim()}”`}
                      </Text>
                      <Text style={styles.generateSub}>
                        AI schrijft een compleet recept met stappen en hoeveelheden
                        {generateQuota
                          ? ` · nog ${Math.max(0, generateQuota.limit - generateQuota.used)} van ${generateQuota.limit} deze maand`
                          : ''}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable onPress={() => router.push('/import')}>
                    <Text style={[type.body, { color: colors.primary, fontFamily: fonts.bodySemiBold }]}>
                      of importeer zelf via een link →
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          ) : (
            <Text style={[type.meta, styles.empty]}>
              {loading
                ? 'Recepten laden…'
                : filterCount > 0 && rows.length > 0
                  ? 'Niets binnen je filters — schuif ze wat ruimer.'
                  : libView === 'gedeeld'
                    ? 'Nog niets gedeeld. Open een recept en tik “Deel met groep” — dan ziet je hele groep het hier.'
                    : 'Nog geen recepten. Like iets in Ontdek, of tik op + en plak een link van Instagram, TikTok of een receptenblog.'}
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
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, paddingVertical: 8,
    borderRadius: radius.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderControl,
  },
  filterChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipActive: { borderColor: colors.primary, backgroundColor: colors.badgeBg },
  filterChipText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  sliderCard: {
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle,
    padding: 14, gap: 12, marginTop: -4,
  },
  sliderHint: { fontSize: 10.5, color: colors.textMuted2 },
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
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle,
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
    borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, padding: 10, marginBottom: 10,
  },
  resultThumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: '#EDE7D8' },
  resultTitle: { fontSize: 14.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  resultMeta: { fontSize: 11.5, color: colors.textMuted },
  pricePill: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: colors.badgeBg, color: colors.primary, fontSize: 10.5, fontFamily: fonts.bodyBold,
  },
  resultIngredients: { fontSize: 11, color: colors.textMuted2 },
  empty: { textAlign: 'center', marginTop: 32 },
  generateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 8,
    backgroundColor: colors.quotaBg, borderWidth: 1, borderColor: colors.quotaBorder,
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
  },
  generateTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.quota },
  generateSub: { fontSize: 11, color: colors.quota, opacity: 0.85, marginTop: 1 },
});
