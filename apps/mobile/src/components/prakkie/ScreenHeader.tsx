import { Image } from 'expo-image';
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
  avatarUrl,
  contextLine,
  onAvatarPress,
}: {
  title: string;
  greetingName?: string;
  avatarInitial?: string;
  /** profielfoto (owner 2026-07-07): gaat vóór de initiaal als die er is */
  avatarUrl?: string | null;
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
      {avatarInitial || avatarUrl ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Instellingen"
          onPress={onAvatarPress}
          disabled={!onAvatarPress}
          style={styles.avatar}
        >
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatarImg} contentFit="cover" />
          ) : (
            <Text style={styles.avatarText}>{avatarInitial}</Text>
          )}
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
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.badgeBg,
    borderWidth: 1,
    borderColor: 'rgba(42,95,56,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: {
    width: 42,
    height: 42,
  },
  avatarText: {
    fontFamily: 'InstrumentSans_700Bold',
    fontSize: 15,
    color: colors.primary,
  },
});
