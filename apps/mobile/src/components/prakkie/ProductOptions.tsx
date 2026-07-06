import { formatEuroCents } from '@prakkie/shared';
import { Image } from 'expo-image';
import { Check, Search } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { authedRequest } from '../../data/api';
import { colors, fonts, type } from '../../theme/tokens';

/**
 * The product dropdown (owner UX 2026-07-06): the app never decides for you —
 * every matching product for a term is listed with thumbnail + price, and the
 * user picks. Used per list item (Boodschappen) and per ingredient in the
 * recipe → lijst flow.
 */

export interface ProductOption {
  sku_id: string;
  name: string;
  brand?: string | null;
  price_cents: number;
  promo_price_cents?: number | null;
  image_url?: string | null;
  confidence?: number;
}

export function useProductOptions(term: string | null, chain: string) {
  const [options, setOptions] = useState<ProductOption[] | null>(null);
  useEffect(() => {
    if (!term) return;
    let live = true;
    setOptions(null);
    authedRequest(`/v1/match?item=${encodeURIComponent(term)}&chains=${chain}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { matches: Record<string, { shortlist: ProductOption[] }> };
        if (live) setOptions(body.matches[chain]?.shortlist ?? []);
      })
      .catch(() => {
        if (live) setOptions([]);
      });
    return () => {
      live = false;
    };
  }, [term, chain]);
  return options;
}

export function ProductOptions({
  term,
  chain,
  currentSku,
  onPick,
  maxRows = 12,
  searchable = true,
}: {
  term: string | null;
  chain: string;
  currentSku?: string | null;
  onPick: (option: ProductOption) => void;
  maxRows?: number;
  /** vind álles: "croissant" typen bij "roomboter" haalt de croissants op */
  searchable?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const options = useProductOptions(debounced || term, chain);

  const searchBox = searchable ? (
    <View style={styles.searchRow}>
      <Search size={14} color="#97A08F" strokeWidth={2.2} />
      <TextInput
        style={styles.searchInput}
        placeholder={`Zoek alles bij ${chain.toUpperCase()}: bijv. ${term ?? ''} croissant…`}
        placeholderTextColor="#97A08F"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
      />
    </View>
  ) : null;

  if (options === null) {
    return (
      <View>
        {searchBox}
        <Text style={[type.meta, styles.state]}>Producten laden…</Text>
      </View>
    );
  }
  if (options.length === 0) {
    return (
      <View>
        {searchBox}
        <Text style={[type.meta, styles.state]}>Geen producten gevonden — probeer een ander woord.</Text>
      </View>
    );
  }
  return (
    <View>
      {searchBox}
      {options.slice(0, maxRows).map((o) => {
        const chosen = o.sku_id === currentSku;
        return (
          <Pressable key={o.sku_id} style={[styles.row, chosen && styles.rowChosen]} onPress={() => onPick(o)}>
            {o.image_url ? (
              <Image source={{ uri: o.image_url }} style={styles.thumb} contentFit="contain" />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]} />
            )}
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <Text style={styles.name} numberOfLines={2}>{o.name}</Text>
              {o.brand ? <Text style={styles.brand} numberOfLines={1}>{o.brand}</Text> : null}
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              {o.promo_price_cents != null && o.promo_price_cents < o.price_cents ? (
                <>
                  <Text style={styles.oldPrice}>{formatEuroCents(o.price_cents)}</Text>
                  <Text style={styles.price}>{formatEuroCents(o.promo_price_cents)}</Text>
                </>
              ) : (
                <Text style={styles.price}>{formatEuroCents(o.price_cents)}</Text>
              )}
            </View>
            {chosen ? <Check size={16} color={colors.primary} strokeWidth={2.6} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  state: { paddingVertical: 10 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.bg,
    borderRadius: 11, paddingHorizontal: 11, paddingVertical: 8, marginBottom: 6,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.1)',
  },
  searchInput: { flex: 1, fontSize: 12.5, color: colors.text, padding: 0 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 6,
    borderRadius: 12,
  },
  rowChosen: { backgroundColor: colors.badgeBg },
  thumb: { width: 40, height: 40, borderRadius: 8, backgroundColor: '#FFFFFF' },
  thumbEmpty: { backgroundColor: '#EDE7D8' },
  name: { fontSize: 12.5, color: colors.text, lineHeight: 16 },
  brand: { fontSize: 10.5, color: '#97A08F' },
  price: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  oldPrice: { fontSize: 10.5, color: '#B9C0B2', textDecorationLine: 'line-through' },
});
