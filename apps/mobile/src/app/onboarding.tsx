import { CHAIN_IDS, CHAINS, LIVE_CHAIN_IDS, type ChainId } from '@prakkie/shared';
import { useRouter } from 'expo-router';
import { kv } from '../data/kv';
import { Check, Minus, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authedRequest, ensureSession } from '../data/api';
import { colors, radius, type } from '../theme/tokens';

/**
 * Onboarding (A3): 11-chain multi-select ("jouw winkel" = first tap), household
 * size, then straight to the first-import aha. Guest session under water —
 * no account wall before value (spec §A1).
 */
export default function Onboarding() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [selected, setSelected] = useState<ChainId[]>([]);
  const [servings, setServings] = useState(2);
  const [busy, setBusy] = useState(false);

  function toggle(chain: ChainId) {
    setSelected((s) => (s.includes(chain) ? s.filter((c) => c !== chain) : [...s, chain]));
  }

  async function done() {
    setBusy(true);
    try {
      await ensureSession();
      await authedRequest('/v1/me', {
        method: 'PATCH',
        body: JSON.stringify({
          home_chain_ids: selected.length ? selected : ['ah'],
          default_servings: servings,
          locale: 'nl',
          units: 'metric',
        }),
      });
    } catch {
      /* offline: defaults blijven; instellingen sync later */
    }
    await kv.setItem('prakkie.onboarded', '1');
    await kv.setItem('prakkie.homechain', selected[0] ?? 'ah').catch(() => {});
    setBusy(false);
    router.replace('/import');
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}>
      <Text style={type.screenTitle}>Waar doe jij{'\n'}boodschappen?</Text>
      <Text style={[type.meta, { marginTop: 6 }]}>Kies je supers — de eerste is “jouw winkel”. Aanpassen kan altijd.</Text>

      <ScrollView contentContainerStyle={styles.chains} showsVerticalScrollIndicator={false}>
        {/* C2 — alleen live ketens zijn kiesbaar; de rest komt met verticale schaal */}
        {CHAIN_IDS.map((id) => {
          const live = LIVE_CHAIN_IDS.includes(id);
          const idx = selected.indexOf(id);
          return (
            <Pressable
              key={id}
              style={[styles.chain, idx > -1 && styles.chainOn, !live && { opacity: 0.45 }]}
              disabled={!live}
              onPress={() => toggle(id)}
            >
              <Text style={[type.h3, idx > -1 && { color: colors.primary }]}>{CHAINS[id].displayName}</Text>
              {!live ? <Text style={type.badge}>binnenkort</Text> : null}
              {idx === 0 ? <Text style={[type.badge, { color: colors.primary }]}>jouw winkel</Text> : null}
              {idx > -1 ? <Check size={18} color={colors.primary} /> : null}
            </Pressable>
          );
        })}

        <View style={styles.servingsRow}>
          <Text style={type.h3}>Hoeveel personen eten er mee?</Text>
          <View style={styles.stepper}>
            <Pressable onPress={() => setServings(Math.max(1, servings - 1))} style={styles.stepBtn}>
              <Minus size={16} color={colors.text} />
            </Pressable>
            <Text style={[type.h3, { minWidth: 30, textAlign: 'center' }]}>{servings}</Text>
            <Pressable onPress={() => setServings(servings + 1)} style={styles.stepBtn}>
              <Plus size={16} color={colors.text} />
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <Pressable style={styles.cta} onPress={done} disabled={busy}>
        <Text style={[type.h3, { color: colors.onPrimary }]}>
          {busy ? 'Even geduld…' : 'Importeer je eerste recept →'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 24 },
  chains: { gap: 8, paddingVertical: 20 },
  chain: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    backgroundColor: colors.surface, borderRadius: radius.card, padding: 16,
    borderWidth: 1.5, borderColor: colors.borderSubtle,
  },
  chainOn: { borderColor: colors.primary, backgroundColor: colors.badgeBg },
  servingsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  cta: { backgroundColor: colors.primary, borderRadius: radius.pill, padding: 17, alignItems: 'center' },
});
