import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { CHAIN_BRAND, chainChip } from '../../data/chains';

/**
 * Echte supermarkt-logo's (owner 2026-07-07) i.p.v. gekleurde initialen —
 * overal: boodschappen-groepen, "Waar ga je halen?", profiel, onboarding-tour.
 * Assets: apps/mobile/assets/images/chains/<id>.png (merk-favicons).
 * Metro vereist statische require's; ontbreekt een logo, dan valt het terug
 * op de oude initialen-dot zodat nieuwe ketens nooit crashen.
 */

const LOGOS: Record<string, number> = {
  ah: require('../../../assets/images/chains/ah.png'),
  jumbo: require('../../../assets/images/chains/jumbo.png'),
  plus: require('../../../assets/images/chains/plus.png'),
  dirk: require('../../../assets/images/chains/dirk.png'),
  dekamarkt: require('../../../assets/images/chains/dekamarkt.png'),
  aldi: require('../../../assets/images/chains/aldi.png'),
  vomar: require('../../../assets/images/chains/vomar.png'),
  hoogvliet: require('../../../assets/images/chains/hoogvliet.png'),
  spar: require('../../../assets/images/chains/spar.png'),
  // let op: écht een jpg — AAPT (Android) weigert een jpg met .png-extensie
  picnic: require('../../../assets/images/chains/picnic.jpg'),
  ekoplaza: require('../../../assets/images/chains/ekoplaza.png'),
};

export function ChainLogo({ id, size = 18 }: { id: string; size?: number }) {
  const logo = LOGOS[id];
  if (!logo) {
    const brand = CHAIN_BRAND[id] ?? { bg: '#75816F', fg: '#FFFFFF' };
    return (
      <View style={[styles.dot, { backgroundColor: brand.bg, width: size, height: size, borderRadius: size / 2 }]}>
        <Text style={[styles.dotText, { color: brand.fg, fontSize: size < 20 ? 7 : 8 }]}>{chainChip(id)}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.wrap, { width: size, height: size, borderRadius: size / 2, padding: Math.max(1, size * 0.08) }]}>
      <Image source={logo} style={{ flex: 1, width: '100%' }} contentFit="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(34,48,30,.10)',
    overflow: 'hidden',
  },
  dot: { alignItems: 'center', justifyContent: 'center' },
  dotText: { fontFamily: 'InstrumentSans_700Bold' },
});
