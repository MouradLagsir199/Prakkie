/**
 * Prakkie design tokens — extracted verbatim from the 7 approved mockups.
 * Source of truth: docs/04_design_guardrails.md §1. Do not invent new values;
 * new screens must reuse these tokens.
 */

export const colors = {
  /** Primary actions, active tab, FAB, price-badge text, selected chips. */
  primary: '#2E6B3E',
  /** App background — warm cream. */
  bg: '#FAF7F0',
  /** Cards, search bar, tab bar. */
  surface: '#FFFFFF',
  /** Text/icons on green. */
  onPrimary: '#FDFBF6',
  /** Body text — near-black on cream. */
  text: '#22301E',
  /** Secondary text tiers. */
  textMuted: '#75816F',
  textMuted2: '#97A08F',
  textInactive: '#9AA593',
  /** Chip labels. */
  textSoft: '#4A5745',
  /** Price-per-portion pill background — pale green. */
  badgeBg: '#EAF1E5',
  /** "Bonus-tip" / promo badges — warm yellow. */
  bonus: '#F6C445',
  bonusText: '#3A2E10',
  borderSubtle: 'rgba(34,48,30,0.10)',
} as const;

export const radius = {
  card: 18,
  control: 14,
  pill: 999,
  tabBar: 32,
} as const;

export const shadows = {
  card: {
    shadowColor: 'rgba(34,48,30,1)',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  float: {
    shadowColor: 'rgba(34,48,30,1)',
    shadowOpacity: 0.16,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  fab: {
    shadowColor: '#2E6B3E',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;

/**
 * Typography — display = Young Serif (~29px screen titles, line-height 1.1);
 * body/UI = Instrument Sans 400–700.
 */
export const fonts = {
  display: 'YoungSerif_400Regular',
  body: 'InstrumentSans_400Regular',
  bodyMedium: 'InstrumentSans_500Medium',
  bodySemiBold: 'InstrumentSans_600SemiBold',
  bodyBold: 'InstrumentSans_700Bold',
} as const;

export const type = {
  screenTitle: { fontFamily: fonts.display, fontSize: 29, lineHeight: 32, color: colors.text },
  greeting: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.textMuted },
  cardTitle: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.text },
  meta: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted },
  badge: { fontFamily: fonts.bodyBold, fontSize: 11 },
  tabLabelActive: { fontFamily: fonts.bodyBold, fontSize: 10, color: colors.primary },
  tabLabelInactive: { fontFamily: fonts.bodyMedium, fontSize: 10, color: colors.textInactive },
  chip: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.textSoft },
} as const;

/** Icon defaults — Lucide-style stroke icons (docs/04 §1). */
export const icons = {
  tabSize: 22,
  strokeWidth: 1.9,
} as const;
