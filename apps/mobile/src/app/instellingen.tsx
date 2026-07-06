import { CHAIN_IDS, CHAINS, LIVE_CHAIN_IDS, type ChainId } from '@prakkie/shared';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Check, Copy, Minus, Plus, Users, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { syncNow } from '../data';
import { authedRequest, currentUser } from '../data/api';
import { CHAIN_BRAND, chainChip } from '../data/chains';
import { colors, fonts, radius, type } from '../theme/tokens';

/**
 * Instellingen (UX-audit C3): the "aanpassen kan altijd" promise made true.
 * Chains, household size, and the household UI the backend already supported
 * (create / invite link / join by code). Entered via the avatar on Recepten.
 */

interface Household { id: string; name: string; role: string; member_count: number }

export default function Instellingen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [chains, setChains] = useState<ChainId[]>([]);
  const [servings, setServings] = useState(2);
  const [name, setName] = useState('');
  const [households, setHouseholds] = useState<Household[]>([]);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [joinToken, setJoinToken] = useState('');
  const [newHousehold, setNewHousehold] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      // fresh /v1/me first (settings live server-side); stored session as offline fallback
      interface Me { display_name?: string | null; default_servings?: number; home_chain_ids?: string[] }
      let me: Me | null = null;
      try {
        const res = await authedRequest('/v1/me');
        if (res.ok) me = (await res.json()) as Me;
      } catch {
        /* offline */
      }
      if (!me) me = ((await currentUser().catch(() => null)) ?? null) as Me | null;
      if (!me) return;
      setName(me.display_name ?? '');
      setServings(me.default_servings ?? 2);
      setChains(((me.home_chain_ids ?? []) as ChainId[]).filter((c) => LIVE_CHAIN_IDS.includes(c)));
    })();
    loadHouseholds();
  }, []);

  async function loadHouseholds() {
    try {
      const res = await authedRequest('/v1/households');
      if (res.ok) setHouseholds(((await res.json()) as { households: Household[] }).households);
    } catch {
      /* offline: sectie toont verbind-hint */
    }
  }

  function toggleChain(id: ChainId) {
    setChains((s) => (s.includes(id) ? s.filter((c) => c !== id) : [...s, id]));
  }

  async function save() {
    setBusy(true);
    try {
      const res = await authedRequest('/v1/me', {
        method: 'PATCH',
        body: JSON.stringify({
          home_chain_ids: chains.length ? chains : ['ah'],
          default_servings: servings,
          ...(name.trim() ? { display_name: name.trim() } : {}),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.back();
    } catch {
      Alert.alert('Opslaan mislukt', 'Controleer je verbinding en probeer opnieuw.');
    } finally {
      setBusy(false);
    }
  }

  async function createHousehold() {
    const hhName = newHousehold.trim();
    if (!hhName) return;
    try {
      const res = await authedRequest('/v1/households', { method: 'POST', body: JSON.stringify({ name: hhName }) });
      if (!res.ok) throw new Error(String(res.status));
      setNewHousehold('');
      await loadHouseholds();
    } catch {
      Alert.alert('Niet gelukt', 'Huishouden maken vereist internet.');
    }
  }

  async function invite(h: Household) {
    try {
      const res = await authedRequest(`/v1/households/${h.id}/invite`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { invite_token: string; deep_link: string };
      setInviteLink(body.invite_token);
    } catch {
      Alert.alert('Niet gelukt', 'Uitnodigen vereist internet.');
    }
  }

  async function join() {
    const token = joinToken.trim();
    if (!token) return;
    try {
      const res = await authedRequest('/v1/households/join', { method: 'POST', body: JSON.stringify({ token }) });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { name: string };
      setJoinToken('');
      await loadHouseholds();
      syncNow().catch(() => {});
      Alert.alert('Welkom!', `Je zit nu in “${body.name}” — recepten en lijsten worden gedeeld.`);
    } catch {
      Alert.alert('Code klopt niet', 'Controleer de uitnodigingscode en probeer opnieuw.');
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <View style={styles.headerRow}>
        <Text style={type.screenTitle}>Instellingen</Text>
        <Pressable onPress={() => router.back()} style={styles.close} accessibilityLabel="Sluiten">
          <X size={20} color={colors.textSoft} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 110, gap: 10 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.section}>JOUW NAAM</Text>
        <TextInput
          style={styles.input}
          placeholder="Hoe mogen we je noemen?"
          placeholderTextColor="#97A08F"
          value={name}
          onChangeText={setName}
        />

        <Text style={styles.section}>JOUW SUPERS · eerste = jouw winkel</Text>
        <View style={styles.chainWrap}>
          {CHAIN_IDS.map((id) => {
            const live = LIVE_CHAIN_IDS.includes(id);
            const idx = chains.indexOf(id);
            const brand = CHAIN_BRAND[id] ?? { bg: '#22301E', fg: '#fff' };
            return (
              <Pressable
                key={id}
                disabled={!live}
                onPress={() => toggleChain(id)}
                style={[styles.chainChip, idx > -1 && styles.chainChipOn, !live && { opacity: 0.4 }]}
              >
                <View style={[styles.chainDot, { backgroundColor: brand.bg }]}>
                  <Text style={[styles.chainDotText, { color: brand.fg }]}>{chainChip(id)}</Text>
                </View>
                <Text style={[styles.chainText, idx > -1 && { color: colors.primary }]}>
                  {CHAINS[id].displayName}
                  {!live ? ' · binnenkort' : idx === 0 ? ' · jouw winkel' : ''}
                </Text>
                {idx > -1 ? <Check size={14} color={colors.primary} strokeWidth={2.4} /> : null}
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>PERSONEN</Text>
        <View style={styles.servingsRow}>
          <Text style={type.body}>Standaard aantal eters</Text>
          <View style={styles.stepper}>
            <Pressable onPress={() => setServings(Math.max(1, servings - 1))} style={styles.stepBtn}>
              <Minus size={15} color={colors.text} />
            </Pressable>
            <Text style={[type.h3, { minWidth: 26, textAlign: 'center' }]}>{servings}</Text>
            <Pressable onPress={() => setServings(servings + 1)} style={styles.stepBtn}>
              <Plus size={15} color={colors.text} />
            </Pressable>
          </View>
        </View>

        <Text style={styles.section}>HUISHOUDEN · recepten, weekmenu en lijsten samen</Text>
        {households.map((h) => (
          <View key={h.id} style={styles.hhCard}>
            <Users size={17} color={colors.primary} strokeWidth={2} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={type.body} numberOfLines={1}>{h.name}</Text>
              <Text style={type.meta}>
                {h.member_count} {h.member_count === 1 ? 'lid' : 'leden'} · jij bent {h.role === 'owner' ? 'eigenaar' : 'lid'}
              </Text>
            </View>
            <Pressable style={styles.hhInvite} onPress={() => invite(h)}>
              <Text style={styles.hhInviteText}>Nodig uit</Text>
            </Pressable>
          </View>
        ))}
        {inviteLink ? (
          <Pressable
            style={styles.inviteBox}
            onPress={async () => {
              await Clipboard.setStringAsync(inviteLink);
              Alert.alert('Gekopieerd', 'Stuur de code via WhatsApp — invoeren bij “Zelf een code?”.');
            }}
          >
            <Copy size={14} color={colors.primary} strokeWidth={2} />
            <Text style={styles.inviteText} numberOfLines={1}>{inviteLink}</Text>
          </Pressable>
        ) : null}

        <View style={styles.joinRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder={households.length ? 'Zelf een code? Plak hier…' : 'Uitnodigingscode? Plak hier…'}
            placeholderTextColor="#97A08F"
            autoCapitalize="none"
            value={joinToken}
            onChangeText={setJoinToken}
            onSubmitEditing={join}
          />
          <Pressable style={styles.joinBtn} onPress={join}>
            <Text style={{ fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.onPrimary }}>Join</Text>
          </Pressable>
        </View>
        <View style={styles.joinRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="Nieuw huishouden, bijv. Thuis…"
            placeholderTextColor="#97A08F"
            value={newHousehold}
            onChangeText={setNewHousehold}
            onSubmitEditing={createHousehold}
          />
          <Pressable style={styles.joinBtn} onPress={createHousehold}>
            <Plus size={16} color={colors.onPrimary} strokeWidth={2.4} />
          </Pressable>
        </View>

        <Text style={[type.meta, { marginTop: 8 }]}>
          Prakkie werkt zonder account — je gegevens staan veilig op dit toestel en syncen anoniem.
          Betalen en inloggen met Google/Apple komen later.
        </Text>
      </ScrollView>

      <View style={[styles.ctaWrap, { paddingBottom: insets.bottom + 22 }]}>
        <Pressable style={styles.cta} onPress={save} disabled={busy}>
          <Text style={styles.ctaText}>{busy ? 'Opslaan…' : 'Bewaar instellingen'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  close: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  section: {
    marginTop: 12, fontSize: 11, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: colors.textMuted,
  },
  input: {
    backgroundColor: colors.surface, borderRadius: radius.control, paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', fontSize: 14, color: colors.text,
  },
  chainWrap: { gap: 8 },
  chainChip: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface,
    borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11, borderWidth: 1.5, borderColor: 'rgba(34,48,30,.1)',
  },
  chainChipOn: { borderColor: colors.primary, backgroundColor: colors.badgeBg },
  chainDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  chainDotText: { fontSize: 8.5, fontFamily: fonts.bodyBold },
  chainText: { flex: 1, fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  servingsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  hhCard: {
    flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.surface,
    borderRadius: 14, padding: 13, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
  },
  hhInvite: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.badgeBg,
  },
  hhInviteText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.primary },
  inviteBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.badgeBg,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
  },
  inviteText: { flex: 1, fontSize: 11, color: '#3D5138' },
  joinRow: { flexDirection: 'row', gap: 8 },
  joinBtn: {
    minWidth: 52, borderRadius: radius.control, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14,
  },
  ctaWrap: { position: 'absolute', left: 20, right: 20, bottom: 0 },
  cta: {
    backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 15, alignItems: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8,
  },
  ctaText: { fontSize: 15.5, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
});
