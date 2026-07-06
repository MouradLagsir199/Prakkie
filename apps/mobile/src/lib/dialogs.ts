import { Alert, Platform } from 'react-native';

/**
 * Cross-platform dialogs. RN's Alert.alert is a SILENT NO-OP on
 * react-native-web — buttons never render, confirm callbacks never fire, so
 * "Lijst verwijderen?" deed op web letterlijk niets. Web krijgt daarom
 * window.confirm/alert: kaal maar eerlijk.
 */

const webGlobals = () =>
  globalThis as unknown as { confirm?: (message: string) => boolean; alert?: (message: string) => void };

export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
}): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(webGlobals().confirm?.(`${opts.title}\n\n${opts.message}`) ?? false);
  }
  return new Promise((resolve) => {
    Alert.alert(
      opts.title,
      opts.message,
      [
        { text: 'Annuleer', style: 'cancel', onPress: () => resolve(false) },
        { text: opts.confirmLabel, style: opts.destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

/** One-button feedback ("Ingepland", "Import mislukt") — also visible on web. */
export function notice(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    webGlobals().alert?.(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
