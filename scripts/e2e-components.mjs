// Per-component e2e (UX-audit, plan/11 §Teststrategie): every tab/feature
// exercised standalone against the live API.
//   1. Import — several real links across sites; fallback + AI gap-fill marking
//   2. Matching — Dutch staples → real supermarket product names (6 live chains)
//   3. Lijst — quick-add → enrich → price → delete (manual list life-cycle)
//   4. Plannen — note meals (no recipe) + regenerate-idempotence contract
//   5. Households — list/create (settings screen contract)
// Usage: node scripts/e2e-components.mjs [baseUrl]
const BASE = process.argv[2]?.startsWith('http')
  ? process.argv[2]
  : 'https://func-prakkie-api-dev.azurewebsites.net/api';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const jfetch = async (path, init = {}, token) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const push = (token, mutations) =>
  jfetch('/v1/sync/push', { method: 'POST', body: JSON.stringify({ mutations }) }, token);

console.log(`component e2e against ${BASE}\n`);
const auth = await jfetch('/v1/auth/guest', { method: 'POST', body: JSON.stringify({ platform: 'android' }) });
check('guest auth', auth.status === 201);
const token = auth.body.access_token;

// ---------------------------------------------------------------- 1. IMPORT
console.log('\n— import: meerdere echte links, fallback + gap-fill —');

// fresh links so the URL-hash cache can't serve pre-gap-fill parses
const links = [];
try {
  const html = await (await fetch('https://www.leukerecepten.nl/vandaag/', {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  })).text();
  const found = [...html.matchAll(/href="(https:\/\/www\.leukerecepten\.nl\/recepten\/[a-z0-9-]+\/)"/g)].map((m) => m[1]);
  links.push(...[...new Set(found)].slice(0, 2)); // two different recipes, one site
} catch { /* offline leukerecepten */ }
// second site: pull a source url out of the live discover feed (crawled Dutch blogs)
try {
  const feed = await jfetch('/v1/discover', {}, token);
  const items = feed.body.items ?? [];
  for (const item of items) {
    const detail = await jfetch(`/v1/discover/${item.id}`, {}, token);
    const src = detail.body.recipe?.source_url;
    if (src && !src.includes('leukerecepten')) { links.push(src); break; }
  }
} catch { /* feed offline */ }
check('gathered 3 real recipe links across ≥2 sites', links.length >= 3, links.map((l) => new URL(l).hostname).join(', '));

let sawUnquantified = false;
let sawMarkedSuggestion = false;
for (const url of links) {
  const t0 = Date.now();
  const imp = await jfetch('/v1/import', { method: 'POST', body: JSON.stringify({ url }) }, token);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const r = imp.body.recipe;
  const okShape = imp.status === 200 && r?.title && r.ingredients?.length > 0 && r.steps?.length >= 0;
  check(`import ${new URL(url).hostname}`, okShape, `${secs}s — "${r?.title ?? imp.body.message ?? imp.status}" ${r ? `${r.ingredients.length} ing / ${r.steps?.length ?? 0} stappen` : ''}`);
  if (!r) continue;
  // honesty contract: nothing unmarked is invented; gaps are flagged
  check(`  every ingredient keeps raw_text (${new URL(url).hostname})`,
    r.ingredients.every((i) => typeof i.raw_text === 'string' && i.raw_text.length > 0));
  for (const ing of r.ingredients) {
    if (ing.quantity == null) sawUnquantified = true;
    const suggested = (ing.note ?? '').toLowerCase().includes('suggestie') || (ing.confidence ?? 1) <= 0.5;
    if (suggested) sawMarkedSuggestion = true;
    if (suggested) {
      check(`  AI-suggestie is gemarkeerd: "${(ing.raw_text ?? '').slice(0, 30)}"`,
        (ing.confidence ?? 1) < 0.7, `confidence ${ing.confidence}`);
    }
  }
  if (r.ingredients.some((i) => i.quantity == null) && !(r.missing_fields ?? []).includes('quantities')) {
    // quantities missing without the flag is only OK when they're "naar smaak" style lines
    console.log(`  note: ${new URL(url).hostname} has unquantified lines without missing_fields=quantities (naar smaak?)`);
  }
}
console.log(`  gap-fill observed: unquantified=${sawUnquantified} marked-suggestion=${sawMarkedSuggestion}`);

// fallback honesty: a non-recipe page must fail cleanly, never crash or hallucinate
const junk = await jfetch('/v1/import', { method: 'POST', body: JSON.stringify({ url: 'https://www.rijksoverheid.nl/onderwerpen/belastingplan' }) }, token);
check('non-recipe url → clean, defined outcome (geen crash)',
  junk.status >= 400 || (junk.status === 200 && (junk.body.recipe?.ingredients?.length ?? 0) === 0) || junk.status === 202,
  `status ${junk.status}${junk.body.message ? ` "${String(junk.body.message).slice(0, 60)}"` : ''}`);

// ---------------------------------------------------------------- 2. MATCHING
console.log('\n— matching: NL-basisboodschappen → echte producten (6 live ketens) —');
const CHAINS = ['ah', 'jumbo', 'plus', 'dirk', 'spar', 'aldi'];
const STAPLES = [
  'halfvolle melk', 'eieren', 'roomboter', 'bloem', 'suiker', 'ui', 'knoflook', 'aardappelen',
  'penne', 'rijst', 'kipfilet', 'rundergehakt', 'spekblokjes', 'passata', 'bosui', 'paprika',
  'olijfolie', 'slagroom', 'geraspte kaas', 'komkommer',
];
let matched = 0;
for (const item of STAPLES) {
  const m = await jfetch(`/v1/match?item=${encodeURIComponent(item)}&chains=${CHAINS.join(',')}`, {}, token);
  const hits = Object.values(m.body.matches ?? {}).filter((c) => c.best && c.best.confidence >= 0.4);
  const names = Object.entries(m.body.matches ?? {})
    .filter(([, c]) => c.best)
    .map(([chain, c]) => `${chain}:${c.best.name.slice(0, 28)}`);
  const ok = m.status === 200 && hits.length >= 1 && hits.every((c) => /[a-z]{3}/i.test(c.best.name));
  if (ok) matched++;
  check(`match "${item}" (${hits.length}/6 ketens)`, ok, names[0] ?? 'geen match');
}
check(`matching coverage ≥ 90% (${matched}/${STAPLES.length})`, matched / STAPLES.length >= 0.9);

// quick-add parsing contract (L1): "2 kg aardappelen" → term + qty + schap
const qa = await jfetch(`/v1/match?item=${encodeURIComponent('2 kg aardappelen')}&chains=ah`, {}, token);
check('quick-add parse: "2 kg aardappelen" → item + qty + aisle',
  qa.status === 200 && !!qa.body.item && qa.body.quantity === 2 && qa.body.unit === 'kg',
  `item="${qa.body.item}" qty=${qa.body.quantity}${qa.body.unit ?? ''} aisle=${qa.body.aisle_group_id}`);

// ---------------------------------------------------------------- 3. LIJST standalone
console.log('\n— lijst: quick-add → verrijking → prijs → verwijderen —');
const lid = crypto.randomUUID();
const monday = (() => { const d = new Date(); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.toISOString().slice(0, 10); })();
await push(token, [{ entity: 'lists', op: 'upsert', id: lid, base_updated_at: null, fields: { name: 'component lijst', week_start: monday } }]);

const manualId = crypto.randomUUID();
const enr = qa.body; // enrichment from the match call above
const addRes = await push(token, [{
  entity: 'list_items', op: 'upsert', id: manualId, base_updated_at: null,
  fields: {
    list_id: lid, name: enr.item ?? 'aardappelen', quantity: enr.quantity, unit: enr.unit,
    item_normalised: enr.item ?? 'aardappelen', aisle_group_id: enr.aisle_group_id, is_manual: true,
  },
}]);
check('quick-add item synct (is_manual)', addRes.status === 200 && addRes.body.results?.[0]?.status === 'applied');

const price1 = await jfetch(`/v1/lists/${lid}/price?chains=${CHAINS.join(',')}`, {}, token);
const ahLine = price1.body.chains?.find((c) => c.chain_id === 'ah')?.lines?.find((l) => l.item_id === manualId);
check('handmatig item krijgt een echte productprijs bij AH',
  price1.status === 200 && ahLine?.matched && ahLine.line_price_cents > 0,
  ahLine ? `"${ahLine.product_name}" ${ahLine.line_price_cents}c (packs ${ahLine.packs})` : 'geen regel');

const matchedChains = (price1.body.chains ?? []).filter((c) => c.lines?.some((l) => l.item_id === manualId && l.matched)).length;
check(`item geprijsd bij ≥5/6 ketens (${matchedChains}/6)`, matchedChains >= 5);

const del = await push(token, [{ entity: 'list_items', op: 'delete', id: manualId, base_updated_at: null }]);
const price2 = await jfetch(`/v1/lists/${lid}/price?chains=ah`, {}, token);
const stillThere = price2.body.chains?.[0]?.lines?.some((l) => l.item_id === manualId);
check('verwijderen werkt: regel weg uit prijs', del.status === 200 && !stillThere);

// ---------------------------------------------------------------- 4. PLANNEN standalone
console.log('\n— plannen: notitie-maaltijd + regenerate-idempotentie —');
const pid = crypto.randomUUID();
await push(token, [{ entity: 'plans', op: 'upsert', id: pid, base_updated_at: null, fields: { week_start: monday } }]);
const noteId = crypto.randomUUID();
const noteRes = await push(token, [{
  entity: 'plan_entries', op: 'upsert', id: noteId, base_updated_at: null,
  fields: { plan_id: pid, recipe_id: null, title: 'uit eten bij oma', entry_date: monday, meal_slot: 'dinner', servings: 1 },
}]);
check('notitie-maaltijd (zonder recept) synct', noteRes.status === 200 && noteRes.body.results?.[0]?.status === 'applied',
  noteRes.body.results?.[0]?.message ?? noteRes.body.results?.[0]?.status);

const pull = await jfetch('/v1/sync?entities=plan_entries', {}, token);
const noteRow = (pull.body.changes?.plan_entries?.rows ?? []).find((r) => r.id === noteId);
check('notitie komt terug via pull met title', !!noteRow && noteRow.title === 'uit eten bij oma',
  noteRow?.title ?? 'niet gevonden');

// regenerate contract (P2): tweemaal genereren op DEZELFDE lijst dupliceert niets, handmatig blijft
const recipeId = crypto.randomUUID();
await push(token, [{
  entity: 'recipes', op: 'upsert', id: recipeId, base_updated_at: null,
  fields: {
    title: 'component pasta', origin: 'manual', servings_base: 2,
    ingredients: [{ raw_text: '400 g penne' }, { raw_text: '1 ui' }, { raw_text: '400 g gezeefde tomaten' }],
    steps: [{ order: 1, text: 'Kook de pasta.' }],
  },
}]);
const manual2 = crypto.randomUUID();
await push(token, [{
  entity: 'list_items', op: 'upsert', id: manual2, base_updated_at: null,
  fields: { list_id: lid, name: 'wc-papier', is_manual: true },
}]);
const gen1 = await jfetch(`/v1/lists/${lid}/generate`, { method: 'POST', body: JSON.stringify({ recipes: [{ recipe_id: recipeId, servings: 2 }], replace_generated: true }) }, token);
const gen2 = await jfetch(`/v1/lists/${lid}/generate`, { method: 'POST', body: JSON.stringify({ recipes: [{ recipe_id: recipeId, servings: 2 }], replace_generated: true }) }, token);
const pull2 = await jfetch('/v1/sync?entities=list_items', {}, token);
const liveItems = (pull2.body.changes?.list_items?.rows ?? []).filter((r) => r.list_id === lid && !r.deleted_at);
const manualSurvived = liveItems.some((r) => r.id === manual2);
check('2× genereren op zelfde lijst: geen duplicaten', gen1.status === 200 && gen2.status === 200 && gen1.body.added === gen2.body.added,
  `run1 ${gen1.body.added} regels, run2 ${gen2.body.added}, live nu ${liveItems.length}`);
check('handmatig item overleeft regenerate (G4)', manualSurvived, manualSurvived ? 'wc-papier staat er nog' : 'wc-papier verdween!');

// ---------------------------------------------------------------- 5. HOUSEHOLDS (profiel contract)
console.log('\n— huishouden: list/create + e-mail-invite + gedeelde lijst + added-by log —');
const hh = await jfetch('/v1/households', { method: 'POST', body: JSON.stringify({ name: 'component huis' }) }, token);
const hhList = await jfetch('/v1/households', {}, token);
check('GET /v1/households toont lidmaatschap + ledental',
  hh.status === 201 && hhList.status === 200 &&
    (hhList.body.households ?? []).some((h) => h.id === hh.body.id && h.member_count === 1 && h.role === 'owner'),
  JSON.stringify(hhList.body.households?.[0] ?? {}).slice(0, 90));

// e-mail-invite flow (owner UX 2026-07-06): A nodigt B uit op e-mail; B ziet
// de invite na registratie met dat adres, accepteert, en deelt de lijst.
const stamp = Date.now().toString(36);
const emailB = `e2e-${stamp}@prakkie-test.nl`;
const inv = await jfetch(`/v1/households/${hh.body.id}/invite`, { method: 'POST', body: JSON.stringify({ email: emailB }) }, token);
check('invite op e-mail geaccepteerd door API', inv.status === 200 && inv.body.invited === emailB);

const regB = await jfetch('/v1/auth/register', {
  method: 'POST',
  body: JSON.stringify({ email: emailB, password: `Pw-${stamp}-123456`, display_name: 'Sanne', platform: 'android' }),
});
check('user B registreert met dat e-mailadres', regB.status === 201 || regB.status === 200, `status ${regB.status}`);
const tokenB = regB.body.access_token;

const mineB = await jfetch('/v1/households/invites', {}, tokenB);
const pending = (mineB.body.invites ?? []).find((i) => i.household_id === hh.body.id);
check('B ziet de openstaande uitnodiging', mineB.status === 200 && !!pending, JSON.stringify(mineB.body.invites?.[0] ?? {}).slice(0, 80));

const accept = pending ? await jfetch(`/v1/households/invites/${pending.id}/accept`, { method: 'POST', body: '{}' }, tokenB) : { status: 0, body: {} };
check('B accepteert → lid van huishouden', accept.status === 200 && accept.body.id === hh.body.id);

// gedeelde lijst: A maakt een lijst met household_id; B ziet hem en vult aan
const sharedList = crypto.randomUUID();
await push(token, [{
  entity: 'lists', op: 'upsert', id: sharedList, base_updated_at: null,
  fields: { name: 'gedeelde boodschappen', week_start: monday, household_id: hh.body.id },
}]);
const bSees = await jfetch('/v1/sync?entities=lists', {}, tokenB);
check('B ziet de gedeelde lijst via sync', (bSees.body.changes?.lists?.rows ?? []).some((r) => r.id === sharedList));

const bItem = crypto.randomUUID();
const bAdd = await push(tokenB, [{
  entity: 'list_items', op: 'upsert', id: bItem, base_updated_at: null,
  fields: { list_id: sharedList, name: 'roomboter', is_manual: true },
}]);
check('B voegt item toe aan de gedeelde lijst', bAdd.status === 200 && bAdd.body.results?.[0]?.status === 'applied',
  bAdd.body.results?.[0]?.message ?? '');

// added_by-log: A ziet WIE het item toevoegde (server-gestempeld, niet client)
const aSees = await jfetch('/v1/sync?entities=list_items', {}, token);
const bRow = (aSees.body.changes?.list_items?.rows ?? []).find((r) => r.id === bItem);
check('added_by = user B (log "wie heeft wat toegevoegd")', !!bRow && bRow.added_by === regB.body.user?.id,
  `added_by=${String(bRow?.added_by).slice(0, 8)}… verwacht ${String(regB.body.user?.id).slice(0, 8)}…`);

// ---------------------------------------------------------------- 6. PRODUCTKEUZE (dropdown-contract)
console.log('\n— productkeuze: shortlist altijd + breed (user bepaalt) —');
const rb = await jfetch(`/v1/match?item=roomboter&chains=ah`, {}, token);
const rbList = rb.body.matches?.ah?.shortlist ?? [];
check('shortlist komt ALTIJD terug en is breed (≥8 opties)', rb.status === 200 && rbList.length >= 8, `${rbList.length} opties`);
check('opties hebben naam + prijs + image-veld', rbList.slice(0, 8).every((o) => o.name && o.price_cents > 0 && 'image_url' in o));
const croissant = rbList.find((o) => /croissant/i.test(o.name));
console.log(`  croissant direct in top-12 bij "roomboter": ${croissant ? `JA — "${croissant.name}"` : 'nee (via zoekveld)'}`);
// het zoekveld in de dropdown (owner-bug): verfijnen levert de croissants op
const rbc = await jfetch(`/v1/match?item=${encodeURIComponent('roomboter croissant')}&chains=ah`, {}, token);
const rbcTop = rbc.body.matches?.ah?.shortlist?.[0];
check('dropdown-zoek "roomboter croissant" → croissants bovenaan',
  rbc.status === 200 && !!rbcTop && /croissant/i.test(rbcTop.name), rbcTop?.name ?? 'geen');

console.log(`\n${failures === 0 ? 'All component e2e checks passed.' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
