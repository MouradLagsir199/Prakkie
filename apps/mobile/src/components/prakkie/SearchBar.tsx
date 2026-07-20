import { Search } from 'lucide-react-native';
import { StyleSheet, TextInput, View } from 'react-native';
import { colors, radius } from '../../theme/tokens';

export function SearchBar({
  placeholder,
  value,
  onChangeText,
}: {
  placeholder: string;
  value?: string;
  onChangeText?: (text: string) => void;
}) {
  return (
    <View style={styles.wrap}>
      <Search size={16} strokeWidth={2.1} color={colors.textMuted2} />
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted2}
        value={value}
        onChangeText={onChangeText}
        autoCorrect={false}
        accessibilityLabel={placeholder}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // owner-mockup 2026-07-14: lichtgrijs gevulde zoekbalk op de witte pagina
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg,
    paddingHorizontal: 15,
    height: 48,
  },
  input: {
    flex: 1,
    fontFamily: 'InstrumentSans_400Regular',
    fontSize: 13.5,
    color: colors.text,
    paddingVertical: 0,
  },
});
