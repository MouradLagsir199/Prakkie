/**
 * Prakkie design tokens — source of truth: REDESIGN/project/Premium Tabs
 * Redesign.dc.html (Claude Design handoff, 2026-07). Do not invent new values;
 * new screens must reuse these tokens.
 */

export const colors = {
  /** Primary actions, active tab, FAB, price-badge text, selected chips. */
  primary: '#2A5F38',
  /** Light end of the primary gradient (≈ color-mix 82% primary / 18% white). */
  primaryBright: '#4F7C5C',
  /** App background — neutral near-white (owner-mockup 2026-07-14: white pages,
   *  white cards, alleen een dun randje — geen warme cream meer). */
  bg: '#FAFAFA',
  /** Cards, search bar. */
  surface: '#FFFFFF',
  /** Control fills ÓP een witte kaart (steppers, pills, invoervelden, thumbs) —
   *  het lichtgrijs uit de mockup; colors.bg is daarvoor te wit geworden. */
  surfaceMuted: '#F2F3F2',
  /** Tab-bar glass and text/icons on green — off-white cream. */
  cream: '#FDFBF6',
  /** Text/icons on green. */
  onPrimary: '#FDFBF6',
  /** Body text — near-black on cream. */
  text: '#22301E',
  /** Secondary text tiers. */
  textMuted: '#75816F',
  textMuted2: '#97A08F',
  textInactive: '#9AA593',
  /** Strike-through / disabled prices. */
  textDisabled: '#B9C0B2',
  /** Out-of-month calendar days. */
  textFaint: '#C6CBBE',
  /** Chip labels. */
  textSoft: '#4A5745',
  /** Price-per-portion pill background — pale green. */
  badgeBg: '#E9F1E3',
  /** Active tab pill in the floating bar. */
  tabPill: '#E7F0E2',
  /** "Bonus-tip" / promo badges — warm yellow. */
  bonus: '#F6C445',
  bonusText: '#3A2E10',
  /** Favorite heart. */
  heart: '#D64545',
  /** Card edges (owner 2026-07-14: "een heel dun randje voor de cards") — a
   *  clearly visible thin line rather than the near-invisible 0.08 it used to
   *  be, replacing a heavier shadow as the card's main definition. */
  borderSubtle: 'rgba(34,48,30,0.14)',
  /** Controls (chips, steppers, inputs). */
  borderControl: 'rgba(34,48,30,0.11)',
  /** aliases used by data-driven screens */
  border: 'rgba(34,48,30,0.10)',
  danger: '#B3261E',
  /** Dark glass summary bar (Boodschappen totals). */
  darkGlass: 'rgba(26,36,23,0.92)',
  /** Prakkie Plus banner. */
  plusBgFrom: '#FBF3DC',
  plusBgTo: '#F7E9C4',
  plusBorder: 'rgba(138,90,30,0.16)',
  plusText: '#8A5A1E',
  /** AI-tegoed (maandquotums prakkie/import/aanvullen/genereren) — fel geel
   *  zodat de teller nergens te missen is (owner 2026-07-10); donkerbruine
   *  tekst voor contrast. Overal waar een AI-actie tegoed kost: deze kleuren. */
  quota: '#5C420C',
  quotaBg: '#F9D65C',
  quotaBorder: 'rgba(138,90,30,0.35)',
  /** Bonus-flag in de schap-bladeraar — oranje, met de bonus-mechanic erin. */
  bonusFlag: '#E07B2A',
  onBonusFlag: '#FFFFFF',
} as const;

/** Gradient pairs for expo-linear-gradient — CTA buttons and the FAB. */
export const gradients = {
  /** linear-gradient(170deg, mix(primary 82%, white), primary) */
  primary: [colors.primaryBright, colors.primary] as [string, string],
  plus: [colors.plusBgFrom, colors.plusBgTo] as [string, string],
} as const;

export const radius = {
  card: 20,
  /** List cards (ingredient/product rows). */
  listCard: 17,
  control: 15,
  cta: 17,
  pill: 999,
  tabBar: 36,
  sheet: 26,
  md: 12,
  lg: 16,
} as const;

export const shadows = {
  /** owner 2026-07-14: "voor de kaders gewoon een heel dun randje" — the thin
   *  border (colors.borderSubtle) now defines the card edge; this shadow is
   *  just a faint lift, not the near-drop-shadow it used to be. */
  card: {
    shadowColor: '#1E2B1B',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  float: {
    shadowColor: '#1E2B1B',
    shadowOpacity: 0.24,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  fab: {
    shadowColor: '#2A5F38',
    shadowOpacity: 0.45,
    shadowRadius: 13,
    shadowOffset: { width: 0, height: 6 },
    elevation: 9,
  },
  cta: {
    shadowColor: '#2A5F38',
    shadowOpacity: 0.38,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 7 },
    elevation: 8,
  },
} as const;

/**
 * Typography — display = Young Serif (~31px screen titles, line-height 1.05);
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
  screenTitle: { fontFamily: fonts.display, fontSize: 31, lineHeight: 34, color: colors.text },
  greeting: { fontFamily: fonts.bodyMedium, fontSize: 12.5, color: colors.textMuted },
  cardTitle: { fontFamily: fonts.bodySemiBold, fontSize: 13.5, lineHeight: 18, color: colors.text },
  meta: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted },
  badge: { fontFamily: fonts.bodyBold, fontSize: 10.5 },
  /** Section labels — "INGREDIËNTEN", "LUNCH" (uppercase, letter-spaced). */
  sectionLabel: {
    fontFamily: fonts.bodyBold,
    fontSize: 10.5,
    letterSpacing: 0.6,
    color: colors.textMuted2,
    textTransform: 'uppercase' as const,
  },
  tabLabelActive: { fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.primary },
  tabLabelInactive: { fontFamily: fonts.bodyMedium, fontSize: 10, color: colors.textInactive },
  chip: { fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.textSoft },
  /** aliases for content screens (detail/cook/list) */
  h1: { fontFamily: fonts.display, fontSize: 27, lineHeight: 31, color: colors.text },
  h2: { fontFamily: fonts.bodySemiBold, fontSize: 17, color: colors.text },
  h3: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.text },
} as const;

/** Icon defaults — Lucide-style stroke icons. */
export const icons = {
  tabSize: 21,
  strokeWidth: 1.9,
  strokeWidthActive: 2.1,
} as const;
