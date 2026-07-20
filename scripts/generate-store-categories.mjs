// Kandidaat-panelen voor de virtuele supermarkt (plan/12, fase 0; wanden-
// taxonomie 2026-07-12): elk "glazen paneel" op een schappenwand is een
// gecureerde bundel product_intent.head_terms. Dit script schrijft twee
// bestanden:
//
//   scripts/store-category-candidates.csv  — mechanisch, álle (aisle × head_term)
//     met dekking/prijs/vorm; nooit met de hand bewerken, veilig te regenereren.
//   scripts/store-categories.curated.csv   — het seed-bestand: wand-toewijzing
//     (25 wanden = de eigen schappenwand-art van de owner, REDESIGN/1-4.png),
//     per-wand caps, synoniem-merges, hernoemingen en NL-hoofdletters. Dít
//     bestand cureert de owner verder; regenereren vereist --force.
//
// De wand-toewijzing is per-panel (niet per schap-groep): groente/fruit delen
// schap-groep 1, vlees/vis groep 3, kaas/vleeswaren groep 5 — de splitsing
// gebeurt met term-sets hieronder. Valkuilen die live zijn gezien: "leverkaas"
// is vleeswaren, "aardappelen" bevat "appel", katten-/hondenvoer zit als
// mislabel in vlees/vega/dranken.
//
// Usage: node scripts/generate-store-categories.mjs [--env dev]
//        [--min-chains 3] [--min-products 6] [--force]
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const arg = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const env = arg('--env', 'dev');
const minChains = Number(arg('--min-chains', '3'));
const minProducts = Number(arg('--min-products', '6'));
const force = process.argv.includes('--force');
const CANDIDATES_OUT = 'scripts/store-category-candidates.csv';
const CURATED_OUT = 'scripts/store-categories.curated.csv';

/** De 25 wanden, in de loopvolgorde van de owner-art (REDESIGN/1-4.png).
 *  cap = max panelen in het keep-voorstel (glutenvrij: 0 — geen data,
 *  eerlijke "binnenkort"-wand). */
const WALLS = [
  { slug: 'groente-aardappelen', name: 'Groente & aardappelen', theme: 'produce', cap: 14 },
  { slug: 'fruit-sappen', name: 'Fruit & verse sappen', theme: 'produce', cap: 12 },
  { slug: 'maaltijden-salades', name: 'Maaltijden & salades', theme: 'fridge', cap: 8 },
  { slug: 'vlees', name: 'Vlees', theme: 'fridge', cap: 13 },
  { slug: 'vis', name: 'Vis', theme: 'fridge', cap: 10 },
  { slug: 'vega', name: 'Vegetarisch & plantaardig', theme: 'fridge', cap: 8 },
  { slug: 'vleeswaren', name: 'Vleeswaren', theme: 'fridge', cap: 12 },
  { slug: 'kaas', name: 'Kaas', theme: 'fridge', cap: 12 },
  { slug: 'zuivel-eieren', name: 'Zuivel & eieren', theme: 'fridge', cap: 14 },
  { slug: 'bakkerij', name: 'Bakkerij', theme: 'bakery', cap: 12 },
  { slug: 'glutenvrij', name: 'Glutenvrij', theme: 'dry', cap: 0 },
  { slug: 'borrel-chips-snacks', name: 'Borrel, chips & snacks', theme: 'dry', cap: 12 },
  { slug: 'pasta-rijst-wereld', name: 'Pasta, rijst & wereldkeuken', theme: 'dry', cap: 12 },
  { slug: 'soepen-sauzen-kruiden', name: 'Soepen, sauzen, kruiden & olie', theme: 'dry', cap: 14 },
  { slug: 'koek-snoep-chocolade', name: 'Koek, snoep & chocolade', theme: 'dry', cap: 12 },
  { slug: 'ontbijt-beleg', name: 'Ontbijtgranen & beleg', theme: 'dry', cap: 12 },
  { slug: 'tussendoortjes', name: 'Tussendoortjes', theme: 'dry', cap: 10 },
  { slug: 'diepvries', name: 'Diepvries', theme: 'freezer', cap: 12 },
  { slug: 'koffie-thee', name: 'Koffie & thee', theme: 'dry', cap: 8 },
  { slug: 'frisdrank-water', name: 'Frisdrank, sappen & water', theme: 'dry', cap: 12 },
  { slug: 'bier-wijn', name: 'Bier, wijn & aperitieven', theme: 'dry', cap: 10 },
  { slug: 'drogisterij', name: 'Drogisterij', theme: 'nonfood', cap: 12 },
  { slug: 'huishouden', name: 'Huishouden', theme: 'nonfood', cap: 12 },
  { slug: 'baby-kind', name: 'Baby & kind', theme: 'nonfood', cap: 6 },
  { slug: 'huisdier', name: 'Huisdier', theme: 'nonfood', cap: 6 },
];
const wallBySlug = new Map(WALLS.map((w) => [w.slug, w]));

/** standaard-wand per schap-groep (20 = OVERIG: alleen via merges bereikbaar) */
const AISLE_WALL = {
  1: 'groente-aardappelen', 2: 'zuivel-eieren', 3: 'vlees', 4: 'vega', 5: 'vleeswaren',
  6: 'bakkerij', 7: 'ontbijt-beleg', 8: 'pasta-rijst-wereld', 9: 'soepen-sauzen-kruiden',
  10: 'soepen-sauzen-kruiden', 11: 'koek-snoep-chocolade', 12: 'koek-snoep-chocolade',
  13: 'borrel-chips-snacks', 14: 'diepvries', 15: 'frisdrank-water', 16: 'koffie-thee',
  17: 'bier-wijn', 18: 'drogisterij', 19: 'huishouden',
};

/** fruit binnen schap-groep 1 (rest van groep 1 = groente/aardappelen);
 *  expliciete set — géén regex, "aardappelen" bevat "appel" */
const FRUIT_TERMS = new Set([
  'appel', 'appels', 'appelen', 'blauwe bessen', 'watermeloen', 'ananas', 'dadels', 'kiwi',
  'rozijnen', 'mango', 'aardbeien', 'frambozen', 'meloen', 'galiameloen', 'pruimen', 'bananen',
  'banaan', 'abrikozen', 'mandarijnen', 'citroenen', 'limoenen', 'druiven', 'witte druiven',
  'blauwe druiven', 'peren', 'sinaasappels', 'sinaasappelen', 'nectarines', 'perziken', 'bramen',
  'kersen', 'grapefruit', 'granaatappel', 'vijgen', 'cranberries', 'bosbessen', 'rode bessen',
  'frambozen en bosbessen', 'zomerfruit', 'fruit', 'fruitsalade', 'vers fruit',
]);
/** vis binnen schap-groep 3 (rest = vlees) */
const VIS_TERMS = new Set([
  'garnalen', 'garnaal', 'zalm', 'zalmfilet', 'gerookte zalm', 'zalmmoot', 'pangasius',
  'pangasiusfilet', 'kabeljauw', 'kabeljauwfilet', 'sardines', 'haring', 'mosselen', 'kibbeling',
  'forel', 'gerookte forel', 'scholfilet', 'tilapia', 'tilapiafilet', 'makreel', 'gerookte makreel',
  'lekkerbekje', 'lekkerbekjes', 'calamares', 'vis', 'visfilet', 'witvis', 'zeewolf', 'tong',
  'paling', 'ansjovis', 'surimi', 'krab', 'scampi',
]);
/** kaas binnen schap-groep 5 (rest = vleeswaren); "leverkaas" is de valkuil */
const KAAS_EXTRA = new Set([
  'brie', 'camembert', 'gorgonzola', 'parmigiano reggiano', 'grana padano', 'mozzarella',
  'feta', 'cheddar', 'emmentaler', 'manchego', 'pecorino', 'mascarpone', 'burrata', 'halloumi',
]);
const isKaas = (t) => (t.includes('kaas') && t !== 'leverkaas' && !t.includes('salade')) || KAAS_EXTRA.has(t);

/** per-term wand-overrides bovenop de aisle-defaults (aisle:term → wand) */
const TERM_WALL = new Map([
  ['1:salade', 'maaltijden-salades'],
  ['1:maaltijdsalade', 'maaltijden-salades'],
  ['5:salade', 'vleeswaren'],
  ['7:salade', 'vleeswaren'],
  ['7:tonijnsalade', 'vleeswaren'],
  ['5:zalmsalade', 'vleeswaren'],
  ['6:pizza', 'maaltijden-salades'],
  ['6:pizzadeeg', 'maaltijden-salades'],
  ['6:eierkoeken', 'tussendoortjes'],
  ['6:beschuit', 'ontbijt-beleg'],
  ['6:knäckebröd', 'ontbijt-beleg'],
  ['6:toast', 'ontbijt-beleg'],
]);

/** Synoniem-merges + familie-bundels. aisle = primaire schap-groep (telt voor
 *  de cap van zijn wand), extraAisles verbreedt de binding, wall dwingt de
 *  wand af. terms mogen breder zijn dan de kandidatenlijst. */
const MERGES = [
  { slug: 'plantaardige-melk', name: 'Plantaardige melk', aisle: 2, extraAisles: [4], terms: ['haverdrink', 'amandeldrink', 'sojadrink', 'kokosdrink', 'rijstdrink', 'plantaardige melk'] },
  { slug: 'stokbrood', name: 'Stokbrood & baguette', aisle: 6, terms: ['stokbrood', 'baguette'] },
  { slug: 'crackers', name: 'Crackers', aisle: 6, extraAisles: [7, 12], wall: 'ontbijt-beleg', terms: ['crackers', 'cracker'] },
  { slug: 'koekjes', name: 'Koekjes', aisle: 12, terms: ['koekjes', 'koekje', 'cookies', 'biscuit'] },
  { slug: 'chocolade', name: 'Chocolade', aisle: 12, terms: ['chocolade', 'chocoladereep', 'melkchocolade', 'pure chocolade', 'witte chocolade'] },
  { slug: 'proteinerepen', name: 'Proteïnerepen', aisle: 12, wall: 'tussendoortjes', terms: ['proteïnereep', 'protein bar', 'proteïne reep', 'eiwitreep'] },
  { slug: 'mueslirepen', name: 'Mueslirepen', aisle: 12, extraAisles: [11], wall: 'tussendoortjes', terms: ['mueslireep', 'mueslirepen', 'granolareep'] },
  { slug: 'rijstwafels', name: 'Rijstwafels', aisle: 12, extraAisles: [7, 11], wall: 'tussendoortjes', terms: ['rijstwafels', 'rijstwafel', 'maiswafels'] },
  { slug: 'ontbijtkoek', name: 'Ontbijtkoek', aisle: 11, extraAisles: [6], wall: 'tussendoortjes', terms: ['ontbijtkoek'] },
  { slug: 'knijpfruit', name: 'Knijpfruit', aisle: 7, extraAisles: [1], wall: 'tussendoortjes', terms: ['knijpfruit'] },
  { slug: 'cola', name: 'Cola', aisle: 15, terms: ['cola', 'cola zero', 'cola light'] },
  { slug: 'ice-tea', name: 'Ice tea', aisle: 15, terms: ['ice tea', 'iced tea', 'ijsthee'] },
  { slug: 'energy-drink', name: 'Energy drink', aisle: 15, terms: ['energy drink', 'energydrink', 'energiedrank'] },
  { slug: 'verse-sappen', name: 'Verse sappen & smoothies', aisle: 15, wall: 'fruit-sappen', terms: ['smoothie', 'sap', 'sinaasappelsap', 'appelsap', 'verse jus', "jus d'orange"] },
  { slug: 'ijs', name: 'IJs', aisle: 14, terms: ['ijs', 'ijsjes', 'roomijs', 'sorbetijs', 'slagroomijs', 'waterijs'] },
  { slug: 'friet', name: 'Friet & frites', aisle: 14, terms: ['friet', 'frites', 'patat'] },
  { slug: 'deodorant', name: 'Deodorant', aisle: 18, terms: ['deodorant', 'deodorant spray', 'deodorant roller', 'deo'] },
  { slug: 'witte-wijn', name: 'Witte wijn', aisle: 17, terms: ['witte wijn', 'chardonnay', 'sauvignon blanc', 'pinot grigio'] },
  { slug: 'tonijn', name: 'Tonijn', aisle: 3, extraAisles: [9], wall: 'vis', terms: ['tonijn', 'tonijnstukken', 'tonijnmoot', 'tonijnsteak'] },
  { slug: 'luiers', name: 'Luiers', aisle: 18, extraAisles: [19], wall: 'baby-kind', terms: ['luiers'] },
  { slug: 'billendoekjes', name: 'Billendoekjes', aisle: 18, wall: 'baby-kind', terms: ['billendoekjes', 'babydoekjes'] },
  { slug: 'babyvoeding', name: 'Babyvoeding', aisle: 1, extraAisles: [2, 18], wall: 'baby-kind', terms: ['babyvoeding', 'opvolgmelk', 'babyhapje'] },
  { slug: 'kattenvoer', name: 'Kattenvoer', aisle: 19, extraAisles: [3, 4], wall: 'huisdier', terms: ['kattenvoer'] },
  { slug: 'hondenvoer', name: 'Hondenvoer', aisle: 19, extraAisles: [3, 4, 20], wall: 'huisdier', terms: ['hondenvoer', 'hondenbrokken'] },
  { slug: 'kattenbakvulling', name: 'Kattenbakvulling', aisle: 19, wall: 'huisdier', terms: ['kattenbakvulling'] },
];

/** Hernoemingen waar het kale head_term geen paneelnaam is. */
const RENAMES = new Map([
  ['14:maaltijd', 'Diepvriesmaaltijden'],
  ['14:pizza', 'Diepvriespizza'],
  ['18:gel', 'Haargel'],
  ['7:salade', 'Smeersalades'],
  ['5:salade', 'Vleessalades'],
  ['1:salade', 'Maaltijdsalades'],
  ['6:pizza', 'Verse pizza'],
  ['12:snoep', 'Snoep & zoetwaren'],
  ['15:frisdrank', 'Frisdrank overig'],
  ['17:wijn', 'Wijn overig'],
  ['4:burger', 'Vegaburgers'],
  ['4:balletjes', 'Vega balletjes'],
]);

/** Mislabels die geen eigen paneel verdienen (dekking zit al elders). */
const DROPS = new Set(['12:ijs']);

/** fixture-voorstel: wand-thema wint, daarbinnen beslist de dominante vorm. */
function fixtureFor(wall, topForm) {
  if (wall.theme === 'produce') return 'produce';
  if (wall.theme === 'bakery') return 'bakery';
  if (wall.theme === 'freezer' || topForm === 'diepvries') return 'freezer';
  if (wall.theme === 'fridge') return topForm === 'vers' ? 'fridge' : 'shelf';
  return 'shelf';
}

/** wand voor een los (aisle, term)-paneel */
function wallFor(aisle, term) {
  const override = TERM_WALL.get(`${aisle}:${term}`);
  if (override) return wallBySlug.get(override);
  if (aisle === 1) return wallBySlug.get(FRUIT_TERMS.has(term) ? 'fruit-sappen' : 'groente-aardappelen');
  if (aisle === 3) return wallBySlug.get(VIS_TERMS.has(term) ? 'vis' : 'vlees');
  if (aisle === 5) return wallBySlug.get(isKaas(term) ? 'kaas' : 'vleeswaren');
  const slug = AISLE_WALL[aisle];
  return slug ? wallBySlug.get(slug) : undefined;
}

const slugify = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** NL-hoofdletter: IJsbergsla, niet Ijsbergsla. */
const nlTitle = (s) =>
  s.startsWith('ij') ? `IJ${s.slice(2)}` : s.charAt(0).toUpperCase() + s.slice(1);
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const az = (...args) => execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const host = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
const password = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
const client = new pg.Client({ host, port: 5432, database: 'prakkie', user: 'prakkieadmin', password, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
await client.connect();

const { rows } = await client.query(
  `SELECT i.aisle_group_id, a.name_nl AS aisle_name, i.head_term,
          count(*)::int AS products,
          count(DISTINCT i.chain_id)::int AS chains,
          min(COALESCE(p.promo_price_cents, p.price_cents))::int AS min_cents,
          mode() WITHIN GROUP (ORDER BY i.form) AS top_form,
          round(avg(i.is_base::int), 2) AS base_share,
          (array_agg(p.name ORDER BY p.price_cents))[1:3] AS sample_names
   FROM catalog.product_intent i
   JOIN catalog.products p ON p.chain_id = i.chain_id AND p.sku_id = i.sku_id
   JOIN catalog.aisle_taxonomy a ON a.id = i.aisle_group_id
   WHERE p.available
   GROUP BY 1, 2, 3
   HAVING count(DISTINCT i.chain_id) >= $1 AND count(*) >= $2
   ORDER BY i.aisle_group_id, count(DISTINCT i.chain_id) DESC, count(*) DESC`,
  [minChains, minProducts]
);
await client.end();

// ── 1. kandidaten-CSV (mechanisch, volledig) ────────────────────────────────
const candHeader = ['aisle_group_id', 'aisle_name', 'head_term', 'products', 'chains', 'min_price_eur', 'top_form', 'base_share', 'sample_names'];
writeFileSync(
  CANDIDATES_OUT,
  [candHeader.join(',')]
    .concat(rows.map((r) => [
      r.aisle_group_id, r.aisle_name, r.head_term, r.products, r.chains,
      (r.min_cents / 100).toFixed(2), r.top_form, r.base_share,
      (r.sample_names ?? []).join(' | '),
    ].map(csvCell).join(',')))
    .join('\n') + '\n',
  'utf8'
);
console.log(`kandidaten: ${rows.length} rijen → ${CANDIDATES_OUT}`);

// ── 2. gecureerd voorstel ───────────────────────────────────────────────────
if (existsSync(CURATED_OUT) && !force) {
  console.log(`${CURATED_OUT} bestaat al — niet overschreven (handwerk!). Gebruik --force om opnieuw te genereren.`);
  process.exit(0);
}

// merges mogen uit élke schap-groep putten (ook OVERIG); losse panelen alleen
// uit de gemapte groepen
const byKey = new Map(rows.map((r) => [`${r.aisle_group_id}:${r.head_term}`, r]));
const consumed = new Set();

const mergedPanels = MERGES.flatMap((m) => {
  const aisles = [m.aisle, ...(m.extraAisles ?? [])];
  const parts = aisles.flatMap((a) => m.terms.map((t) => byKey.get(`${a}:${t}`)).filter(Boolean));
  if (!parts.length) return [];
  for (const p of parts) consumed.add(`${p.aisle_group_id}:${p.head_term}`);
  const wall = m.wall ? wallBySlug.get(m.wall) : wallFor(m.aisle, m.terms[0]);
  if (!wall) return [];
  return [{
    aisle_group_id: m.aisle,
    aisle_ids: aisles,
    head_terms: m.terms,
    slug: m.slug,
    name: m.name,
    wall,
    products: parts.reduce((s, p) => s + p.products, 0),
    chains: Math.max(...parts.map((p) => p.chains)),
    min_cents: Math.min(...parts.map((p) => p.min_cents)),
    top_form: parts[0].top_form,
    base_share: parts[0].base_share,
    sample_names: parts[0].sample_names,
  }];
});

const singlePanels = rows
  .filter((r) => !consumed.has(`${r.aisle_group_id}:${r.head_term}`) && !DROPS.has(`${r.aisle_group_id}:${r.head_term}`))
  .map((r) => {
    const wall = wallFor(r.aisle_group_id, r.head_term);
    if (!wall) return null;
    return {
      aisle_group_id: r.aisle_group_id,
      aisle_ids: [r.aisle_group_id],
      head_terms: [r.head_term],
      slug: slugify(r.head_term),
      name: RENAMES.get(`${r.aisle_group_id}:${r.head_term}`) ?? nlTitle(r.head_term),
      wall,
      products: r.products,
      chains: r.chains,
      min_cents: r.min_cents,
      top_form: r.top_form,
      base_share: r.base_share,
      sample_names: r.sample_names,
    };
  })
  .filter(Boolean);

// per-wand cap: merges eerst (gaan altijd mee), dan de sterkste losse panelen
const perWall = new Map();
for (const p of mergedPanels) perWall.set(p.wall.slug, (perWall.get(p.wall.slug) ?? 0) + 1);
const kept = [...mergedPanels];
for (const p of singlePanels.sort((a, b) => b.chains - a.chains || b.products - a.products)) {
  if (p.chains < 5) continue;
  const used = perWall.get(p.wall.slug) ?? 0;
  if (used >= p.wall.cap) continue;
  perWall.set(p.wall.slug, used + 1);
  kept.push(p);
}

// slug-botsingen (zelfde term op meerdere wanden) → wand-suffix
const bySlug = new Map();
for (const p of kept) {
  if (bySlug.has(p.slug)) p.slug = `${p.slug}-${p.wall.slug}`;
  bySlug.set(p.slug, p);
}

// volgorde: wand (looproute) → dekking/omvang; sort = plankvolgorde
const wallOrder = new Map(WALLS.map((w, i) => [w.slug, i]));
kept.sort((a, b) =>
  wallOrder.get(a.wall.slug) - wallOrder.get(b.wall.slug) ||
  b.chains - a.chains || b.products - a.products
);

const curHeader = [
  'panel_slug', 'name_nl', 'department_slug', 'fixture_type', 'sort',
  'aisle_group_ids', 'head_terms', 'products', 'chains', 'min_price_eur',
  'top_form', 'sample_names', 'notes',
];
const curLines = [curHeader.join(',')];
let sort = 0;
let lastWall = '';
for (const p of kept) {
  if (p.wall.slug !== lastWall) { sort = 0; lastWall = p.wall.slug; }
  sort += 10; // ruimte om bij curatie tussen te voegen
  curLines.push([
    p.slug, p.name, p.wall.slug, fixtureFor(p.wall, p.top_form), sort,
    p.aisle_ids.join(';'), p.head_terms.join(';'), p.products, p.chains,
    (p.min_cents / 100).toFixed(2), p.top_form,
    (p.sample_names ?? []).join(' | '), '',
  ].map(csvCell).join(','));
}
writeFileSync(CURATED_OUT, curLines.join('\n') + '\n', 'utf8');

console.log(`gecureerd voorstel: ${kept.length} panelen → ${CURATED_OUT}`);
for (const w of WALLS) {
  console.log(`  ${w.name}: ${kept.filter((p) => p.wall.slug === w.slug).length}`);
}
