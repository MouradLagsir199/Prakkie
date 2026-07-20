import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../../theme/tokens';

interface GoogleCredentialResponse {
  credential?: string;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(input: { client_id: string; callback: (response: GoogleCredentialResponse) => void }): void;
          renderButton(element: HTMLElement, options: Record<string, unknown>): void;
        };
      };
    };
  }
}

let googleScript: Promise<void> | null = null;

function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts.id) return Promise.resolve();
  googleScript ??= new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-prakkie-google-identity]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google-login kon niet laden')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.dataset.prakkieGoogleIdentity = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google-login kon niet laden'));
    document.head.appendChild(script);
  });
  return googleScript;
}

export function GoogleWebButton(props: {
  disabled?: boolean;
  onCredential: (idToken: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const callback = useRef(props.onCredential);
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  const [failed, setFailed] = useState(!clientId);

  useEffect(() => {
    callback.current = props.onCredential;
  }, [props.onCredential]);

  useEffect(() => {
    if (!clientId) return;
    let active = true;
    loadGoogleIdentity()
      .then(() => {
        if (!active || !host.current || !window.google) return;
        host.current.replaceChildren();
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response.credential) callback.current(response.credential);
          },
        });
        window.google.accounts.id.renderButton(host.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: Math.max(240, Math.floor(host.current.getBoundingClientRect().width)),
          locale: 'nl',
        });
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [clientId]);

  if (failed) return <Text style={styles.error}>Google-login is tijdelijk niet beschikbaar.</Text>;
  return (
    <View style={[styles.wrapper, props.disabled && styles.disabled]} pointerEvents={props.disabled ? 'none' : 'auto'}>
      <div ref={host} style={{ width: '100%', minHeight: 44, display: 'flex', justifyContent: 'center' }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { width: '100%', minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.6 },
  error: { color: colors.textSoft, fontFamily: fonts.body, fontSize: 12, textAlign: 'center' },
});
