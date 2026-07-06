import { CHAIN_IDS, CHAINS, LIVE_CHAIN_IDS, type ChainId } from '@prakkie/shared';
import { Check, ChevronRight, Minus, Plus, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { syncNow } from '../../data';
import { authedRequest, currentUser, login, register } from '../../data/api';
import { invalidateHousehold, loadHousehold, type HouseholdInfo, type MemberInfo } from '../../data/households';
import { kv } from '../../data/kv';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Profiel — Bordje-Profiel.png 1:1 (vervangt de Prijzen-tab, owner 2026-07-06):
 * profielkaart met huishouden + leden-chips + invite, instellingen-rijen
 * (supers, taal, eenheden, porties, meldingen), premium-teaser, GDPR-voet.
 * Huishouden werkt op e-mail-invites; daarvoor is de account-rij nodig
 * (gast → e-mailaccount, bestaande data blijft).
 */

interface PendingInvite { id: string; household_id: string; household_name: string; invited_by_name: string | null }

const AVATAR_TINTS = ['#E7EEDD', '#F6E3D4', '#E3E9F6', '#F6E3F0'];

export default function ProfielScreen() {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [servings, setServings] = useState(2);
  const [chains, setChains] = useState<ChainId[]>([]);
  const [notifications, setNotifications] = useState(true);
  const [household, setHousehold] = useState<HouseholdInfo | null>(null);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [sheet, setSheet] = useState<'none' | 'invite' | 'household' | 'chains' | 'account'>('none');
  const [inviteEmail, setInviteEmail] = useState('');
  const [householdName, setHouseholdName] = useState('');
  const [accEmail, setAccEmail] = useState('');
  const [accPassword, setAccPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await authedRequest('/v1/me');
      if (res.ok) {
        const me = (await res.json()) as {
          display_name?: string | null; email?: string | null; default_servings?: number; home_chain_ids?: string[];
        };
        setName(me.display_name ?? '');
        setEmail(me.email ?? null);
        setServings(me.default_servings ?? 2);
        setChains(((me.home_chain_ids ?? []) as ChainId[]).filter((c) => LIVE_CHAIN_IDS.includes(c)));
      }
    } catch {
      const u = await currentUser().catch(() => null);
      if (u) {
        setName(u.display_name ?? '');
        setEmail(u.email);
      }
    }
    const h = await loadHousehold(true);
    setHousehold(h.household);
    setMembers(h.members);
    try {
      const inv = await authedRequest('/v1/households/invites');
      if (inv.ok) setInvites(((await inv.json()) as { invites: PendingInvite[] }).invites);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    refresh();
    kv.getItem('prakkie.notifications').then((v) => setNotifications(v !== '0')).catch(() => {});
  }, [refresh]);

  async function patchMe(fields: Record<string, unknown>) {
    try {
      await authedRequest('/v1/me', { method: 'PATCH', body: JSON.stringify(fields) });
    } catch {
      /* offline: volgende keer */
    }
  }

  function toggleChain(id: ChainId) {
    const next = chains.includes(id) ? chains.filter((c) => c !== id) : [...chains, id];
    setChains(next);
    patchMe({ home_chain_ids: next.length ? next : ['ah'] });
    kv.setItem('prakkie.homechain', next[0] ?? 'ah').catch(() => {});
  }

  function bumpServings(delta: number) {
    const next = Math.max(1, servings + delta);
    setServings(next);
    patchMe({ default_servings: next });
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
      setSheet('none');
      Alert.alert('Uitgenodigd', `${target} ziet de uitnodiging zodra die inlogt met dat e-mailadres.`);
    } catch {
      Alert.alert('Niet gelukt', 'Uitnodigen vereist internet.');
    } finally {
      setBusy(false);
    }
  }

  async function createHousehold() {
    const hhName = householdName.trim() || 'Thuis';
    setBusy(true);
    try {
      const res = await authedRequest('/v1/households', { method: 'POST', body: JSON.stringify({ name: hhName }) });
      if (!res.ok) throw new Error(String(res.status));
      invalidateHousehold();
      setHouseholdName('');
      setSheet('invite'); // meteen door naar uitnodigen
      await refresh();
    } catch {
      Alert.alert('Niet gelukt', 'Huishouden maken vereist internet.');
    } finally {
      setBusy(false);
    }
  }

  async function acceptInvite(inv: PendingInvite) {
    try {
      const res = await authedRequest(`/v1/households/invites/${inv.id}/accept`, { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(String(res.status));
      invalidateHousehold();
      await refresh();
      syncNow().catch(() => {});
      Alert.alert('Welkom!', `Je zit nu in “${inv.household_name}” — boodschappen worden gedeeld.`);
    } catch {
      Alert.alert('Niet gelukt', 'Accepteren vereist internet.');
    }
  }

  async function submitAccount(mode: 'register' | 'login') {
    const em = accEmail.trim().toLowerCase();
    if (!em || accPassword.length < 8) {
      Alert.alert('Check je invoer', 'E-mail + wachtwoord van minimaal 8 tekens.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') await register(em, accPassword, name || undefined);
      else await login(em, accPassword);
      setAccPassword('');
      setSheet('none');
      invalidateHousehold();
      await refresh();
      syncNow().catch(() => {});
      Alert.alert('Gelukt', `Je bent ingelogd als ${em}.`);
    } catch (e) {
      Alert.alert('Niet gelukt', e instanceof Error ? e.message : 'Probeer het opnieuw.');
    } finally {
      setBusy(false);
    }
  }

  const initials = (name || email || 'P').slice(0, 2).toUpperCase();
  const others = members.filter((m) => (m.display_name ?? m.email ?? '') !== (name || email || ''));

  const row = (label: string, right: React.ReactNode, onPress?: () => void, last = false) => (
    <Pressable style={[styles.settingRow, !last && styles.settingBorder]} onPress={onPress} disabled={!onPress}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>{right}</View>
    </Pressable>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Profiel</Text>

        {/* profielkaart — avatar, naam, huishouden, leden + invite */}
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <TextInput
              style={styles.nameInput}
              value={name}
              placeholder="Jouw naam"
              placeholderTextColor="#97A08F"
              onChangeText={setName}
              onEndEditing={() => name.trim() && patchMe({ display_name: name.trim() })}
            />
            <Text style={type.meta} numberOfLines={1}>
              {household ? `Huishouden “${household.name}” · ${household.member_count} ${household.member_count === 1 ? 'persoon' : 'personen'}` : 'nog geen huishouden'}
            </Text>
          </View>
          <View style={styles.memberRow}>
            {others.slice(0, 2).map((m, i) => (
              <View key={m.user_id} style={[styles.memberChip, { backgroundColor: AVATAR_TINTS[i % AVATAR_TINTS.length] }]}>
                <Text style={styles.memberChipText}>
                  {(m.display_name ?? m.email ?? '?').slice(0, 1).toUpperCase()}
                </Text>
              </View>
            ))}
            <Pressable
              style={[styles.memberChip, styles.memberAdd]}
              onPress={() => {
                if (!email) {
                  Alert.alert('Eerst een account', 'Huishoudens werken via e-mail — koppel eerst je e-mailadres.', [
                    { text: 'Later', style: 'cancel' },
                    { text: 'Account koppelen', onPress: () => setSheet('account') },
                  ]);
                } else setSheet(household ? 'invite' : 'household');
              }}
            >
              <Plus size={14} color={colors.textSoft} strokeWidth={2.2} />
            </Pressable>
          </View>
        </View>

        {/* openstaande uitnodigingen voor mij */}
        {invites.map((inv) => (
          <View key={inv.id} style={styles.inviteStrip}>
            <Text style={[type.body, { flex: 1, fontSize: 13 }]} numberOfLines={2}>
              {inv.invited_by_name ?? 'Iemand'} nodigt je uit voor{' '}
              <Text style={{ fontFamily: fonts.bodyBold }}>“{inv.household_name}”</Text>
            </Text>
            <Pressable style={styles.inviteAccept} onPress={() => acceptInvite(inv)}>
              <Text style={styles.inviteAcceptText}>Accepteer</Text>
            </Pressable>
          </View>
        ))}

        {/* instellingen-rijen — mockup-volgorde */}
        <View style={styles.card}>
          {row(
            'Mijn supermarkten',
            <>
              {(chains.length ? chains : (['ah'] as ChainId[])).slice(0, 3).map((c) => (
                <View key={c} style={styles.superChip}>
                  <Text style={styles.superChipText}>{CHAINS[c].chip}</Text>
                </View>
              ))}
              {chains.length > 3 ? <Text style={type.meta}>+{chains.length - 3}</Text> : null}
              <ChevronRight size={15} color={colors.textMuted} />
            </>,
            () => setSheet('chains')
          )}
          {row('Account', (
            <>
              <Text style={styles.settingValue} numberOfLines={1}>{email ?? 'gast'}</Text>
              <ChevronRight size={15} color={colors.textMuted} />
            </>
          ), () => setSheet('account'))}
          {row('Taal', (
            <>
              <Text style={styles.settingValue}>Nederlands</Text>
              <ChevronRight size={15} color={colors.textMuted} />
            </>
          ), () => Alert.alert('Binnenkort', 'Meer talen volgen.'))}
          {row('Eenheden', (
            <>
              <Text style={styles.settingValue}>Metrisch</Text>
              <ChevronRight size={15} color={colors.textMuted} />
            </>
          ), () => Alert.alert('Binnenkort', 'Imperial volgt.'))}
          {row(
            'Standaard porties',
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Pressable onPress={() => bumpServings(-1)} hitSlop={8} style={styles.stepBtn}>
                <Minus size={13} color={colors.text} />
              </Pressable>
              <Text style={[styles.settingValue, { color: colors.text, minWidth: 16, textAlign: 'center' }]}>{servings}</Text>
              <Pressable onPress={() => bumpServings(1)} hitSlop={8} style={styles.stepBtn}>
                <Plus size={13} color={colors.text} />
              </Pressable>
            </View>
          )}
          {row(
            'Meldingen',
            <Switch
              value={notifications}
              onValueChange={(v) => {
                setNotifications(v);
                kv.setItem('prakkie.notifications', v ? '1' : '0').catch(() => {});
              }}
              trackColor={{ true: colors.primary, false: '#D9D4C5' }}
              thumbColor="#FFFFFF"
            />,
            undefined,
            true
          )}
        </View>

        {/* premium-teaser — betalingen zijn bewust uitgeschakeld */}
        <Pressable
          style={styles.premiumCard}
          onPress={() => Alert.alert('Premium komt later', 'Alles is nu gratis tijdens de testfase.')}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={styles.premiumTitle}>Prakkie Premium</Text>
            <View style={styles.premiumBadge}>
              <Text style={styles.premiumBadgeText}>PROEF 14</Text>
            </View>
          </View>
          <Text style={styles.premiumBody}>
            Onbeperkt video-imports, prijsvergelijking over alle ketens, gedeeld huishouden en voorraad-intelligentie.
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={styles.premiumPrice}>
              <Text style={styles.premiumPriceText}>€2,99 / maand</Text>
            </View>
            <Text style={[styles.premiumBody, { flex: 1, fontFamily: fonts.bodyBold }]}>of eenmalig €39 — voor altijd</Text>
          </View>
          <Text style={styles.premiumFootnote}>Je eigen recepten blijven altijd gratis en van jou.</Text>
        </Pressable>

        <View style={styles.gdprRow}>
          <Pressable onPress={() => Alert.alert('Binnenkort', 'Data-export komt vóór de store-release.')}>
            <Text style={styles.gdprExport}>Exporteer mijn data</Text>
          </Pressable>
          <Pressable onPress={() => Alert.alert('Binnenkort', 'Account verwijderen komt vóór de store-release.')}>
            <Text style={styles.gdprDelete}>Verwijder account</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* sheets */}
      {sheet !== 'none' ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>
              {sheet === 'invite' ? 'Nodig iemand uit' : sheet === 'household' ? 'Nieuw huishouden'
                : sheet === 'chains' ? 'Mijn supermarkten' : 'Account'}
            </Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          {sheet === 'invite' ? (
            <>
              <Text style={type.meta}>
                Diegene ziet de uitnodiging in Prakkie na inloggen met dit e-mailadres — jullie delen dan de boodschappen.
              </Text>
              <View style={styles.sheetInputRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  placeholder="naam@voorbeeld.nl"
                  placeholderTextColor="#97A08F"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={inviteEmail}
                  onChangeText={setInviteEmail}
                  onSubmitEditing={sendInvite}
                />
                <Pressable style={styles.sheetBtn} onPress={sendInvite} disabled={busy}>
                  <Text style={styles.sheetBtnText}>{busy ? '…' : 'Stuur'}</Text>
                </Pressable>
              </View>
            </>
          ) : sheet === 'household' ? (
            <View style={styles.sheetInputRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Naam, bijv. Thuis"
                placeholderTextColor="#97A08F"
                value={householdName}
                onChangeText={setHouseholdName}
                onSubmitEditing={createHousehold}
              />
              <Pressable style={styles.sheetBtn} onPress={createHousehold} disabled={busy}>
                <Text style={styles.sheetBtnText}>{busy ? '…' : 'Maak'}</Text>
              </Pressable>
            </View>
          ) : sheet === 'chains' ? (
            <View style={{ gap: 8 }}>
              {CHAIN_IDS.map((id) => {
                const live = LIVE_CHAIN_IDS.includes(id);
                const on = chains.includes(id);
                return (
                  <Pressable
                    key={id}
                    disabled={!live}
                    onPress={() => toggleChain(id)}
                    style={[styles.chainRow, on && styles.chainRowOn, !live && { opacity: 0.4 }]}
                  >
                    <Text style={[type.body, { flex: 1 }, on && { color: colors.primary, fontFamily: fonts.bodySemiBold }]}>
                      {CHAINS[id].displayName}
                      {!live ? '  · binnenkort' : on && chains[0] === id ? '  · jouw winkel' : ''}
                    </Text>
                    {on ? <Check size={16} color={colors.primary} strokeWidth={2.4} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <>
              <Text style={type.meta}>
                {email
                  ? `Ingelogd als ${email}. Op een ander toestel inloggen = zelfde recepten en lijsten.`
                  : 'Koppel een e-mailaccount: nodig voor huishoudens, en je data reist mee naar elk toestel. Je blijft dezelfde gebruiker — niets gaat verloren.'}
              </Text>
              <TextInput
                style={styles.input}
                placeholder="e-mailadres"
                placeholderTextColor="#97A08F"
                autoCapitalize="none"
                keyboardType="email-address"
                value={accEmail}
                onChangeText={setAccEmail}
              />
              <TextInput
                style={styles.input}
                placeholder="wachtwoord (min. 8 tekens)"
                placeholderTextColor="#97A08F"
                secureTextEntry
                value={accPassword}
                onChangeText={setAccPassword}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable style={[styles.sheetBtn, { flex: 1 }]} onPress={() => submitAccount('register')} disabled={busy}>
                  <Text style={styles.sheetBtnText}>{email ? 'Nieuw account' : 'Registreer'}</Text>
                </Pressable>
                <Pressable style={[styles.sheetBtn, styles.sheetBtnAlt, { flex: 1 }]} onPress={() => submitAccount('login')} disabled={busy}>
                  <Text style={[styles.sheetBtnText, { color: colors.primary }]}>Inloggen</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 150, gap: 14 },
  title: { fontFamily: fonts.display, fontSize: 29, lineHeight: 32, color: colors.text },
  profileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderRadius: 18, padding: 14, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: '#22301E',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 17, fontFamily: fonts.bodyBold, color: '#FDFBF6' },
  nameInput: { fontSize: 17, fontFamily: fonts.bodyBold, color: colors.text, padding: 0 },
  memberRow: { flexDirection: 'row', alignItems: 'center' },
  memberChip: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    marginLeft: -6, borderWidth: 1.5, borderColor: colors.surface,
  },
  memberChipText: { fontSize: 11, fontFamily: fonts.bodyBold, color: colors.textSoft },
  memberAdd: { backgroundColor: '#F0EDE3' },
  inviteStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.badgeBg,
    borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11,
  },
  inviteAccept: {
    backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 13, paddingVertical: 8,
  },
  inviteAcceptText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  card: {
    backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 15, gap: 10,
  },
  settingBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  settingLabel: { fontSize: 14.5, fontFamily: fonts.bodyBold, color: colors.text },
  settingValue: { fontSize: 13.5, color: colors.textMuted, maxWidth: 170 },
  superChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.badgeBg,
  },
  superChipText: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.primary },
  stepBtn: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  premiumCard: { backgroundColor: '#22301E', borderRadius: 20, padding: 18, gap: 12 },
  premiumTitle: { fontFamily: fonts.display, fontSize: 21, color: '#FDFBF6' },
  premiumBadge: { backgroundColor: '#9CD08F', borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 5 },
  premiumBadgeText: { fontSize: 10.5, fontFamily: fonts.bodyBold, color: '#1E3317', letterSpacing: 0.6 },
  premiumBody: { fontSize: 13, lineHeight: 19, color: 'rgba(253,251,246,.85)' },
  premiumPrice: { backgroundColor: '#FDFBF6', borderRadius: radius.pill, paddingHorizontal: 15, paddingVertical: 10 },
  premiumPriceText: { fontSize: 14, fontFamily: fonts.bodyBold, color: '#22301E' },
  premiumFootnote: { fontSize: 11, color: 'rgba(253,251,246,.55)' },
  gdprRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginTop: 2 },
  gdprExport: { fontSize: 13.5, color: colors.textMuted },
  gdprDelete: { fontSize: 13.5, color: colors.danger },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 12,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetInputRow: { flexDirection: 'row', gap: 8 },
  input: {
    backgroundColor: colors.bg, borderRadius: radius.control, paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', fontSize: 14, color: colors.text,
  },
  sheetBtn: {
    backgroundColor: colors.primary, borderRadius: radius.control, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 12,
  },
  sheetBtnAlt: { backgroundColor: colors.badgeBg },
  sheetBtnText: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  chainRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.bg,
    borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1.5, borderColor: 'rgba(34,48,30,.1)',
  },
  chainRowOn: { borderColor: colors.primary, backgroundColor: colors.badgeBg },
});
