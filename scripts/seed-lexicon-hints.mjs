// Seed catalog.lexicon_products rank-1 hints for the curated staples
// (UX-audit matching pass): the matcher's intended mechanism for "melk means
// milk, not milkshake". Per (lexicon item × enabled chain) we fetch whole-word
// alias candidates and pick the most product-like one by name shape:
//   1. name IS the alias ("Aardbeien")
//   2. store-brand + alias ("AH Uien", "Elvee Aardbeien")
//   3. starts with the alias ("Aardappelen vastkokend 3 kg")
//   4. ends with the alias ("Kanzi Appel")
//   5. anything else with a whole-word hit
// ties: longest matched alias (plural beats flavour-name singular) → shortest
// name → cheapest. Dish/ready-meal markers disqualify a candidate unless the
// item itself is such a word (soep, saus). Re-runnable (ON CONFLICT UPDATE);
// the E5 learning loop overwrites ranks as real corrections come in.
//
// Usage: node scripts/seed-lexicon-hints.mjs [--env dev] [--dry] [--only ui,appel]
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const env = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : 'dev';
const dry = process.argv.includes('--dry');
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',').map((s) => s.trim())
  : null;
const az = (...args) => execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();

const host = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
const password = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
const client = new pg.Client({ host, port: 5432, database: 'prakkie', user: 'prakkieadmin', password, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
await client.connect();

const DISH_WORDS = [
  'rings', 'schotel', 'maaltijd', 'salade', 'soep', 'saus', 'mix', 'pizza', 'gratin', 'puree',
  'chips', 'snack', 'drink', 'dessert', 'taart', 'koek', 'ijs', 'broodje', 'wrap', 'burger',
  'nugget', 'krokant', 'siroop', 'limonade', 'jam', 'vla', 'trifle', 'smoothie', 'sap',
  'hagel', 'vulling', 'beleg', 'geur', 'smaak', 'shampoo', 'kattenvoer', 'hondenvoer',
  'gevuld', 'gevulde', 'gebraden', 'gepaneerd', 'gemarineerd', 'zoetzuur', 'zoetzure',
  'zoet', 'zoete', 'aioli', 'hummus', 'tapenade', 'pesto', 'spread', 'dressing', 'basis',
  // vorm-woorden (owner 2026-07-07): "sperziebonen in blik gebroken" mag nooit
  // dé rank-1-hint worden. Bewust niet 'pot'/'zoetzuur-alleen': augurken e.d.
  // houden hun hint via de bestaande "item is zelf zo'n woord"-escape.
  'blik', 'blikje', 'blikjes', 'gebroken', 'gedroogd', 'gedroogde', 'ingelegd', 'ingelegde',
  // gebak is geen ingrediënt: "Roomboter croissant" werd de hint voor roomboter
  'croissant', 'croissants', 'koekje', 'koekjes', 'biscuit', 'biscuits', 'sprits', 'spritsen',
];
const STORE_BRANDS =
  '(ah|ah biologisch|jumbo|jumbo biologisch|plus|spar|aldi|dirk|1 de beste|g woon|gwoon|markant|boni|perfekt|elvee|nature|bio\\+|bio)';

const fold = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function shapeScore(name, alias) {
  const n = fold(name);
  if (n === alias) return 0;
  if (new RegExp(`^${STORE_BRANDS} ${alias}$`).test(n)) return 1;
  if (new RegExp(`^${alias}\\b`).test(n)) return 2;
  if (new RegExp(`\\b${alias}$`).test(n)) return 3;
  return 4;
}

const { rows: lexicon } = await client.query(
  `SELECT item_normalised, aliases FROM catalog.ingredient_lexicon ORDER BY item_normalised`
);
const { rows: chains } = await client.query(`SELECT id FROM catalog.chains WHERE enabled`);
const items = only ? lexicon.filter((l) => only.includes(l.item_normalised)) : lexicon;
console.log(`${items.length} lexicon items × ${chains.length} chains (env ${env}${dry ? ', dry-run' : ''})`);

// every lexicon noun (≥4 chars) — a candidate whose name carries a DIFFERENT
// food noun ("yoghurt aardbei", "gehakt met ui") is a different product.
// multiword items contribute their head noun ("geraspte kaas" → "kaas").
const allNouns = new Set(
  lexicon
    .flatMap((l) => [l.item_normalised, ...(l.aliases ?? [])])
    .map(fold)
    .flatMap((w) => (w.includes(' ') ? [w.split(' ').at(-1)] : [w]))
    .filter((w) => w && w.length >= 4)
);
// Dutch compounds put the head noun last: kopSOEP, kruimelVLAAI, roomIJS
const COMPOUND_TAILS = ['soep', 'saus', 'taart', 'vlaai', 'koek', 'drank', 'siroop', 'salade', 'schotel', 'puree', 'chips', 'vla', 'reep', 'gebak', 'mix'];

// full reseed: rows that no longer qualify must disappear too. The nightly
// E5 learning loop re-adds correction-driven rows on its own schedule.
if (!dry && !only) await client.query(`DELETE FROM catalog.lexicon_products`);

let seeded = 0;
let skipped = 0;
for (const lex of items) {
  // morphological Dutch variants only — translations pull English products,
  // diminutives (eitjes) pull garnish/roe instead of the staple
  const aliases = [...new Set([lex.item_normalised, ...(lex.aliases ?? [])])]
    .map(fold)
    .filter((a) => a && (a.includes(fold(lex.item_normalised)) || fold(lex.item_normalised).includes(a)))
    .filter((a) => !/(tje|tjes)$/.test(a) || a === fold(lex.item_normalised))
    .slice(0, 6);
  // dish markers don't apply when the item itself is one (soep, saus, mix…)
  const activeDishWords = DISH_WORDS.filter((w) => !aliases.some((a) => a.split(' ').includes(w)));
  const dishRx = new RegExp(`\\b(${activeDishWords.join('|')})\\b`);

  for (const { id: chain } of chains) {
    const { rows: candidates } = await client.query(
      `SELECT p.sku_id, p.name, p.price_cents
       FROM catalog.products p
       WHERE p.chain_id = $1 AND p.available
         AND EXISTS (SELECT 1 FROM unnest($2::text[]) a
                     WHERE public.fold_text(p.name) ~ ('\\m' || a || '\\M'))
       ORDER BY length(p.name) ASC, p.price_cents ASC
       LIMIT 120`,
      [chain, aliases]
    );
    const scored = candidates
      .filter((c) => !dishRx.test(fold(c.name)))
      .map((c) => {
        const folded = fold(c.name);
        const words = folded.split(' ');
        const hits = aliases.filter((a) => new RegExp(`\\b${a}\\b`).test(folded));
        const bestAlias = hits.sort((x, y) => y.length - x.length)[0] ?? '';
        // other-food-noun ("yoghurt aardbei"), compound tail ("kopsoep") or a word
        // ENDING in another noun ("truffelsalami") ⇒ different product
        const foreignNoun = words.some((w) => w.length >= 4 && allNouns.has(w) && !aliases.includes(w));
        const compoundTail = words.some(
          (w) => !aliases.includes(w) && COMPOUND_TAILS.some((t) => w.length > t.length && w.endsWith(t))
        );
        const foreignSuffix = words.some(
          (w) =>
            !aliases.includes(w) &&
            [...allNouns].some((n) => n.length >= 5 && w.length > n.length && w.endsWith(n) && !aliases.includes(n))
        );
        // variety compounds (zilvervliesrijst) count worse than prefix morphs
        // (aardbei→aardbeien): a plain "witte rijst" must beat brand+variety
        const itemFold = fold(lex.item_normalised);
        const aliasPenalty = (a) => (a.startsWith(itemFold) ? 0 : 2);
        return {
          ...c,
          score:
            Math.min(...hits.map((a) => shapeScore(c.name, a) + aliasPenalty(a)), 9) +
            (foreignNoun || compoundTail || foreignSuffix ? 4 : 0),
          // prefer the PLAIN item over variety aliases at equal shape
          aliasIdx: Math.min(...hits.map((a) => aliases.indexOf(a))),
          aliasLen: bestAlias.length,
        };
      })
      .sort(
        (a, b) =>
          // longest matched alias: plural product names ("…aardappelen") beat
          // dish names that carry the bare singular ("zoete aardappel")
          a.score - b.score || b.aliasLen - a.aliasLen || a.name.length - b.name.length || a.price_cents - b.price_cents
      );
    if (process.argv.includes('--debug')) {
      console.log(`  DEBUG ${lex.item_normalised}@${chain} aliases=[${aliases}] top3:`);
      for (const s of scored.slice(0, 3)) console.log(`    score=${s.score} idx=${s.aliasIdx} "${s.name}"`);
    }
    const best = scored[0];
    // a bad hint is worse than none (hints override trgm): seed only clean
    // shapes, and "brand + adjective + alias" only for short store-brand names
    const brandShape3 =
      best && best.score === 3 && new RegExp(`^${STORE_BRANDS}\\b`).test(fold(best.name)) && fold(best.name).split(' ').length <= 3;
    if (!best || (best.score > 2 && !brandShape3)) {
      skipped++;
      continue; // leave it to trgm
    }
    if (dry) {
      console.log(`  ${lex.item_normalised} @ ${chain} → ${best.name} (${best.price_cents}c, shape ${best.score})`);
    } else {
      await client.query(
        `INSERT INTO catalog.lexicon_products (item_normalised, chain_id, sku_id, rank)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (item_normalised, chain_id) DO UPDATE SET sku_id = EXCLUDED.sku_id, rank = 1`,
        [lex.item_normalised, chain, best.sku_id]
      );
    }
    seeded++;
  }
}
console.log(`${dry ? 'would seed' : 'seeded'} ${seeded} hints (${skipped} item×chain combos left to trgm)`);
await client.end();
