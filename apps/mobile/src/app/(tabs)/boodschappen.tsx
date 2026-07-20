import { formatEuroCents, type DiscoverCategory, type DiscoverProduct } from '@prakkie/shared';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Bookmark, Check, LayoutGrid, Plus, RefreshCw, Search, ShoppingCart } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LijstFooter } from '../../components/store/LijstFooter';
import { ChainLogo } from '../../components/prakkie/ChainLogo';
import { LoadingBar } from '../../components/prakkie/LoadingBar';
import { TourTarget } from '../../components/prakkie/OnboardingTour';
import { getCachedPricing, useShoppingSessionCache, warmShoppingSession } from '../../data/shopping-session-cache';
import { useStoreDiscover } from '../../store/api';
import { useBoodschappenLijst } from '../../store/lijst';
import { colors, fonts, radius, shadows, type } from '../../theme/tokens';

/**
 * Boodschappen-home (owner-redesign 2026-07-12, naar eigen mockup): praktisch
 * ontdekken + lijst bouwen. Zoekbalk → /store/zoeken, categoriekaarten →
 * /store/[dept], "Populaire categorieën" = waar nu de meeste bonussen lopen,
 * "Aanbevolen voor jou" = basisproducten in de bonus met vanaf-prijs. Elke +
 * zet het product direct op dé lijst; de groene balk brengt je naar de summary.
 */

/** de dagelijkse verswanden vooraan — de rest staat achter "Alle categorieën" */
const TOP_ROW = ['groente-aardappelen', 'fruit-sappen', 'zuivel-eieren', 'bakkerij', 'vlees', 'kaas'];

export default function BoodschappenHome() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data, chains } = useStoreDiscover();
  const { count, lastAdded, add, templates, loadTemplate, currentListId, itemIds, itemDescriptors, revision } =
    useBoodschappenLijst();
  const [loadingTemplateId, setLoadingTemplateId] = useState<string | null>(null);

  async function quickLoadTemplate(templateId: string) {
    if (loadingTemplateId) return;
    setLoadingTemplateId(templateId);
    try {
      await loadTemplate(templateId);
    } finally {
      setLoadingTemplateId(null);
    }
  }
  const shoppingCache = useShoppingSessionCache();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const chainKey = chains?.join(',') ?? '';

  useEffect(() => {
    if (!currentListId || itemIds.length === 0 || !chains?.length) return;
    // Eerste tab-open: meteen. Echte lijstwijzigingen kort bundelen, zodat vijf
    // snelle '+'-tikken niet vijf serverprojecties starten.
    const delay = getCachedPricing(currentListId, chains) ? 350 : 0;
    const timer = setTimeout(() => {
      void warmShoppingSession({ listId: currentListId, chains, revision, items: itemDescriptors });
    }, delay);
    return () => clearTimeout(timer);
  }, [currentListId, itemIds.length, revision, chainKey]);

  const warmFailedThisList =
    shoppingCache.status === 'error' && shoppingCache.listId === currentListId;

  const categories = data?.categories ?? [];
  const topRow = useMemo(() => {
    const bySlug = new Map(categories.map((c) => [c.slug, c]));
    return TOP_ROW.map((s) => bySlug.get(s)).filter(Boolean) as DiscoverCategory[];
  }, [categories]);
  // "populair" = waar het geld te halen is: de categorieën met de meeste
  // lopende bonussen bij jouw supers; zonder bonusdata (catalogus zonder
  // promo's) telt het grootste assortiment — eerlijk en elke week anders
  const popular = useMemo(
    () =>
      [...categories]
        .filter((c) => c.product_count > 0)
        .sort((a, b) => b.promo_count - a.promo_count || b.product_count - a.product_count)
        .slice(0, 8),
    [categories]
  );

  const openCategory = (slug: string) =>
    router.push({ pathname: '/store/[dept]', params: { dept: slug } });

  async function addRec(p: DiscoverProduct) {
    // het getoonde product zelf, gepind op zíjn keten (rep_chain) — de
    // head_term reist mee als wisseltermijn voor de item-sheet
    await add({
      chain: p.rep_chain,
      sku_id: p.sku_id,
      name: p.name,
      term: p.head_term,
      unit_cents: p.promo_price_cents ?? p.price_cents,
    });
    setAdded((s) => new Set(s).add(`${p.chain}:${p.sku_id}`));
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 14 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Text style={type.screenTitle}>Boodschappen</Text>
          <TourTarget targetId="shopping-cart">
            <Pressable
              onPress={() => router.push('/lijst/resultaat')}
              accessibilityRole="button"
              accessibilityLabel="Naar je lijst"
              style={styles.cartBtn}
            >
              <ShoppingCart size={18} color={colors.text} strokeWidth={2} />
              {count > 0 ? (
                <View style={styles.cartBadge}>
                  <Text style={styles.cartBadgeText}>{count > 99 ? '99+' : count}</Text>
                </View>
              ) : null}
            </Pressable>
          </TourTarget>
        </View>

        <TourTarget targetId="shopping-search">
          <Pressable
            onPress={() => router.push('/store/zoeken')}
            accessibilityRole="button"
            accessibilityLabel="Zoek producten of merken"
            style={styles.searchBar}
          >
            <Search size={16} strokeWidth={2.1} color={colors.textMuted2} />
            <Text style={styles.searchHint}>Zoek producten of merken…</Text>
          </Pressable>
        </TourTarget>

        {/* snel een opgeslagen lijstje inladen (owner 2026-07-14): items komen
            bóven op de actuele lijst, zelfde gedrag als de laad-sheet in Mijn
            lijstje — hier alleen sneller bereikbaar, vanaf het eerste scherm */}
        {templates.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.templateRow}
            contentContainerStyle={styles.templateRowContent}
          >
            {templates.map((tpl) => (
              <Pressable
                key={tpl.id}
                onPress={() => quickLoadTemplate(tpl.id)}
                disabled={loadingTemplateId === tpl.id}
                accessibilityRole="button"
                accessibilityLabel={`Laad opgeslagen lijstje ${tpl.name}`}
                style={[styles.templateChip, loadingTemplateId === tpl.id && styles.templateChipBusy]}
              >
                <Bookmark size={13} color={colors.primary} strokeWidth={2.2} />
                <Text style={styles.templateChipText} numberOfLines={1}>{tpl.name}</Text>
                <Text style={styles.templateChipCount}>{tpl.itemCount}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {warmFailedThisList && currentListId && chains?.length ? (
          <Pressable
            style={styles.warmRetry}
            accessibilityRole="button"
            accessibilityLabel="Prijzen en alternatieven opnieuw voorbereiden"
            onPress={() => void warmShoppingSession({
              listId: currentListId,
              chains,
              revision,
              items: itemDescriptors,
              force: true,
            })}
          >
            <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
            <Text style={styles.warmRetryText}>Voorbereiden lukte niet · opnieuw</Text>
          </Pressable>
        ) : null}

        {/* verswanden + de deur naar alles; niets tonen tot de discover-data
            binnen is, zodat de laad-overlay niet onderbroken wordt door een
            tijdelijke kaart "Alle categorieën". */}
        {data ? (
          <TourTarget targetId="shopping-categories">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.cardRow}
              style={styles.bleed}
            >
              {topRow.map((c) => (
                <Pressable
                  key={c.slug}
                  onPress={() => openCategory(c.slug)}
                  accessibilityRole="button"
                  accessibilityLabel={c.name_nl}
                  style={styles.catCard}
                >
                  {c.image_url ? (
                    <Image source={{ uri: c.image_url }} style={styles.catImg} contentFit="contain" />
                  ) : (
                    <View style={styles.catImg} />
                  )}
                  <Text style={styles.catLabel} numberOfLines={2}>{c.name_nl}</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => router.push('/store/categorieen')}
                accessibilityRole="button"
                accessibilityLabel="Alle categorieën"
                style={styles.catCard}
              >
                <View style={styles.allIcon}>
                  <LayoutGrid size={22} color={colors.text} strokeWidth={1.9} />
                </View>
                <Text style={styles.catLabel} numberOfLines={2}>Alle categorieën</Text>
              </Pressable>
            </ScrollView>
          </TourTarget>
        ) : null}

        {popular.length > 0 ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Populaire categorieën</Text>
              <Pressable onPress={() => router.push('/store/categorieen')} hitSlop={8} accessibilityRole="button">
                <Text style={styles.sectionLink}>Bekijk alles</Text>
              </Pressable>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              style={styles.bleed}
            >
              {popular.map((c) => (
                <Pressable
                  key={c.slug}
                  onPress={() => openCategory(c.slug)}
                  accessibilityRole="button"
                  accessibilityLabel={c.name_nl}
                  style={styles.popItem}
                >
                  <View style={styles.popCircle}>
                    {c.image_url ? (
                      <Image source={{ uri: c.image_url }} style={styles.popImg} contentFit="contain" />
                    ) : null}
                  </View>
                  <Text style={styles.popLabel} numberOfLines={2}>{c.name_nl}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        ) : null}

        {(data?.aanbevolen?.length ?? 0) > 0 ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionTitle}>Aanbevolen voor jou</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.cardRow}
              style={styles.bleed}
            >
              {data!.aanbevolen.map((p) => {
                const key = `${p.chain}:${p.sku_id}`;
                const isAdded = added.has(key);
                const title = p.name;
                const meta = p.pack_size_value != null && p.pack_size_unit
                  ? `${String(p.pack_size_value).replace('.', ',')} ${p.pack_size_unit}`
                  : (p.brand ?? ' ');
                return (
                  <View key={key} style={styles.recCard}>
                    {p.image_url ? (
                      <Image source={{ uri: p.image_url }} style={styles.recImg} contentFit="contain" />
                    ) : (
                      <View style={styles.recImg} />
                    )}
                    <Text style={styles.recName} numberOfLines={2}>{title}</Text>
                    <Text style={styles.recMeta} numberOfLines={1}>{meta}</Text>
                    <View style={styles.recPriceRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.recVanaf}>vanaf</Text>
                        <View style={styles.recPriceLine}>
                          <Text style={styles.recPrice}>{formatEuroCents(p.min_price_cents)}</Text>
                          <ChainLogo id={p.chain} size={17} />
                        </View>
                      </View>
                      <Pressable
                        onPress={() => addRec(p)}
                        disabled={isAdded}
                        accessibilityRole="button"
                        accessibilityLabel={isAdded ? `${p.head_term} staat op je lijstje` : `Zet ${p.head_term} op je lijstje`}
                        style={[styles.addBtn, isAdded && styles.addBtnDone]}
                      >
                        {isAdded ? (
                          <Check size={16} color={colors.primary} strokeWidth={2.6} />
                        ) : (
                          <Plus size={16} color={colors.onPrimary} strokeWidth={2.6} />
                        )}
                      </Pressable>
                    </View>
                    <Text style={styles.recOffers}>
                      {p.offer_count > 0
                        ? `${p.offer_count} ${p.offer_count === 1 ? 'aanbieding' : 'aanbiedingen'}`
                        : `bij ${p.chain_count} ${p.chain_count === 1 ? 'supermarkt' : 'supers'}`}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          </>
        ) : null}

        {/* eerste keer openen: verse ontdek-data komt binnen — toon een balk in
            plaats van een leeg scherm (owner 2026-07-21) */}
        {!data ? (
          <View style={{ marginTop: 40, gap: 8 }}>
            <LoadingBar label="Aanbiedingen en categorieën laden…" />
          </View>
        ) : null}
      </ScrollView>

      <LijstFooter count={count} lastAdded={lastAdded} aboveTabBar />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 210, gap: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cartBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderSubtle, alignItems: 'center', justifyContent: 'center',
  },
  cartBadge: {
    position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  cartBadgeText: { fontSize: 10, fontFamily: fonts.bodyBold, color: colors.onPrimary },
  // owner-mockup 2026-07-14: lichtgrijs gevulde zoekbalk op de witte pagina
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg, paddingHorizontal: 15, height: 48,
  },
  searchHint: { fontSize: 13.5, fontFamily: fonts.body, color: colors.textMuted2 },
  templateRow: { marginHorizontal: -20 },
  templateRowContent: { paddingHorizontal: 20, gap: 8 },
  templateChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderSubtle,
    paddingVertical: 8, paddingHorizontal: 12, maxWidth: 180, ...shadows.card,
  },
  templateChipBusy: { opacity: 0.6 },
  templateChipText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.text, flexShrink: 1 },
  templateChipCount: { fontSize: 11, fontFamily: fonts.bodyMedium, color: colors.textMuted2 },
  warmRetry: {
    minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(46,107,62,.2)', backgroundColor: colors.badgeBg,
  },
  warmRetryText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.primary },
  /** horizontale rijen breken uit de schermmarge (kaarten lopen het beeld uit) */
  bleed: { marginHorizontal: -20 },
  cardRow: { paddingHorizontal: 20, gap: 10, flexDirection: 'row' },
  chipRow: { paddingHorizontal: 20, gap: 12, flexDirection: 'row' },
  catCard: {
    width: 94, backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.borderSubtle, paddingVertical: 12, paddingHorizontal: 8,
    alignItems: 'center', gap: 8, ...shadows.card,
  },
  catImg: { width: 58, height: 52 },
  allIcon: {
    width: 58, height: 52, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.badgeBg, borderRadius: 14,
  },
  catLabel: {
    fontSize: 11, fontFamily: fonts.bodySemiBold, color: colors.text,
    textAlign: 'center', lineHeight: 14, minHeight: 28,
  },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 },
  sectionTitle: { fontSize: 16.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  sectionLink: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
  popItem: { width: 78, alignItems: 'center', gap: 7 },
  popCircle: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderSubtle, alignItems: 'center', justifyContent: 'center',
    ...shadows.card,
  },
  popImg: { width: 44, height: 44 },
  popLabel: { fontSize: 10.5, fontFamily: fonts.bodyMedium, color: colors.textSoft, textAlign: 'center', lineHeight: 13 },
  recCard: {
    width: 156, backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.borderSubtle, padding: 12, gap: 4, ...shadows.card,
  },
  recImg: { width: '100%', height: 92, marginBottom: 4 },
  recName: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.text, lineHeight: 16, minHeight: 32 },
  recMeta: { fontSize: 10.5, fontFamily: fonts.body, color: colors.textMuted2 },
  recPriceRow: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 2 },
  recVanaf: { fontSize: 9.5, fontFamily: fonts.bodyMedium, color: colors.textMuted2 },
  recPriceLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recPrice: { fontSize: 15.5, fontFamily: fonts.bodyBold, color: colors.text },
  addBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', ...shadows.fab,
  },
  addBtnDone: { backgroundColor: colors.badgeBg, shadowOpacity: 0, elevation: 0 },
  recOffers: { fontSize: 10.5, fontFamily: fonts.bodySemiBold, color: colors.primary, marginTop: 2 },
});
