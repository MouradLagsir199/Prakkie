import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Check, ChevronLeft, Crown, Trash2, UserPlus, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CTAButton } from '../components/prakkie/CTAButton';
import { syncNow } from '../data';
import { authedRequest, currentUser } from '../data/api';
import { invalidateHousehold, loadHousehold, roleLabel, type HouseholdInfo, type MemberInfo } from '../data/households';
import { confirmDialog, notice } from '../lib/dialogs';
import { colors, fonts, radius, shadows, type } from '../theme/tokens';

/**
 * Groep-beheer (owner 2026-07-07 avond): de admin deelt hier rechten toe
 * — editor (mag bewerken) of viewer (alleen lezen) — nodigt leden uit en
 * verwijdert ze. Iedereen ziet de profielfoto's en wanneer een lid voor het
 * laatst actief was. Gedeelde lijsten en recepten volgen deze rechten:
 * viewers zien alles mee maar kunnen niets wijzigen (server-afgedwongen).
 */

const AVATAR_TINTS = ['#E7EEDD', '#F6E3D4', '#E3E9F6', '#F6E3F0'];

function lastActiveLabel(iso: string | null | undefined): string {
  if (!iso) return 'nog niet actief';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days <= 0) return 'vandaag actief';
  if (days === 1) return 'gisteren actief';
  if (days < 30) return `${days} dagen geleden actief`;
  return `${Math.floor(days / 30)} maand${days >= 60 ? 'en' : ''} geleden actief`;
}

export default function GroepScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [household, setHousehold] = useState<HouseholdInfo | null>(null);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [householdName, setHouseholdName] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const isAdmin = household?.role === 'owner';

  const refresh = useCallback(async () => {
    const h = await loadHousehold(true);
    setHousehold(h.household);
    setMembers(h.members);
    const u = await currentUser().catch(() => null);
    setMyId(u?.id ?? null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function createHousehold() {
    const name = householdName.trim() || 'Thuis';
    setBusy(true);
    try {
      const res = await authedRequest('/v1/households', { method: 'POST', body: JSON.stringify({ name }) });
      if (!res.ok) throw new Error(String(res.status));
      invalidateHousehold();
      await refresh();
    } catch {
      notice('Niet gelukt', 'Groep maken vereist internet.');
    } finally {
      setBusy(false);
    }
  }

  async function sendInvite() {
    const target = inviteEmail.trim().toLowerCase();
    if (!target || !household) return;
    setBusy(true);
    try {
      const res = await authedRequest(`/v1/households/${household.id}/invite`, {
        method: 'POST',
        body: JSON.stringify({ email: target }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setInviteEmail('');
      setInviteOpen(false);
      notice('Uitgenodigd', `${target} ziet de uitnodiging zodra die inlogt met dat e-mailadres.`);
    } catch {
      notice('Niet gelukt', 'Uitnodigen vereist internet (en admin-rechten).');
    } finally {
      setBusy(false);
    }
  }

  async function setRole(member: MemberInfo, role: 'editor' | 'viewer') {
    if (!household || member.role === role) return;
    try {
      const res = await authedRequest(`/v1/households/${household.id}/members/${member.user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMembers((ms) => ms.map((m) => (m.user_id === member.user_id ? { ...m, role } : m)));
      invalidateHousehold();
    } catch {
      notice('Niet gelukt', 'Rol wijzigen vereist internet en admin-rechten.');
    }
  }

  async function removeMember(member: MemberInfo) {
    if (!household) return;
    const self = member.user_id === myId;
    const naam = member.display_name ?? member.email ?? 'dit lid';
    const ok = await confirmDialog({
      title: self ? 'Groep verlaten?' : `${naam} verwijderen?`,
      message: self
        ? 'Je verliest de toegang tot gedeelde lijsten en recepten.'
        : 'Diegene verliest de toegang tot gedeelde lijsten en recepten.',
      confirmLabel: self ? 'Verlaat' : 'Verwijderen',
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await authedRequest(`/v1/households/${household.id}/members/${member.user_id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(String(res.status));
      invalidateHousehold();
      if (self) {
        syncNow().catch(() => {});
        router.back();
        return;
      }
      await refresh();
    } catch {
      notice('Niet gelukt', 'Verwijderen vereist internet.');
    }
  }

  const memberRow = (m: MemberInfo, i: number) => {
    const naam = m.display_name ?? m.email ?? 'groepslid';
    const self = m.user_id === myId;
    return (
      <View key={m.user_id} style={[styles.memberRow, i < members.length - 1 && styles.memberBorder]}>
        <View style={[styles.avatar, { backgroundColor: AVATAR_TINTS[i % AVATAR_TINTS.length] }]}>
          {m.avatar_url ? (
            <Image source={{ uri: m.avatar_url }} style={styles.avatarImg} contentFit="cover" />
          ) : (
            <Text style={styles.avatarText}>{naam.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.memberName} numberOfLines={1}>
              {naam}{self ? ' (jij)' : ''}
            </Text>
            {m.role === 'owner' ? <Crown size={13} color="#C9A227" strokeWidth={2.2} /> : null}
          </View>
          <Text style={type.meta}>{roleLabel(m.role)} · {lastActiveLabel(m.last_active_at)}</Text>
          {/* rechten toedelen — alleen de admin, nooit op zichzelf/de admin */}
          {isAdmin && m.role !== 'owner' ? (
            <View style={styles.roleRow}>
              {(['editor', 'viewer'] as const).map((r) => {
                const on = m.role === r;
                return (
                  <Pressable key={r} onPress={() => setRole(m, r)} style={[styles.roleChip, on && styles.roleChipOn]}>
                    {on ? <Check size={11} color={colors.onPrimary} strokeWidth={2.6} /> : null}
                    <Text style={[styles.roleChipText, on && { color: colors.onPrimary }]}>
                      {r === 'editor' ? 'Mag bewerken' : 'Alleen lezen'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
        {(isAdmin && m.role !== 'owner') || (self && m.role !== 'owner') ? (
          <Pressable onPress={() => removeMember(m)} hitSlop={8} accessibilityLabel={self ? 'Verlaat groep' : `Verwijder ${naam}`}>
            <Trash2 size={16} color={colors.danger} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 18 }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/profiel'))} hitSlop={10}>
          <ChevronLeft size={24} color={colors.text} strokeWidth={2.2} />
        </Pressable>
        <Text style={styles.title}>Groep</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {!household ? (
          <View style={styles.card}>
            <Text style={type.h3}>Nog geen groep</Text>
            <Text style={type.meta}>
              Maak er een en nodig groepsleden uit — jullie delen dan boodschappenlijsten en recepten.
              Jij wordt automatisch admin.
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Naam, bijv. Thuis"
                placeholderTextColor={colors.textMuted2}
                value={householdName}
                onChangeText={setHouseholdName}
                onSubmitEditing={createHousehold}
              />
              <CTAButton label={busy ? '…' : 'Maak'} onPress={createHousehold} disabled={busy} />
            </View>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={type.h2}>“{household.name}”</Text>
                <Text style={styles.roleBadge}>jij bent {roleLabel(household.role)}</Text>
              </View>
              <Text style={type.meta}>
                {isAdmin
                  ? 'Jij beheert deze groep: nodig leden uit en bepaal per lid of die mag bewerken of alleen meekijken.'
                  : household.role === 'viewer'
                    ? 'Je kijkt mee met deze groep — bewerken kan alleen als de admin je rechten geeft.'
                    : 'Je kunt gedeelde lijsten en recepten bewerken. De admin beheert leden en rechten.'}
              </Text>
            </View>

            <Text style={styles.sectionLabel}>LEDEN · {members.length}</Text>
            <View style={styles.card}>{members.map(memberRow)}</View>

            {isAdmin ? (
              inviteOpen ? (
                <View style={styles.card}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={type.h3}>Nodig iemand uit</Text>
                    <Pressable onPress={() => setInviteOpen(false)} hitSlop={10}>
                      <X size={18} color={colors.textSoft} />
                    </Pressable>
                  </View>
                  <Text style={type.meta}>
                    Diegene ziet de uitnodiging in Prakkie na inloggen met dit e-mailadres en doet mee als “mag bewerken”
                    — daarna pas je de rechten hier aan.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TextInput
                      style={[styles.input, { flex: 1 }]}
                      placeholder="naam@voorbeeld.nl"
                      placeholderTextColor={colors.textMuted2}
                      autoCapitalize="none"
                      keyboardType="email-address"
                      value={inviteEmail}
                      onChangeText={setInviteEmail}
                      onSubmitEditing={sendInvite}
                    />
                    <CTAButton label={busy ? '…' : 'Stuur'} onPress={sendInvite} disabled={busy} />
                  </View>
                </View>
              ) : (
                <CTAButton
                  label="Huisgenoot uitnodigen"
                  icon={<UserPlus size={16} color={colors.onPrimary} strokeWidth={2} />}
                  onPress={() => setInviteOpen(true)}
                />
              )
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 8 },
  title: { fontFamily: fonts.display, fontSize: 22, color: colors.text },
  content: { paddingHorizontal: 20, paddingBottom: 60, gap: 12, paddingTop: 8 },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.listCard, padding: 16, gap: 10,
    borderWidth: 1, borderColor: colors.borderSubtle,
    ...shadows.card,
  },
  sectionLabel: { ...type.sectionLabel, marginTop: 4 },
  roleBadge: {
    fontSize: 11, fontFamily: fonts.bodyBold, color: colors.primary, backgroundColor: colors.badgeBg,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden',
  },
  memberRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10 },
  memberBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  avatar: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: 44, height: 44 },
  avatarText: { fontSize: 15, fontFamily: fonts.bodyBold, color: colors.textSoft },
  memberName: { fontSize: 14.5, fontFamily: fonts.bodySemiBold, color: colors.text, flexShrink: 1 },
  roleRow: { flexDirection: 'row', gap: 6, marginTop: 6 },
  roleChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: radius.pill, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.borderControl,
  },
  roleChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  roleChipText: { fontSize: 11.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  input: {
    backgroundColor: colors.surfaceMuted, borderRadius: radius.control, paddingHorizontal: 14, paddingVertical: 11,
    borderWidth: 1, borderColor: colors.borderControl, fontSize: 13.5, color: colors.text,
  },
});
