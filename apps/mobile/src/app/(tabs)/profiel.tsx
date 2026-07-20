import { CHAIN_IDS, CHAINS, LIVE_CHAIN_IDS, type ChainId } from '@prakkie/shared';
import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Camera, Check, ChevronRight, Plus, Sparkles, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChainLogo } from '../../components/prakkie/ChainLogo';
import { TourTarget } from '../../components/prakkie/OnboardingTour';
import { clearLocalData, syncNow } from '../../data';
import { authedRequest, currentUser, deleteAccount, login, logout, register } from '../../data/api';
import { invalidateHousehold, loadHousehold, roleLabel, type HouseholdInfo, type MemberInfo } from '../../data/households';
import { kv } from '../../data/kv';
import { resetMyChainsForSession, setMyChainsForSession } from '../../data/lijst-flow';
import { resetShoppingSessionCache } from '../../data/shopping-session-cache';
import { confirmDialog, notice } from '../../lib/dialogs';
import { resetStoreSessionCache } from '../../store/api';
import { colors, fonts, gradients, radius, shadows, type } from '../../theme/tokens';

/**
 * Profiel — premium redesign (Premium Tabs Redesign.dc.html, "Scherm: Profiel"):
 * identiteitskaart (avatar + naam/e-mail, huishouden-rij met overlappende
 * leden-avatars en gestreepte "+"), één instellingen-kaart met rijen
 * (supers, taal, eenheden, porties, meldingen), Plus-banner, uitloggen als
 * kale rode tekst. Huishouden werkt op e-mail-invites; daarvoor is de
 * account-rij nodig (gast → e-mailaccount, bestaande data blijft).
 */

interface PendingInvite { id: string; household_id: string; household_name: string; invited_by_name: string | null }

interface QuotaCounter { used: number; limit: number }
interface QuotaInfo {
  prakkie?: QuotaCounter; import?: QuotaCounter; enrich?: QuotaCounter; generate?: QuotaCounter;
  trial?: boolean; trial_expired?: boolean; trial_days_remaining?: number | null;
}
// 'prakkie' (AI-resolve) is gesloopt (owner 2026-07-13) — quota-rij mee weg
const QUOTA_ROWS: Array<{ key: 'import' | 'enrich' | 'generate'; label: string }> = [
  { key: 'import', label: 'Recept importeren' },
  { key: 'enrich', label: 'Recept aanvullen' },
  { key: 'generate', label: 'Recept genereren' },
];

// bleke tinten voor leden-avatars, met bijpassende initiaal-kleur (mockup)
const AVATAR_TINTS = [
  { bg: colors.badgeBg, fg: colors.primary },
  { bg: '#F6E3D4', fg: colors.plusText },
  { bg: '#E3E9F6', fg: colors.textSoft },
  { bg: '#F6E3F0', fg: colors.textSoft },
];

export default function ProfielScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [chains, setChains] = useState<ChainId[]>([]);
  const [notifications, setNotifications] = useState(true);
  const [household, setHousehold] = useState<HouseholdInfo | null>(null);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [sheet, setSheet] = useState<'none' | 'chains' | 'account'>('none');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [accEmail, setAccEmail] = useState('');
  const [accPassword, setAccPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authedRequest('/v1/me');
      if (res.ok) {
        const me = (await res.json()) as {
          display_name?: string | null; email?: string | null;
          home_chain_ids?: string[]; avatar_url?: string | null;
        };
        setName(me.display_name ?? '');
        setEmail(me.email ?? null);
        setChains(((me.home_chain_ids ?? []) as ChainId[]).filter((c) => LIVE_CHAIN_IDS.includes(c)));
        setAvatarUrl(me.avatar_url ?? null);
        kv.setItem('prakkie.avatar', me.avatar_url ?? '').catch(() => {});
      }
    } catch {
      const u = await currentUser().catch(() => null);
      if (u) {
        setName(u.display_name ?? '');
        setEmail(u.email);
      }
    }
    try {
      const q = await authedRequest('/v1/me/quota');
      if (q.ok) setQuota((await q.json()) as QuotaInfo);
    } catch {
      /* offline */
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
    const selected = next.length ? next : ['ah'];
    setMyChainsForSession(selected);
    resetShoppingSessionCache();
    resetStoreSessionCache();
    patchMe({ home_chain_ids: selected });
    kv.setItem('prakkie.homechain', next[0] ?? 'ah').catch(() => {});
    kv.setItem('prakkie.mychains', JSON.stringify(selected)).catch(() => {});
  }

/** profielfoto (owner 2026-07-07 avond): tik op je initialen → kies foto →
   *  upload naar /v1/me/avatar. Zichtbaar op Profiel, in het huishouden-beheer
   *  en in de header van Ontdek. */
  async function pickAvatar() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset?.uri) return;
      setBusy(true);
      // Telefoonfoto's zijn vaak groter dan de avatar-API accepteert. Verklein
      // vóór de upload; dit voorkomt dat een 413 onterecht als netwerkfout voelt.
      const context = ImageManipulator.manipulate(asset.uri);
      context.resize({ width: 768, height: 768 });
      const rendered = await context.renderAsync();
      const compressed = await rendered.saveAsync({
        base64: true,
        compress: 0.72,
        format: SaveFormat.JPEG,
      });
      if (!compressed.base64) throw new Error('De gekozen foto kon niet worden verwerkt.');
      const res = await authedRequest('/v1/me/avatar', {
        method: 'POST',
        body: JSON.stringify({ data_base64: compressed.base64, content_type: 'image/jpeg' }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        let message = `Uploaden mislukt (${res.status}).`;
        try {
          const parsed = JSON.parse(detail) as { error?: string; message?: string };
          message = parsed.message ?? parsed.error ?? message;
        } catch {
          // Niet iedere serverfout heeft een JSON-body.
        }
        throw new Error(message);
      }
      const body = (await res.json()) as { avatar_url: string };
      setAvatarUrl(body.avatar_url);
      kv.setItem('prakkie.avatar', body.avatar_url).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'De foto kon niet worden opgeslagen.';
      notice('Foto niet opgeslagen', message);
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
      notice('Welkom!', `Je zit nu in “${inv.household_name}” — boodschappen worden gedeeld.`);
    } catch {
      notice('Niet gelukt', 'Accepteren vereist internet.');
    }
  }

  async function submitAccount(mode: 'register' | 'login') {
    const em = accEmail.trim().toLowerCase();
    if (!em || accPassword.length < 8) {
      notice('Check je invoer', 'E-mail + wachtwoord van minimaal 8 tekens.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') await register(em, accPassword, name || undefined);
      else await login(em, accPassword);
      await kv.setItem('prakkie.authed', '1').catch(() => {});
      setAccPassword('');
      setSheet('none');
      invalidateHousehold();
      await refresh();
      syncNow().catch(() => {});
      notice('Gelukt', `Je bent ingelogd als ${em}.`);
    } catch (e) {
      notice('Niet gelukt', e instanceof Error ? e.message : 'Probeer het opnieuw.');
    } finally {
      setBusy(false);
    }
  }

  /** Uitloggen (owner 2026-07-07): server-sessie sluiten, lokale replica wissen,
   *  terug naar het inlogscherm. Zolang je níét uitlogt blijf je ingelogd —
   *  tokens staan in SecureStore en overleven het sluiten van de app. */
  async function doLogout() {
    const ok = await confirmDialog({
      title: 'Uitloggen?',
      message: 'Je recepten en lijsten blijven veilig in je account — lokaal worden ze van dit toestel gehaald.',
      confirmLabel: 'Uitloggen',
      destructive: true,
    });
    if (!ok) return;
    resetShoppingSessionCache();
    resetStoreSessionCache();
    resetMyChainsForSession();
    await logout();
    await clearLocalData().catch(() => {});
    await kv.removeItem('prakkie.authed').catch(() => {});
    await kv.removeItem('prakkie.onboarded').catch(() => {});
    // caches van deze gebruiker horen niet bij de volgende
    await kv.removeItem('prakkie.mychains').catch(() => {});
    await kv.removeItem('prakkie.homechain').catch(() => {});
    router.replace('/login');
  }

  async function doDeleteAccount() {
    const ok = await confirmDialog({
      title: 'Account definitief verwijderen?',
      message: 'Je toegang, profiel en sessies worden direct verwijderd. Deze actie kun je niet ongedaan maken.',
      confirmLabel: 'Verwijder account',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteAccount();
      resetShoppingSessionCache();
      resetStoreSessionCache();
      resetMyChainsForSession();
      await clearLocalData().catch(() => {});
      await Promise.all([
        kv.removeItem('prakkie.authed'), kv.removeItem('prakkie.onboarded'),
        kv.removeItem('prakkie.mychains'), kv.removeItem('prakkie.homechain'), kv.removeItem('prakkie.avatar'),
      ]).catch(() => {});
      router.replace('/login');
    } catch (error) {
      notice('Verwijderen mislukt', error instanceof Error ? error.message : 'Probeer het opnieuw.');
    } finally {
      setBusy(false);
    }
  }

  const initial = (name || email || 'P').slice(0, 1).toUpperCase();
  const others = members.filter((m) => (m.display_name ?? m.email ?? '') !== (name || email || ''));

  function setNotificationsPref(v: boolean) {
    setNotifications(v);
    kv.setItem('prakkie.notifications', v ? '1' : '0').catch(() => {});
  }

  const row = (
    label: string,
    right: React.ReactNode,
    onPress?: () => void,
    last = false,
    targetId?: string,
  ) => {
    const content = (
      <Pressable
        style={[styles.settingRow, !last && styles.settingBorder]}
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={onPress ? label : undefined}
      >
        <Text style={styles.settingLabel}>{label}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>{right}</View>
      </Pressable>
    );
    return targetId ? <TourTarget targetId={targetId}>{content}</TourTarget> : content;
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 24 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={type.screenTitle}>Profiel</Text>

        {/* identiteitskaart — tik de foto/initiaal om een profielfoto te kiezen */}
        <View style={styles.profileCard}>
          <View style={styles.profileTop}>
            <Pressable onPress={pickAvatar} accessibilityLabel="Profielfoto wijzigen" style={styles.avatarWrap}>
              <View style={styles.avatar}>
                {avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.avatarImg} contentFit="cover" />
                ) : (
                  <Text style={styles.avatarText}>{initial}</Text>
                )}
              </View>
              <View style={styles.avatarEdit}>
                <Camera size={11} color={colors.onPrimary} strokeWidth={2.4} />
              </View>
            </Pressable>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <TextInput
                style={styles.nameInput}
                value={name}
                placeholder="Jouw naam"
                placeholderTextColor={colors.textMuted2}
                onChangeText={setName}
                onEndEditing={() => name.trim() && patchMe({ display_name: name.trim() })}
              />
              <Text style={styles.emailText} numberOfLines={1}>{email ?? 'gast — nog geen account gekoppeld'}</Text>
            </View>
          </View>
          <View style={styles.cardDivider} />
          <View style={styles.householdRow}>
            <Text style={styles.householdLabel} numberOfLines={1}>
              {household ? `Groep “${household.name}”` : 'Nog geen groep'}
            </Text>
            <View style={{ flex: 1 }} />
            {others.slice(0, 2).map((m, i) => (
              <View
                key={m.user_id}
                style={[styles.memberChip, i > 0 && styles.memberOverlap, { backgroundColor: AVATAR_TINTS[i % AVATAR_TINTS.length].bg }]}
              >
                {m.avatar_url ? (
                  <Image source={{ uri: m.avatar_url }} style={styles.memberChipImg} contentFit="cover" />
                ) : (
                  <Text style={[styles.memberChipText, { color: AVATAR_TINTS[i % AVATAR_TINTS.length].fg }]}>
                    {(m.display_name ?? m.email ?? '?').slice(0, 1).toUpperCase()}
                  </Text>
                )}
              </View>
            ))}
            <TourTarget targetId="profile-group" style={others.length > 0 ? styles.memberOverlap : undefined}>
              <Pressable
                style={styles.memberAdd}
                accessibilityLabel="Groep beheren"
                onPress={async () => {
                  if (!email) {
                    const link = await confirmDialog({
                      title: 'Eerst een account',
                      message: 'Groepen werken via e-mail — koppel eerst je e-mailadres.',
                      confirmLabel: 'Account koppelen',
                    });
                    if (link) setSheet('account');
                  } else router.push('/huishouden');
                }}
              >
                <Plus size={13} color={colors.textMuted2} strokeWidth={2.2} />
              </Pressable>
            </TourTarget>
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
            'Groep',
            <>
              <Text style={styles.settingValue} numberOfLines={1}>
                {household ? `“${household.name}” · ${roleLabel(household.role)}` : 'aanmaken'}
              </Text>
              <ChevronRight size={15} color={colors.textDisabled} strokeWidth={2} />
            </>,
            () => router.push('/huishouden'),
            false,
          )}
          {row(
            'Mijn supermarkten',
            <>
              {(chains.length ? chains : (['ah'] as ChainId[])).slice(0, 4).map((c, i) => (
                <View key={c} style={i > 0 ? styles.chainOverlap : undefined}>
                  <ChainLogo id={c} size={22} />
                </View>
              ))}
              {chains.length > 4 ? <Text style={type.meta}>+{chains.length - 4}</Text> : null}
              <ChevronRight size={15} color={colors.textDisabled} strokeWidth={2} />
            </>,
            () => setSheet('chains'),
            false,
            'profile-chains',
          )}
          {row('Account', (
            <>
              <Text style={styles.settingValue} numberOfLines={1}>{email ?? 'gast'}</Text>
              <ChevronRight size={15} color={colors.textDisabled} strokeWidth={2} />
            </>
          ), () => setSheet('account'))}
          {row(
            'Meldingen',
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: notifications }}
              accessibilityLabel="Meldingen"
              hitSlop={8}
              onPress={() => setNotificationsPref(!notifications)}
              style={[styles.toggle, notifications && styles.toggleOn]}
            >
              <View style={[styles.toggleKnob, notifications && styles.toggleKnobOn]} />
            </Pressable>,
            undefined,
            true,
          )}
        </View>

        {/* AI-tegoed als gewone instellingenkaart: rustig en herkenbaar. */}
        <View style={styles.quotaCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Sparkles size={14} color={colors.primary} strokeWidth={2.2} />
            <Text style={styles.quotaTitle}>AI-tegoed deze maand</Text>
            <View style={{ flex: 1 }} />
            <Text style={styles.quotaPlan}>
              {quota == null
                ? ''
                : quota.trial
                  ? quota.trial_expired
                    ? 'proefperiode verlopen'
                    : `proefperiode · ${quota.trial_days_remaining ?? 0} ${quota.trial_days_remaining === 1 ? 'dag' : 'dagen'} over`
                  : 'Prakkie Plus · €2,99/mnd'}
            </Text>
          </View>
          {QUOTA_ROWS.map(({ key, label }, i) => {
            const c = quota?.[key];
            return (
              <View key={key} style={[styles.quotaRow, i > 0 && styles.quotaRowBorder]}>
                <Text style={styles.quotaLabel}>{label}</Text>
                <Text style={styles.quotaValue}>
                  {c ? `nog ${Math.max(0, c.limit - c.used)} van ${c.limit}` : '…'}
                </Text>
              </View>
            );
          })}
        </View>

        {/* premium-teaser (Plus-banner) — betalingen zijn bewust uitgeschakeld */}
        <Pressable onPress={() => notice('Premium komt later', 'Alles is nu gratis tijdens de testfase.')}>
          <LinearGradient colors={gradients.plus} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.premiumCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={styles.premiumTitle}>Prakkie Plus</Text>
              <View style={styles.premiumBadge}>
                <Text style={styles.premiumBadgeText}>
                  {quota?.trial === false
                    ? 'JOUW PLAN'
                    : quota?.trial_expired
                      ? 'PROEF VERLOPEN'
                      : `NOG ${quota?.trial_days_remaining ?? 0} ${quota?.trial_days_remaining === 1 ? 'DAG' : 'DAGEN'}`}
                </Text>
              </View>
            </View>
            <Text style={styles.premiumBody}>
              Onbeperkt video-imports, prijsvergelijking over alle ketens, gedeelde groep en voorraad-intelligentie.
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={styles.premiumPill}>
                <Text style={styles.premiumPillText}>€2,99 / maand</Text>
              </View>
            </View>
            <Text style={styles.premiumFootnote}>Je eigen recepten blijven altijd gratis en van jou.</Text>
          </LinearGradient>
        </Pressable>

        {/* uitloggen — sessie blijft anders gewoon bewaard bij het sluiten van de app */}
        <Pressable style={styles.logoutRow} onPress={doLogout} accessibilityRole="button">
          <Text style={styles.logoutText}>Uitloggen</Text>
        </Pressable>

        <View style={styles.gdprRow}>
          <Pressable disabled={busy} onPress={doDeleteAccount}>
            <Text style={[styles.gdprDelete, busy && { opacity: 0.5 }]}>Verwijder account</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* sheets */}
      {sheet !== 'none' ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>{sheet === 'chains' ? 'Mijn supermarkten' : 'Account'}</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          {sheet === 'chains' ? (
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
                    <ChainLogo id={id} size={26} />
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
                  : 'Koppel een e-mailaccount: nodig voor groepen, en je data reist mee naar elk toestel. Je blijft dezelfde gebruiker — niets gaat verloren.'}
              </Text>
              <TextInput
                style={styles.input}
                placeholder="e-mailadres"
                placeholderTextColor={colors.textMuted2}
                autoCapitalize="none"
                keyboardType="email-address"
                value={accEmail}
                onChangeText={setAccEmail}
              />
              <TextInput
                style={styles.input}
                placeholder="wachtwoord (min. 8 tekens)"
                placeholderTextColor={colors.textMuted2}
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
  content: { paddingHorizontal: 20, paddingBottom: 150, gap: 16 },
  profileCard: {
    backgroundColor: colors.surface, borderRadius: radius.card, padding: 18, gap: 14,
    borderWidth: 1, borderColor: colors.borderSubtle, ...shadows.card,
  },
  profileTop: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatarWrap: { position: 'relative' },
  avatar: {
    width: 54, height: 54, borderRadius: 27, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: 54, height: 54 },
  avatarEdit: {
    position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.surface,
  },
  avatarText: { fontFamily: fonts.display, fontSize: 22, color: colors.primary },
  nameInput: { fontSize: 16, fontFamily: fonts.bodySemiBold, color: colors.text, padding: 0 },
  emailText: { fontSize: 12, fontFamily: fonts.body, color: colors.textMuted },
  cardDivider: { height: 1, backgroundColor: 'rgba(34,48,30,0.07)' },
  householdRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  householdLabel: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft, flexShrink: 1 },
  memberChip: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.surface, overflow: 'hidden',
  },
  memberChipImg: { width: 26, height: 26 },
  memberChipText: { fontSize: 11, fontFamily: fonts.bodyBold },
  memberOverlap: { marginLeft: -12 },
  memberAdd: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceMuted, borderWidth: 1.5, borderStyle: 'dashed', borderColor: 'rgba(34,48,30,0.2)',
  },
  inviteStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.badgeBg,
    borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11,
  },
  inviteAccept: {
    backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 13, paddingVertical: 8,
  },
  inviteAcceptText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1,
    borderColor: colors.borderSubtle, ...shadows.card,
  },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, gap: 12,
  },
  settingBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,0.06)' },
  settingLabel: { fontSize: 13.5, fontFamily: fonts.bodyMedium, color: colors.text },
  settingValue: { fontSize: 13, fontFamily: fonts.body, color: colors.textMuted, maxWidth: 170 },
  chainOverlap: { marginLeft: -8 },
  toggle: {
    width: 44, height: 26, borderRadius: 14, backgroundColor: '#D9D4C5',
    justifyContent: 'center', paddingHorizontal: 3,
  },
  toggleOn: { backgroundColor: colors.primary },
  toggleKnob: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: colors.cream, alignSelf: 'flex-start',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  toggleKnobOn: { alignSelf: 'flex-end' },
  quotaCard: {
    backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1,
    borderColor: colors.borderSubtle, paddingHorizontal: 16, paddingVertical: 14, gap: 0,
    ...shadows.card,
  },
  quotaTitle: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.text },
  quotaPlan: { fontSize: 11, fontFamily: fonts.bodySemiBold, color: colors.textMuted },
  quotaRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 9, marginTop: 2,
  },
  quotaRowBorder: { borderTopWidth: 1, borderTopColor: 'rgba(34,48,30,0.06)' },
  quotaLabel: { fontSize: 13, fontFamily: fonts.bodyMedium, color: colors.text },
  quotaValue: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.primary },
  premiumCard: {
    borderRadius: radius.card, borderWidth: 1, borderColor: colors.plusBorder,
    paddingVertical: 16, paddingHorizontal: 18, gap: 10,
  },
  premiumTitle: { fontSize: 14, fontFamily: fonts.bodyBold, color: colors.bonusText },
  premiumBadge: { backgroundColor: colors.bonusText, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  premiumBadgeText: { fontSize: 10, fontFamily: fonts.bodyBold, color: colors.plusBgTo, letterSpacing: 0.6 },
  premiumBody: { fontSize: 11.5, lineHeight: 17, fontFamily: fonts.body, color: colors.plusText },
  premiumPill: { backgroundColor: colors.bonusText, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  premiumPillText: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.plusBgTo },
  premiumFootnote: { fontSize: 10.5, fontFamily: fonts.body, color: colors.plusText, opacity: 0.75 },
  logoutRow: { alignItems: 'center', paddingVertical: 6 },
  logoutText: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.danger },
  gdprRow: { alignItems: 'center', paddingHorizontal: 4, marginTop: 2 },
  gdprDelete: { fontSize: 13.5, color: colors.danger },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: 20, gap: 12,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: {
    backgroundColor: colors.surfaceMuted, borderRadius: radius.control, paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.borderControl, fontSize: 14, color: colors.text,
  },
  sheetBtn: {
    backgroundColor: colors.primary, borderRadius: radius.control, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 12,
  },
  sheetBtnAlt: { backgroundColor: colors.badgeBg },
  sheetBtnText: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  chainRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surfaceMuted,
    borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1.5, borderColor: colors.border,
  },
  chainRowOn: { borderColor: colors.primary, backgroundColor: colors.badgeBg },
});
