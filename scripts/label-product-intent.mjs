// AI-productintent-labeling (owner 2026-07-08): vult catalog.product_intent
// (0025) voor de hele catalogus met een LLM — head_term ("volle melk",
// "sperziebonen", "croissant"), form (vers/blik/pot/diepvries/gedroogd/
// houdbaar/bewerkt/non-food), is_base en aisle_group_id (20-groepen).
// Dít is het structurele label waar de matcher op leunt: kaastengels zijn
// nooit meer roomboter, blik-sperziebonen zakken onder verse, en anker-
// substituties matchen op head_term i.p.v. fuzzy tekst.
//
// Hervatbaar: skipt producten waarvan name_hash ongewijzigd is. Budget-guard:
// stopt hard op --max-usd (default 25). Key via env OPENAI_API_KEY (nooit in
// het bestand). Kosten ~mini-model: hele catalogus ≈ enkele dollars.
//
// Usage: OPENAI_API_KEY=... node scripts/label-product-intent.mjs
//          [--env dev] [--chain ah,jumbo] [--limit 200] [--dry]
//          [--model gpt-5.4-mini] [--max-usd 25] [--concurrency 4]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const env = arg('env', 'dev');
const dry = process.argv.includes('--dry');
const onlyChains = arg('chain', null)?.split(',').map((s) => s.trim()) ?? null;
const limit = arg('limit', null) ? Number(arg('limit')) : null;
const model = arg('model', 'gpt-5.4-mini');
const maxUsd = Number(arg('max-usd', 25));
const concurrency = Number(arg('concurrency', 4));
const BATCH = 40;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY ontbreekt (zet als env var, nooit in code)');

const az = (...a) => execFileSync('az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const host = az('postgres', 'flexible-server', 'list', '-g', `prakkie-${env}`, '--query', '[0].fullyQualifiedDomainName', '-o', 'tsv');
const password = az('keyvault', 'secret', 'show', '--vault-name', `kv-prakkie-${env}`, '--name', 'PG-ADMIN-PASSWORD', '--query', 'value', '-o', 'tsv');
const client = new pg.Client({ host, port: 5432, database: 'prakkie', user: 'prakkieadmin', password, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
await client.connect();

const md5 = (s) => createHash('md5').update(s).digest('hex');

const { rows: aisles } = await client.query(`SELECT id, name_nl FROM catalog.aisle_taxonomy ORDER BY id`);
const aisleIds = new Set(aisles.map((a) => Number(a.id)));
const FORMS = new Set(['vers', 'blik', 'pot', 'diepvries', 'gedroogd', 'houdbaar', 'bewerkt', 'non-food']);

const { rows: todo } = await client.query(
  `SELECT p.chain_id, p.sku_id, p.name, p.brand
   FROM catalog.products p
   LEFT JOIN catalog.product_intent i ON i.chain_id = p.chain_id AND i.sku_id = p.sku_id
    AND i.name_hash = md5(p.name)
   WHERE p.available AND i.chain_id IS NULL
     ${onlyChains ? `AND p.chain_id = ANY($1)` : ''}
   ORDER BY p.chain_id, p.sku_id
   ${limit ? `LIMIT ${limit}` : ''}`,
  onlyChains ? [onlyChains] : []
);
console.log(`${todo.length} producten te labelen (env ${env}, model ${model}${dry ? ', dry-run' : ''}, cap $${maxUsd})`);
if (todo.length === 0) {
  await client.end();
  process.exit(0);
}

const SYSTEM = `Je bent een NL-supermarkt-productclassifier. Per product geef je:
- head: de kale kern van wat het product ÍS, als gangbare Nederlandse kook-/boodschappenterm in kleine letters. Het is de kop van de naam, niet een ingrediënt erin: "Roomboter croissant"→"croissant"; "Spar kaastengel roomboter"→"kaastengel"; "Jumbo Houdbare Volle Melk 6x200ML"→"volle melk"; "Sperziebonen kleingesneden (blik)"→"sperziebonen"; "Melba toast naturel"→"toast"; "AH Boterhamzakjes"→"boterhamzakjes". Varianten die de soort bepalen blijven in de head ("volle melk", "halfvolle melk", "bruin brood", "witte rijst"); merken, maten, aantallen en kwaliteitswoorden (vers/bio/gezouten) niet.
- form: vers | blik | pot | diepvries | gedroogd | houdbaar | bewerkt | non-food. "vers"=onbewerkt vers of gewoon schap-product; "houdbaar"=UHT/langhoudbare variant van iets vers; "bewerkt"=kant-en-klaar/samengesteld (maaltijd, salade-mix, gebak); "non-food"=geen voedsel.
- base: true als het een basisingrediënt is dat in recepten als ingrediënt voorkomt (groente, zuivel, vlees, pasta, kruiden); false voor kant-en-klaar, snacks, gebak, non-food.
- aisle: het id van de best passende schapgroep uit deze lijst:
${aisles.map((a) => `${a.id}=${a.name_nl}`).join('; ')}
Antwoord ALLEEN met JSON: {"items":[{"i":<index>,"head":"...","form":"...","base":true|false,"aisle":<id>}]}`;

let inTok = 0;
let outTok = 0;
// mini-tarief ruim geschat; de guard is een noodrem, geen boekhouding
const estUsd = () => (inTok * 0.4 + outTok * 1.6) / 1e6;

async function labelBatch(batch, attempt = 0) {
  const list = batch.map((p, i) => `${i}. ${p.brand ? `[${p.brand}] ` : ''}${p.name}`).join('\n');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: list },
      ],
    }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`openai ${res.status} na 5 pogingen`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return labelBatch(batch, attempt + 1);
  }
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  inTok += body.usage?.prompt_tokens ?? 0;
  outTok += body.usage?.completion_tokens ?? 0;
  const parsed = JSON.parse(body.choices[0].message.content);
  return parsed.items ?? [];
}

let done = 0;
let failed = 0;
let cursor = 0;
const started = Date.now();
const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

async function worker() {
  for (;;) {
    const b = cursor++;
    if (b >= batches.length) return;
    if (estUsd() > maxUsd) {
      console.log(`  BUDGET-STOP: ~$${estUsd().toFixed(2)} > $${maxUsd}`);
      cursor = batches.length;
      return;
    }
    const batch = batches[b];
    try {
      const items = await labelBatch(batch);
      const byIdx = new Map(items.map((x) => [Number(x.i), x]));
      for (let i = 0; i < batch.length; i++) {
        const p = batch[i];
        const x = byIdx.get(i);
        if (!x || !x.head || typeof x.head !== 'string') {
          failed++;
          continue;
        }
        const head = x.head.toLowerCase().trim().slice(0, 80);
        const form = FORMS.has(x.form) ? x.form : 'bewerkt';
        const aisle = aisleIds.has(Number(x.aisle)) ? Number(x.aisle) : null;
        if (dry) {
          console.log(`  ${p.chain_id}:${p.name} → head="${head}" form=${form} base=${!!x.base} aisle=${aisle}`);
        } else {
          await client.query(
            `INSERT INTO catalog.product_intent (chain_id, sku_id, head_term, form, is_base, aisle_group_id, name_hash, model)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (chain_id, sku_id) DO UPDATE SET head_term=EXCLUDED.head_term, form=EXCLUDED.form,
               is_base=EXCLUDED.is_base, aisle_group_id=EXCLUDED.aisle_group_id, name_hash=EXCLUDED.name_hash,
               model=EXCLUDED.model, labeled_at=now()`,
            [p.chain_id, p.sku_id, head, form, !!x.base, aisle, md5(p.name), model]
          );
        }
        done++;
      }
    } catch (err) {
      failed += batch.length;
      if (failed <= 200) console.log(`  BATCH-FAIL (${batch[0].chain_id}): ${err.message}`);
    }
    if ((b + 1) % 20 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  ${done}/${todo.length} gelabeld (~$${estUsd().toFixed(2)}, ${rate.toFixed(0)}/s, ${failed} mislukt)`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`klaar: ${done} gelabeld, ${failed} mislukt, ~$${estUsd().toFixed(2)} verbruikt, ${Math.round((Date.now() - started) / 60000)} min`);
await client.end();
process.exit(failed > done ? 1 : 0);
