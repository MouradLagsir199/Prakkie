/**
 * E1 — ingredient normaliser (plan/05 WS2). Raw recipe line → structured
 * {quantity, unit, item, note}. Handles NL+EN units (el/tl/snufje/teentje…),
 * unicode + ascii fractions, ranges ("2-3 el", "2 à 3"), "naar smaak",
 * parenthesised and comma-trailing prep notes. The item text stays human
 * (lowercased, accent-folded) — plural/synonym mapping is the lexicon's job.
 */

export interface NormalisedIngredient {
  raw: string;
  /** midpoint for ranges; null for "naar smaak"/uncounted */
  quantity: number | null;
  quantityMax?: number | null;
  unit: string | null;
  item: string;
  note: string | null;
  toTaste: boolean;
}

const FRACTIONS: Record<string, number> = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅕': 0.2, '⅛': 0.125,
};

// unit variants → canonical unit
const UNITS: [RegExp, string][] = [
  [/^(kg|kilo|kilogram)$/i, 'kg'],
  [/^(g|gr|gram|grams)$/i, 'g'],
  [/^(mg)$/i, 'mg'],
  [/^(l|liter|litre|liters)$/i, 'l'],
  [/^(dl|deciliter)$/i, 'dl'],
  [/^(cl|centiliter)$/i, 'cl'],
  [/^(ml|milliliter|millilitre)$/i, 'ml'],
  [/^(el|eetlepels?|eetl\.?|tbsp|tablespoons?)$/i, 'el'],
  [/^(tl|theelepels?|theel\.?|tsp|teaspoons?)$/i, 'tl'],
  [/^(kopjes?|koppen?|cups?)$/i, 'kopje'],
  [/^(snufjes?|snuf|mespuntjes?|mespunt|pinch)$/i, 'snufje'],
  [/^(teentjes?|tenen|teen|cloves?)$/i, 'teentje'],
  [/^(stuks?|stuk|st\.?|pieces?|x)$/i, 'stuks'],
  [/^(plakjes?|plakken|plak|slices?)$/i, 'plakje'],
  [/^(blikjes?|blikken|blik|cans?|tins?)$/i, 'blik'],
  [/^(potjes?|potten|pot|jars?)$/i, 'pot'],
  [/^(zakjes?|zakken|zak|sachets?|bags?)$/i, 'zakje'],
  [/^(bosjes?|bossen|bos|bunch(es)?)$/i, 'bosje'],
  [/^(takjes?|takken|tak|sprigs?)$/i, 'takje'],
  [/^(blaadjes?|bladeren|blad|leaves|leaf)$/i, 'blaadje'],
  [/^(handjes?|handvol|handful)$/i, 'handje'],
  [/^(scheutjes?|scheuten|scheut|dash(es)?|splash(es)?)$/i, 'scheutje'],
  [/^(pakjes?|pakken|pak|packs?|packages?)$/i, 'pak'],
  [/^(flesjes?|flessen|fles|bottles?)$/i, 'fles'],
];

const TO_TASTE = /\b(naar smaak|naar wens|to taste|eventueel|optioneel|optional)\b/i;

export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(token: string): number | null {
  const t = token.trim();
  if (t in FRACTIONS) return FRACTIONS[t]!;
  // "1½" / "1 ½"
  const uniMix = t.match(/^(\d+)\s*([½⅓⅔¼¾⅕⅛])$/);
  if (uniMix) return parseInt(uniMix[1]!, 10) + FRACTIONS[uniMix[2]!]!;
  // "1 1/2" or "1/2"
  const mixed = t.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return (mixed[1] ? parseInt(mixed[1], 10) : 0) + parseInt(mixed[2]!, 10) / parseInt(mixed[3]!, 10);
  const plain = t.replace(',', '.');
  const n = parseFloat(plain);
  return Number.isFinite(n) ? n : null;
}

function matchUnit(token: string): string | null {
  for (const [rx, unit] of UNITS) if (rx.test(token)) return unit;
  return null;
}

// order matters: specific forms (mixed numbers, fractions) before plain integers,
// or the alternation stops at the bare "\d+" prefix of "1½" / "1/2" / "1,5"
const NUMBER_RX = String.raw`(?:\d+\s*[½⅓⅔¼¾⅕⅛]|[½⅓⅔¼¾⅕⅛]|\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+[.,]\d+|\d+)`;

export function normaliseIngredient(rawInput: string): NormalisedIngredient {
  const raw = rawInput.trim();
  let text = raw.replace(/\s+/g, ' ').trim();
  const notes: string[] = [];

  // parenthesised notes → note ("(passata)", "(op kamertemperatuur)")
  text = text.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    if (inner.trim()) notes.push(inner.trim());
    return ' ';
  }).replace(/\s+/g, ' ').trim();

  const toTaste = TO_TASTE.test(text);
  text = text.replace(TO_TASTE, ' ').replace(/\s+/g, ' ').trim();

  // trailing prep note after comma: "ui, fijngesnipperd" — require a space after
  // the comma so decimal commas ("1,5 dl") survive
  const commaSplit = text.split(/\s*,\s+/);
  if (commaSplit.length > 1) {
    text = commaSplit[0]!;
    notes.push(commaSplit.slice(1).join(', '));
  }

  let quantity: number | null = null;
  let quantityMax: number | null = null;
  let unit: string | null = null;

  // range: "2-3", "2 à 3", "2 tot 3" (optionally followed by unit)
  const range = text.match(
    new RegExp(String.raw`^(${NUMBER_RX})\s*(?:-|–|à|a|tot)\s*(${NUMBER_RX})\s+(.*)$`, 'i')
  );
  const single = text.match(new RegExp(String.raw`^(${NUMBER_RX})\s*(.*)$`));

  if (range) {
    const lo = parseNumber(range[1]!);
    const hi = parseNumber(range[2]!);
    if (lo !== null && hi !== null) {
      quantity = (lo + hi) / 2;
      quantityMax = hi;
      text = range[3]!;
    }
  } else if (single) {
    const n = parseNumber(single[1]!);
    if (n !== null) {
      quantity = n;
      text = single[2]!;
    }
  }

  // unit is the first token after the number ("400 g passata", "2 el olijfolie")
  if (quantity !== null) {
    const tokens = text.split(' ');
    const u = tokens.length > 1 ? matchUnit(tokens[0]!) : null; // never eat the whole item ("2 eieren")
    if (u) {
      unit = u;
      text = tokens.slice(1).join(' ');
    }
  } else {
    // unitless amounts: "snufje zout", "scheutje olie", "half bosje peterselie"
    const half = text.match(/^(een\s+)?half\s+(.*)$/i) ?? text.match(/^halve\s+(.*)$/i);
    if (half) {
      quantity = 0.5;
      text = half[half.length - 1]!;
    }
    const tokens = text.split(' ');
    const u = tokens.length > 1 ? matchUnit(tokens[0]!) : null;
    if (u) {
      unit = u;
      quantity ??= 1;
      text = tokens.slice(1).join(' ');
    }
  }

  // drop leading glue words: "verse", "van de", "gedroogde" stay (they're meaningful);
  // only strip articles/prepositions
  text = text.replace(/^(?:de|het|een|van|of|aan)\s+/i, '').trim();

  return {
    raw,
    quantity: toTaste && quantity === null ? null : quantity,
    quantityMax,
    unit,
    item: foldText(text),
    note: notes.length ? notes.join('; ') : null,
    toTaste,
  };
}
