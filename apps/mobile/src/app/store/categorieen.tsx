import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LijstFooter } from '../../components/store/LijstFooter';
import { useStoreDiscover } from '../../store/api';
import { useBoodschappenLijst } from '../../store/lijst';
import { colors, fonts, radius, shadows, type } from '../../theme/tokens';

/**
 * Alle categorieën (owner-redesign 2026-07-12): het volledige winkeloverzicht
 * als rustige 3-koloms grid, in schap-volgorde. De bonus-teller per categorie
 * laat zien waar deze week wat te halen valt.
 */
export default function AlleCategorieen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data } = useStoreDiscover();
  const { count, lastAdded } = useBoodschappenLijst();
  const categories = data?.categories.filter((c) => c.panel_count > 0 && c.product_count > 0) ?? [];

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 14 }]}
        showsVerticalScrollIndicator={false}
      >
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
          <Text style={styles.title}>Alle categorieën</Text>
          <View style={{ width: 36 }} />
        </View>

        {!data ? (
          <Text style={[type.meta, { paddingVertical: 16 }]}>Categorieën laden…</Text>
        ) : (
          <View style={styles.grid}>
            {categories.map((c) => (
              <Pressable
                key={c.slug}
                onPress={() => router.push({ pathname: '/store/[dept]', params: { dept: c.slug } })}
                accessibilityRole="button"
                accessibilityLabel={c.name_nl}
                style={styles.card}
              >
                {c.image_url ? (
                  <Image source={{ uri: c.image_url }} style={styles.img} contentFit="contain" />
                ) : (
                  <View style={[styles.img, styles.imgEmpty]} />
                )}
                <Text style={styles.label} numberOfLines={2}>{c.name_nl}</Text>
                {c.promo_count > 0 ? (
                  <View style={styles.bonusPill}>
                    <Text style={styles.bonusText}>{c.promo_count} bonus</Text>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
      <LijstFooter count={count} lastAdded={lastAdded} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 120, gap: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  title: { fontFamily: fonts.display, fontSize: 24, lineHeight: 28, color: colors.text },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    // 3 kolommen binnen 402 - 2×20 marge - 2×10 gap
    width: '31.3%', backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.borderSubtle, paddingVertical: 12, paddingHorizontal: 6,
    alignItems: 'center', gap: 7, ...shadows.card,
  },
  img: { width: 52, height: 48 },
  imgEmpty: { backgroundColor: colors.badgeBg, borderRadius: 12 },
  label: {
    fontSize: 10.5, fontFamily: fonts.bodySemiBold, color: colors.text,
    textAlign: 'center', lineHeight: 13, minHeight: 26,
  },
  bonusPill: {
    backgroundColor: colors.bonus, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2,
  },
  bonusText: { fontSize: 9.5, fontFamily: fonts.bodyBold, color: colors.bonusText },
});
