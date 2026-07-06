import { formatEuroCents } from '@prakkie/shared';
import { Image } from 'expo-image';
import { Check, Search } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { authedRequest } from '../../data/api';
import { CHAIN_BRAND, chainChip } from '../../data/chains';
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
  /** inhoud/gewicht — 300 g sandwichspread is geen 450 g */
  pack_size_value?: number | null;
  pack_size_unit?: string | null;
  unit_price_cents_per_std?: number | null;
  std_unit?: string | null;
}

/** 0,3 kg → "300 g"; 1,5 l → "1,5 l" */
function formatStdQty(qty: number, stdUnit: string): string {
  const small: Record<string, string> = { kg: 'g', l: 'ml' };
  if (qty < 1 && small[stdUnit]) {
    return `${Math.round((qty * 1000) / 5) * 5} ${small[stdUnit]}`;
  }
  const rounded = Math.round(qty * 100) / 100;
  return `${String(rounded).replace('.', ',')} ${stdUnit}`;
}

/** "300 g · €3,30/kg" — inhoud + eenheidsprijs, voor eerlijke vergelijking.
 *  Zonder expliciete pack-size wordt de inhoud afgeleid uit de eenheidsprijs
 *  (prijs ÷ prijs-per-kg) — dat is exact, want zo is die prijs ook berekend. */
export function packLabel(o: ProductOption): string | null {
  const parts: string[] = [];
  if (o.pack_size_value != null && o.pack_size_unit) {
    parts.push(`${String(o.pack_size_value).replace('.', ',')} ${o.pack_size_unit}`);
  } else if (o.unit_price_cents_per_std && o.std_unit && o.price_cents) {
    parts.push(formatStdQty(o.price_cents / o.unit_price_cents_per_std, o.std_unit));
  }
  if (o.unit_price_cents_per_std != null && o.std_unit) {
    parts.push(`${formatEuroCents(o.unit_price_cents_per_std)}/${o.std_unit}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Cross-chain variant (owner UX 2026-07-07): één zoekterm, álle geselecteerde
 *  supers in één /v1/match-call, resultaten gemerged en gesorteerd op prijs —
 *  goedkoopste bovenaan, keten-badge per rij. De user kiest, altijd. */
export interface CrossChainOption extends ProductOption {
  chain: string;
  /** relevantie-rang binnen de eigen keten-shortlist (0 = beste match) */
  rank: number;
}

export function useCrossChainOptions(term: string | null, chains: readonly string[]) {
  const [options, setOptions] = useState<CrossChainOption[] | null>(null);
  const chainKey = chains.join(',');
  useEffect(() => {
    if (!term || !chainKey) {
      setOptions(null);
      return;
    }
    let live = true;
    setOptions(null);
    authedRequest(`/v1/match?item=${encodeURIComponent(term)}&chains=${chainKey}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { matches: Record<string, { shortlist: ProductOption[] }> };
        const merged = chainKey
          .split(',')
          .flatMap((c) => (body.matches[c]?.shortlist ?? []).map((o, rank) => ({ ...o, chain: c, rank })));
        // owner 2026-07-07: puur op prijs, laag → hoog; relevantie-rang alleen
        // als tiebreak. Inhoud + eenheidsprijs per rij houden het eerlijk.
        merged.sort(
          (a, b) =>
            (a.promo_price_cents ?? a.price_cents) - (b.promo_price_cents ?? b.price_cents) || a.rank - b.rank
        );
        if (live) setOptions(merged);
      })
      .catch(() => {
        if (live) setOptions([]);
      });
    return () => {
      live = false;
    };
  }, [term, chainKey]);
  return options;
}

/** één productrij met keten-badge — gedeeld door zoeklijst en item-sheet */
export function CrossChainRow({
  option,
  chosen,
  onPick,
}: {
  option: CrossChainOption;
  chosen?: boolean;
  onPick: (option: CrossChainOption) => void;
}) {
  const brand = CHAIN_BRAND[option.chain];
  return (
    <Pressable style={[styles.row, chosen && styles.rowChosen]} onPress={() => onPick(option)}>
      {option.image_url ? (
        <Image source={{ uri: option.image_url }} style={styles.thumb} contentFit="contain" />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]} />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={styles.name} numberOfLines={2}>{option.name}</Text>
        {(() => {
          const sub = [option.brand, packLabel(option)].filter(Boolean).join(' · ');
          return sub ? <Text style={styles.brand} numberOfLines={1}>{sub}</Text> : null;
        })()}
      </View>
      {brand ? (
        <View style={[styles.chainBadge, { backgroundColor: brand.bg }]}>
          <Text style={[styles.chainBadgeText, { color: brand.fg }]}>{chainChip(option.chain)}</Text>
        </View>
      ) : null}
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        {option.promo_price_cents != null && option.promo_price_cents < option.price_cents ? (
          <>
            <Text style={styles.oldPrice}>{formatEuroCents(option.price_cents)}</Text>
            <Text style={styles.price}>{formatEuroCents(option.promo_price_cents)}</Text>
          </>
        ) : (
          <Text style={styles.price}>{formatEuroCents(option.price_cents)}</Text>
        )}
      </View>
      {chosen ? <Check size={16} color={colors.primary} strokeWidth={2.6} /> : null}
    </Pressable>
  );
}

/** Zoek + kies over alle geselecteerde supers — voor de item-sheet. */
export function CrossChainOptions({
  term,
  chains,
  currentSku,
  onPick,
  maxRows = 30,
}: {
  term: string | null;
  chains: readonly string[];
  currentSku?: string | null;
  onPick: (option: CrossChainOption) => void;
  /** ruim: liever scrollen dan een optie missen (owner 2026-07-07) */
  maxRows?: number;
}) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const options = useCrossChainOptions(debounced || term, chains);

  return (
    <View>
      <View style={styles.searchRow}>
        <Search size={14} color="#97A08F" strokeWidth={2.2} />
        <TextInput
          style={styles.searchInput}
          placeholder={`Zoek in je supers: bijv. ${term ?? 'roomboter'} croissant…`}
          placeholderTextColor="#97A08F"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
        />
      </View>
      {options === null ? (
        <Text style={[type.meta, styles.state]}>Producten laden…</Text>
      ) : options.length === 0 ? (
        <Text style={[type.meta, styles.state]}>Geen producten gevonden — probeer een ander woord.</Text>
      ) : (
        options
          .slice(0, maxRows)
          .map((o) => (
            <CrossChainRow key={`${o.chain}:${o.sku_id}`} option={o} chosen={o.sku_id === currentSku} onPick={onPick} />
          ))
      )}
    </View>
  );
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
  maxRows = 24,
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
              {(() => {
                const sub = [o.brand, packLabel(o)].filter(Boolean).join(' · ');
                return sub ? <Text style={styles.brand} numberOfLines={1}>{sub}</Text> : null;
              })()}
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
  chainBadge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  chainBadgeText: { fontSize: 8, fontFamily: fonts.bodyBold },
  price: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  oldPrice: { fontSize: 10.5, color: '#B9C0B2', textDecorationLine: 'line-through' },
});
