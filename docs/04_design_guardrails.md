# Prakkie — Design guardrails (extracted from the 7 approved tab mockups)

> **Purpose:** the UX contract for Fable 5. These tokens, patterns and screens were extracted directly from the approved HTML mockups (`01_Recepten_bibliotheek` … `07_Prijzen_vergelijking`). New screens must reuse these tokens; the seven screens below must be built as designed.

---

## 1. Brand & design tokens

| Token | Value | Usage |
|---|---|---|
| `--color-primary` | `#2E6B3E` (deep green) | Primary actions, active tab, FAB, price badges text, selected chips |
| `--color-bg` | `#FAF7F0` (warm cream) | App background |
| `--color-surface` | `#FFFFFF` | Cards, search bar, tab bar |
| `--color-on-primary` | `#FDFBF6` | Text/icons on green |
| `--color-text` | near-black on cream | Body text |
| `--color-text-muted` | `#75816F` / `#97A08F` / `#9AA593` | Secondary text, placeholders, inactive tabs |
| `--color-text-soft` | `#4A5745` | Chip labels |
| `--color-badge-bg` | `#EAF1E5` (pale green) | Price-per-portion pill background |
| `--color-bonus` | `#F6C445` (warm yellow), text `#3A2E10` | "Bonus-tip" / promo badges |
| `--border-subtle` | `rgba(34,48,30,.08–.12)` 1px | Card and control borders |
| `--shadow-card` | `0 2px 8px rgba(34,48,30,.05)` | Recipe cards |
| `--shadow-float` | `0 14px 32px rgba(34,48,30,.16)` | Tab bar; FAB: `0 8px 18px rgba(46,107,62,.4)` |
| Radius — cards | 18px | Recipe/product cards |
| Radius — controls | 14px | Search bar, inputs |
| Radius — pills/chips | 999px | Chips, badges, tab bar container (32px) |

### Typography
- **Display / screen titles:** `Young Serif`, ~29px, line-height 1.1 (e.g. "Mijn recepten", "Weekplanner").
- **Body / UI:** `Instrument Sans` (400–700). Card titles 14px/600; meta 11.5–13px; badges 11px/700; tab labels 10px (700 active / 500 inactive).
- Dutch number formatting throughout: `€ 1,85 p.p.`, comma decimals, `t/m`, day abbreviations MA/DI/WO/DO/VR/ZA/ZO.

### Iconography
Stroke icons (Lucide-style), 22px in tab bar, 1.9px stroke, round caps.

## 2. App shell

- **Bottom tab bar:** floating pill (radius 32, white @ 94% opacity, subtle border + float shadow), 4 tabs + centre FAB:
  `Recepten` (book icon) · `Plannen` (calendar) · **[+ FAB]** 56×56 green circle → opens Import sheet · `Lijst` (checklist) · `Prijzen` (tag).
  Active tab: green icon + bold green label. Inactive: `#9AA593`.
- **Header pattern:** small muted greeting/context line ("Goedemiddag, Mourad") above a Young Serif title, with a 40px round avatar (green, initial) on the right.
- Background gradient fade behind the tab bar: `linear-gradient(rgba(250,247,240,0), #FAF7F0 55%)`.

## 3. Screen inventory (the seven contracts)

### 01 · Recepten — bibliotheek (home)
- Header (greeting + "Mijn recepten" + avatar).
- Search bar: "Zoek op titel of ingrediënt…".
- Horizontally scrolling collection chips; active chip green with count ("Alles · 23").
- Result meta row: "23 recepten" + sort control "Nieuwste eerst ⌄".
- 2-column recipe card grid; each card: photo (118px), title, cook time, price pill "€ 1,85 p.p."; optional yellow "Bonus-tip" badge overlaid top-left on photo.

### 02 · Recepten — filter op ingrediënt
- Search context with selected-ingredient chips (e.g. `courgette`, `kip`, removable).
- Toggle: "Filter op ingrediënt — recepten met **alle** gekozen ingrediënten" (alle/één van).
- Result count: "3 recepten met courgette + kip".
- Sort sheet options (exact list): Nieuwste eerst · Oudste eerst · Alfabetisch A–Z · Laatst gekookt · Bereidingstijd.
- Result rows: photo thumb, title, time, price pill, ingredient summary line ("courgette · kip · kokosmelk · rijst").

### 03 · Import — sheet (opens from FAB)
- Title "Recept importeren".
- Smart clipboard card: "Link op je klembord gevonden" + source preview ("instagram.com/reel/… · @lekkersimpelnl") + primary CTA "Importeer deze reel" + reassurance line "Video-import: gesproken én in beeld getoonde ingrediënten worden herkend".
- Divider "of kies zelf" → four options: **Plak een link · Foto of scan · Tekst plakken · Handmatig**.
- Footer education: "Sneller: deel rechtstreeks vanuit Instagram of TikTok via **Deel → Prakkie**. Eén tik, klaar."

### 04 · Import — controleer recept (review-before-save)
- Nav: "Annuleer" left, title "Controleer recept".
- Success banner: "Video geïmporteerd in 12 s — audio, tekst in beeld en caption gecombineerd".
- Video still + title + provenance: "Reel · @lekkersimpelnl · bron blijft bewaard".
- Meta chips: "2 personen · 10 min voorbereiden · 15 min koken".
- Section "INGREDIËNTEN · 8": editable rows `item — qty unit`; low-confidence row pattern: "feta — **100 g?** · controleer" with explanation "Gehoord in video: *'flink wat feta'* — hoeveelheid geschat"; vague amounts allowed ("verse koriander — naar smaak").
- Section "Bereiding · 5 stappen" with state "Alles herkend".
- Primary CTA: **Bewaar in Mijn recepten**.

### 05 · Plannen — weekplanner
- Title "Weekplanner", week switcher "Week 28", context "6 – 12 juli · 5 gerechten gepland · sjabloon: 'Standaard week'".
- Day rows MA–ZO; filled rows: recipe title + "4 pers · € 2,10 p.p." (+ inline Bonus context: "· feta in de Bonus"); empty rows: drop target "Sleep een recept hierheen".
- "Zonder datum" parking strip: "· deze week nog inplannen" with undated recipes (e.g. Bloemkoolcurry).
- Bottom CTA: **Boodschappenlijst maken · 6 gerechten**.

### 06 · Lijst — boodschappen
- List tabs: "Weekboodschappen" (active) · "Feestje za" · "+ Nieuw".
- Context row: layout chip "AH-indeling" + "23 items · 6 afgevinkt · gesynct met Sanne · live gekoppeld aan weekplan".
- Aisle sections (uppercase headers): GROENTE & FRUIT → ZUIVEL & EIEREN → VLEES & VIS → …
- Line item anatomy: name + qty ("Courgette · 2 st"), matched product subline ("AH courgette per stuk"), price right-aligned ("€ 1,38"). Variants:
  - merge provenance: "Rode ui · 3 st — 2 recepten — samengevoegd: shakshuka (1) + nasi (2)";
  - Bonus: "Feta · 200 g — Bonus 25% — AH witte kaasblokjes 200 g · 2 recepten — ~~€ 2,49~~ € 1,87";
  - huismerk hint: "huismerk-tip: € 0,80 goedkoper dan A-merk";
  - pack-fit: "Kipdijfilet · 600 g — 2 × 300 g · restje van 0 g — pakt precies".
- Sticky footer: "Totaal bij AH **€ 47,80**" + teaser "€ 4,20 goedkoper bij Jumbo" (links to Prijzen tab).

### 07 · Prijzen — vergelijking
- Title "Prijzen & Bonus", context "Weekboodschappen · 23 items · prijzen van vandaag" (make date dynamic/staleness-aware).
- "Jouw mandje per supermarkt": ranked chain rows with 2-letter logo chips (JU/LI/AH/PL), cheapest tagged "voordeligst", user's store tagged "jouw winkel", coverage gaps flagged ("Lidl — 2 items niet in assortiment"), totals right-aligned (€ 43,60 / € 44,95 / € 47,80 / € 49,10).
- Insight card "Deze week": "€ 4,20 goedkoper bij Jumbo — vooral door kip en olijfolie" (always name the driving items).
- "Van jouw lijst in de aanbieding" (filter chips "Alles · 6"): deal rows with chain chip, product + pack, mechanic ("Bonus t/m zondag", "1 + 1 gratis", "25% korting"), old→new price.
- "Koken met aanbiedingen · 3 recepten uit je bibliotheek leunen op deals van deze week" — recipe suggestions driven by current deals.

## 4. New screen — Recepten › Ontdek (discovery feed, Module N)

Not part of the seven approved mockups; to be designed **strictly from the existing tokens**:
- Segment control at the top of the Recepten tab: **Mijn recepten / Ontdek** (pill style, active = green like collection chips).
- Reuses the mockup-01 2-column card grid one-for-one (photo, title, time, "€ x,xx p.p." pill, yellow Bonus-tip badge when deal-driven).
- One addition per card: a muted source attribution line ("via Leukerecepten") in `--color-text-muted`, 11px.
- Optional top strip: "Koken met aanbiedingen" rail (horizontal cards) mirroring the mockup-07 section of the same name.
- Detail view = existing recipe detail with a prominent "Bekijk op {site}" link-out and a primary CTA "Bewaar in Mijn recepten" (same CTA style as mockup 04).
- Owner sign-off required on this screen before build.

## 5. Voice & tone (from the mockups)

- Dutch, warm, plain, never salesy: "Eén tik, klaar.", "bron blijft bewaard", "pakt precies".
- Honesty is a design feature: uncertainty is shown ("100 g? · controleer"), gaps are admitted ("niet in assortiment"), savings are explained (named driver items). Never fake precision.
- Money always as savings framing from the user's side ("€ 4,20 goedkoper bij Jumbo"), never as chain advertising.
