import { useRouter } from 'expo-router';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GoogleWebButton } from '../components/auth/GoogleWebButton';
import { CTAButton } from '../components/prakkie/CTAButton';
import { syncNow } from '../data';
import { login, loginWithApple, loginWithGoogle, register } from '../data/api';
import { kv } from '../data/kv';
import { notice } from '../lib/dialogs';
import { colors, fonts, radius, shadows, type } from '../theme/tokens';

/**
 * Inlogscherm (owner 2026-07-07): eerste start én na uitloggen. Registreren
 * start de onboarding-tour (prakkie.tour_pending); inloggen niet — die user
 * kent de app al. Eenmaal ingelogd blijf je ingelogd (SecureStore-tokens
 * overleven het sluiten van de app) tot je expliciet uitlogt op Profiel.
 */
export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(Platform.OS === 'ios');
  const [otherOptionsOpen, setOtherOptionsOpen] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
        scopes: ['openid', 'email', 'profile'],
      });
    }
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync()
        .then(setAppleAvailable)
        .catch(() => setAppleAvailable(false));
    }
  }, []);

  async function finishProviderLogin() {
    await kv.setItem('prakkie.authed', '1').catch(() => {});
    await kv.setItem('prakkie.onboarded', '1').catch(() => {});
    syncNow().catch(() => {});
    router.replace('/');
  }

  async function signInWithGoogle() {
    if (Platform.OS === 'web') return;
    setGoogleBusy(true);
    try {
      if (Platform.OS === 'android') {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      }
      const result = await GoogleSignin.signIn();
      if (result.type !== 'success' || !result.data.idToken) return;
      await loginWithGoogle(result.data.idToken, result.data.user.name ?? undefined);
      await finishProviderLogin();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === statusCodes.SIGN_IN_CANCELLED) return;
      notice('Google-login mislukt', e instanceof Error ? e.message : 'Probeer het opnieuw.');
    } finally {
      setGoogleBusy(false);
    }
  }

  async function finishGoogleWebLogin(idToken: string) {
    if (busy || googleBusy || appleBusy) return;
    setGoogleBusy(true);
    try {
      await loginWithGoogle(idToken);
      await finishProviderLogin();
    } catch (e) {
      notice('Google-login mislukt', e instanceof Error ? e.message : 'Probeer het opnieuw.');
    } finally {
      setGoogleBusy(false);
    }
  }

  async function signInWithApple() {
    if (busy || googleBusy || appleBusy) return;
    setAppleBusy(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) throw new Error('Apple gaf geen geldig identiteitstoken terug.');
      const fullName = credential.fullName
        ? [credential.fullName.givenName, credential.fullName.middleName, credential.fullName.familyName]
            .filter((part): part is string => !!part?.trim())
            .join(' ')
        : undefined;
      await loginWithApple(credential.identityToken, fullName || undefined);
      await finishProviderLogin();
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      notice('Apple-login mislukt', e instanceof Error ? e.message : 'Probeer het opnieuw.');
    } finally {
      setAppleBusy(false);
    }
  }

  async function submit() {
    const em = email.trim().toLowerCase();
    if (!em || password.length < 8) {
      notice('Check je invoer', 'E-mail + wachtwoord van minimaal 8 tekens.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        await register(em, password, name.trim() || undefined);
        // nieuwe gebruiker → rondleiding; tour_done van een vórige gebruiker
        // op dit toestel mag die niet blokkeren
        await kv.removeItem('prakkie.tour_done').catch(() => {});
        await kv.setItem('prakkie.tour_pending', '1').catch(() => {});
      } else {
        await login(em, password);
      }
      await kv.setItem('prakkie.authed', '1').catch(() => {});
      await kv.setItem('prakkie.onboarded', '1').catch(() => {});
      syncNow().catch(() => {});
      router.replace('/');
    } catch (e) {
      notice('Niet gelukt', e instanceof Error ? e.message : 'Probeer het opnieuw.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ gap: 6 }}>
        <Text style={styles.brand}>Prakkie</Text>
        <Text style={type.meta}>
          Recepten van social media & Nederlandse sites, weekplanning en de voordeligste boodschappenlijst.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.modeRow}>
          {(['login', 'register'] as const).map((m) => (
            <Pressable key={m} onPress={() => setMode(m)} style={[styles.modeBtn, mode === m && styles.modeBtnOn]}>
              <Text style={[styles.modeText, mode === m && { color: colors.onPrimary }]}>
                {m === 'login' ? 'Inloggen' : 'Account maken'}
              </Text>
            </Pressable>
          ))}
        </View>

        {mode === 'register' ? (
          <TextInput
            style={styles.input}
            placeholder="Je naam (optioneel)"
            placeholderTextColor={colors.textMuted2}
            value={name}
            onChangeText={setName}
          />
        ) : null}
        <TextInput
          style={styles.input}
          placeholder="e-mailadres"
          placeholderTextColor={colors.textMuted2}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="wachtwoord (min. 8 tekens)"
          placeholderTextColor={colors.textMuted2}
          secureTextEntry
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />

        <CTAButton
          label={busy ? 'Even geduld…' : mode === 'register' ? 'Maak account & start' : 'Inloggen'}
          onPress={submit}
          disabled={busy}
          style={{ marginTop: 4 }}
        />

        {Platform.OS === 'ios' && appleAvailable ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={12}
            style={[styles.appleButton, (busy || googleBusy || appleBusy) && { opacity: 0.65 }]}
            onPress={() => void signInWithApple()}
          />
        ) : Platform.OS === 'web' ? (
          <GoogleWebButton
            disabled={busy || googleBusy || appleBusy}
            onCredential={(idToken) => void finishGoogleWebLogin(idToken)}
          />
        ) : (
          <Pressable
            onPress={() => void signInWithGoogle()}
            disabled={busy || googleBusy || appleBusy}
            style={styles.googleButton}
            accessibilityRole="button"
            accessibilityLabel="Inloggen met Google"
          >
            <Text style={styles.googleButtonText}>{googleBusy ? 'Google-login…' : 'Doorgaan met Google'}</Text>
          </Pressable>
        )}

        {Platform.OS === 'ios' ? (
          <Pressable
            onPress={() => setOtherOptionsOpen((open) => !open)}
            style={styles.otherOptionsButton}
            accessibilityRole="button"
            accessibilityState={{ expanded: otherOptionsOpen }}
          >
            <Text style={styles.otherOptionsText}>{otherOptionsOpen ? 'Minder opties' : 'Andere inlogopties'}</Text>
          </Pressable>
        ) : null}

        {otherOptionsOpen && Platform.OS === 'ios' ? (
          <Pressable
            onPress={() => void signInWithGoogle()}
            disabled={busy || googleBusy || appleBusy}
            style={styles.googleButton}
            accessibilityRole="button"
            accessibilityLabel="Inloggen met Google"
          >
            <Text style={styles.googleButtonText}>{googleBusy ? 'Google-login…' : 'Doorgaan met Google'}</Text>
          </Pressable>
        ) : null}

        <Pressable onPress={() => setMode(mode === 'login' ? 'register' : 'login')}>
          <Text style={styles.switchText}>
            {mode === 'login' ? 'Nieuw hier? Maak een account →' : 'Al een account? Log in →'}
          </Text>
        </Pressable>
      </View>

      <Text style={[type.meta, { textAlign: 'center' }]}>
        Je blijft ingelogd tot je zelf uitlogt — ook na het sluiten van de app.
      </Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 24, justifyContent: 'space-between' },
  brand: { fontFamily: fonts.display, fontSize: 40, lineHeight: 46, color: colors.primary },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.card, padding: 18, gap: 10,
    borderWidth: 1, borderColor: colors.borderSubtle,
    ...shadows.card,
  },
  modeRow: {
    flexDirection: 'row', backgroundColor: colors.surfaceMuted, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderControl, padding: 3, gap: 3, marginBottom: 4,
  },
  modeBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.pill },
  modeBtnOn: { backgroundColor: colors.primary },
  modeText: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  input: {
    backgroundColor: colors.surfaceMuted, borderRadius: radius.control, paddingHorizontal: 14, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.borderControl, fontSize: 13.5, color: colors.text,
  },
  googleButton: {
    minHeight: 44, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.borderControl, backgroundColor: colors.surface,
  },
  googleButtonText: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  appleButton: { width: '100%', height: 44 },
  otherOptionsButton: { alignItems: 'center', justifyContent: 'center', paddingVertical: 5 },
  otherOptionsText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  switchText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.primary, textAlign: 'center', paddingVertical: 6 },
});
