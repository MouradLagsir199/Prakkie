import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, type } from '../../theme/tokens';

function greetingNow(): string {
  const h = new Date().getHours();
  if (h < 6) return 'Goedenacht';
  if (h < 12) return 'Goedemorgen';
  if (h < 18) return 'Goedemiddag';
  return 'Goedenavond';
}

/**
 * Header pattern from docs/04 §2: muted greeting line above a Young Serif
 * title, 40px round green avatar with initial on the right.
 */
export function ScreenHeader({
  title,
  greetingName,
  avatarInitial,
  contextLine,
  onAvatarPress,
}: {
  title: string;
  greetingName?: string;
  avatarInitial?: string;
  contextLine?: string;
  /** UX-audit C3: avatar is the entrance to /instellingen. */
  onAvatarPress?: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.textCol}>
        {greetingName ? (
          <Text style={type.greeting}>
            {greetingNow()}, {greetingName}
          </Text>
        ) : null}
        <Text style={type.screenTitle}>{title}</Text>
        {contextLine ? <Text style={[type.meta, styles.context]}>{contextLine}</Text> : null}
      </View>
      {avatarInitial ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Instellingen"
          onPress={onAvatarPress}
          disabled={!onAvatarPress}
          style={styles.avatar}
        >
          <Text style={styles.avatarText}>{avatarInitial}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  textCol: {
    gap: 3,
    flexShrink: 1,
  },
  context: {
    marginTop: 2,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: 'InstrumentSans_700Bold',
    fontSize: 16,
    color: colors.onPrimary,
  },
});
