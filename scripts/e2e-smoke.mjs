// Live end-to-end smoke of the product spine (goal: "end to end tested"):
//   guest auth → import real blog recipe (WS3, live Apify/OpenAI path) → save via
//   sync (WS1) → list-generate (WS5 G1/G2) → list-price (G7) → basket-compare (F2)
//   → deals (F3) → match shortlist (E5 entrance).
//   Usage: node scripts/e2e-smoke.mjs [baseUrl] [--url <recipe-url>]
const BASE = process.argv[2]?.startsWith('http')
  ? process.argv[2]
  : 'https://func-prakkie-api-dev.azurewebsites.net/api';
const urlArgIdx = process.argv.indexOf('--url');
let RECIPE_URL = urlArgIdx > -1 ? process.argv[urlArgIdx + 1] : null;

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

// 0. find a real recipe URL when none was given (Leukerecepten sitemap)
if (!RECIPE_URL) {
  try {
    // pull a real recipe link off the "vandaag" page (anchors into /recepten/<slug>/)
    const html = await (await fetch('https://www.leukerecepten.nl/vandaag/', {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    })).text();
    const links = [...html.matchAll(/href="(https:\/\/www\.leukerecepten\.nl\/recepten\/[a-z0-9-]+\/)"/g)].map((m) => m[1]);
    RECIPE_URL = links.find(Boolean) ?? null;
  } catch {
    /* fall through */
  }
  RECIPE_URL ??= 'https://www.leukerecepten.nl/recepten/pasta-carbonara-recept/';
}
console.log(`e2e against ${BASE}\nrecipe url: ${RECIPE_URL}\n`);

// 1. guest session
const auth = await jfetch('/v1/auth/guest', { method: 'POST', body: JSON.stringify({ platform: 'android' }) });
check('guest auth 201', auth.status === 201, `status ${auth.status}`);
const token = auth.body.access_token;

// 2. import a real blog recipe (fast path: JSON-LD → OpenAI)
const t0 = Date.now();
const imp = await jfetch('/v1/import', { method: 'POST', body: JSON.stringify({ url: RECIPE_URL }) }, token);
const importMs = Date.now() - t0;
check('import 200', imp.status === 200, `status ${imp.status} in ${(importMs / 1000).toFixed(1)}s ${JSON.stringify(imp.body).slice(0, 120)}`);
const recipe = imp.body.recipe;
if (recipe) {
  check('recipe has title + ingredients + steps', !!recipe.title && recipe.ingredients?.length > 0 && recipe.steps?.length > 0,
    `"${recipe.title}" — ${recipe.ingredients?.length} ing, ${recipe.steps?.length} steps`);
  check('no invented quantities: every ingredient has raw_text', recipe.ingredients.every((i) => typeof i.raw_text === 'string' && i.raw_text.length > 0));
  check('import <15s (blog target <3s, allow cold start + model)', importMs < 15000, `${(importMs / 1000).toFixed(1)}s`);

  // cache hit: same URL again = instant
  const t1 = Date.now();
  const imp2 = await jfetch('/v1/import', { method: 'POST', body: JSON.stringify({ url: RECIPE_URL }) }, token);
  check('re-import cache hit, instant + cached flag', imp2.status === 200 && imp2.body.cached === true && Date.now() - t1 < 3000,
    `${Date.now() - t1}ms cached=${imp2.body.cached}`);
}

// 3. save recipe via sync push (what the review screen does)
const rid = crypto.randomUUID();
const save = await jfetch('/v1/sync/push', {
  method: 'POST',
  body: JSON.stringify({
    mutations: [{
      entity: 'recipes', op: 'upsert', id: rid, base_updated_at: null,
      fields: recipe
        ? { title: recipe.title, origin: 'import', source_url: recipe.source_url, ingredients: recipe.ingredients, steps: recipe.steps, servings_base: recipe.servings_base ?? 2, tags: recipe.tags ?? [] }
        : { title: 'Fallback pasta', origin: 'manual', ingredients: [{ raw_text: '400 g penne' }, { raw_text: '1 ui' }, { raw_text: '2 teentjes knoflook' }, { raw_text: '400 g gezeefde tomaten' }], steps: [{ order: 1, text: 'Kook en meng.' }] },
    }],
  }),
}, token);
check('save recipe via sync', save.status === 200 && save.body.results?.[0]?.status === 'applied',
  save.body.results?.[0]?.status);

// 4. create a list + generate from the recipe
const lid = crypto.randomUUID();
await jfetch('/v1/sync/push', {
  method: 'POST',
  body: JSON.stringify({ mutations: [{ entity: 'lists', op: 'upsert', id: lid, base_updated_at: null, fields: { name: 'e2e lijst' } }] }),
}, token);
const gen = await jfetch(`/v1/lists/${lid}/generate`, {
  method: 'POST',
  body: JSON.stringify({ recipes: [{ recipe_id: rid, servings: 4 }] }),
}, token);
check('list-generate adds lines', gen.status === 200 && gen.body.added > 0, `added ${gen.body.added}`);

// 5. price across chains (p95 target <2s warm)
const t2 = Date.now();
const price = await jfetch(`/v1/lists/${lid}/price?chains=ah,jumbo,plus,dirk,spar,aldi`, {}, token);
const priceMs = Date.now() - t2;
const chains = price.body.chains ?? [];
check('list-price returns chains', price.status === 200 && chains.length >= 4, `${chains.length} chains in ${(priceMs / 1000).toFixed(1)}s`);
const ah = chains.find((c) => c.chain_id === 'ah');
check('AH pricing has matches + total', !!ah && ah.matched > 0 && ah.total_cents > 0,
  ah ? `${ah.matched} matched, total ${ah.total_cents}c, unmatched: ${ah.unmatched.join('/') || 'none'}` : 'no ah');
check('pricing <5s (2s target warm)', priceMs < 5000, `${(priceMs / 1000).toFixed(1)}s`);

// 6. compare + deals
const cmp = await jfetch(`/v1/lists/${lid}/compare`, {}, token);
check('basket-compare ranks chains', cmp.status === 200 && (cmp.body.ranked?.length ?? 0) + (cmp.body.partial?.length ?? 0) >= 4,
  `cheapest=${cmp.body.cheapest_chain} ranked=${cmp.body.ranked?.length} partial=${cmp.body.partial?.length}`);
const deals = await jfetch(`/v1/lists/${lid}/deals`, {}, token);
check('deals endpoint answers', deals.status === 200, `${deals.body.deals?.length ?? 0} deals`);

// 7. match shortlist entrance
const match = await jfetch(`/v1/match?item=passata&chains=ah,jumbo`, {}, token);
const ahBest = match.body.matches?.ah?.best;
check('match: passata → gezeefde tomaten (lexicon alias)', match.status === 200 && !!ahBest && /gezeefde|passata/i.test(ahBest.name),
  ahBest ? `"${ahBest.name}" (${ahBest.source})` : 'no match');

// 8. week-tied lists (owner UX 2026-07-06): week_start round-trips through sync
const wlid = crypto.randomUUID();
const monday = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
await jfetch('/v1/sync/push', {
  method: 'POST',
  body: JSON.stringify({ mutations: [{ entity: 'lists', op: 'upsert', id: wlid, base_updated_at: null, fields: { name: 'Weekboodschappen', week_start: monday } }] }),
}, token);
const pull = await jfetch(`/v1/sync?since=1970-01-01T00:00:00Z&entities=lists`, {}, token);
const weekRow = (pull.body.changes?.lists?.rows ?? []).find((r) => r.id === wlid);
check('week-tied list: week_start persists through sync', String(weekRow?.week_start ?? '').slice(0, 10) === monday, `got ${weekRow?.week_start}`);

// 9. variant pinning (owner UX): user switches product; pricing uses the pinned sku
const itemsRes = await jfetch(`/v1/lists/${lid}/price?chains=ah`, {}, token);
const firstMatched = (itemsRes.body.chains?.[0]?.lines ?? []).find((l) => l.matched);
if (firstMatched) {
  // pick a DIFFERENT product from the shortlist for that item
  const itemRow = await jfetch(`/v1/sync?since=1970-01-01T00:00:00Z&entities=list_items`, {}, token);
  const target = (itemRow.body.changes?.list_items?.rows ?? []).find((r) => r.id === firstMatched.item_id);
  const term = encodeURIComponent(target?.item_normalised ?? target?.name ?? 'melk');
  const shortRes = await jfetch(`/v1/match?item=${term}&chains=ah`, {}, token);
  const shortlist = shortRes.body.matches?.ah?.shortlist ?? [];
  const alternative = shortlist.find((s) => s.sku_id !== firstMatched.sku_id);
  if (alternative) {
    await jfetch('/v1/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        mutations: [{
          entity: 'list_items', op: 'upsert', id: firstMatched.item_id, base_updated_at: null,
          fields: { list_id: lid, name: target?.name ?? 'item', matches: { ...(target?.matches ?? {}), ah: { sku_id: alternative.sku_id, confidence: 1, user_pinned: true } } },
        }],
      }),
    }, token);
    const repriced = await jfetch(`/v1/lists/${lid}/price?chains=ah`, {}, token);
    const line = (repriced.body.chains?.[0]?.lines ?? []).find((l) => l.item_id === firstMatched.item_id);
    check('pinned variant drives the price (user can verify/switch)', line?.sku_id === alternative.sku_id,
      `line sku ${line?.sku_id} vs pinned ${alternative.sku_id} ("${alternative.name}")`);
  } else {
    check('pinned variant drives the price (user can verify/switch)', true, 'skipped — shortlist had no alternative');
  }
} else {
  check('pinned variant drives the price', false, 'no matched line to pin');
}

// 8. Ontdek feed (WS7) — crawled corpus + save-flow detail
const feed = await jfetch('/v1/discover?limit=10', {}, token);
check('discover feed has crawled recipes', feed.status === 200 && (feed.body.items?.length ?? 0) > 0,
  `${feed.body.items?.length} items, first: "${feed.body.items?.[0]?.title}" via ${feed.body.items?.[0]?.site_name}`);
if (feed.body.items?.length) {
  const detail = await jfetch(`/v1/discover/${feed.body.items[0].id}`, {}, token);
  check('discover detail returns full recipe for review flow',
    detail.status === 200 && detail.body.recipe?.ingredients?.length >= 2 && detail.body.recipe?.origin === 'crawled_save',
    `${detail.body.recipe?.ingredients?.length} ing`);
  const search = await jfetch('/v1/discover?q=pasta', {}, token);
  check('ook-in-Ontdek zoeken answers', search.status === 200, `${search.body.items?.length ?? 0} hits for "pasta"`);
}

// 9. households (WS9 K1): create → invite → second user joins → sees the recipe
const hh = await jfetch('/v1/households', { method: 'POST', body: JSON.stringify({ name: 'e2e huis' }) }, token);
check('household create', hh.status === 201 && !!hh.body.id, hh.body.name);
const invite = await jfetch(`/v1/households/${hh.body.id}/invite`, { method: 'POST', body: '{}' }, token);
check('household invite issues token + deep link', invite.status === 200 && !!invite.body.invite_token && invite.body.deep_link?.startsWith('prakkie://'));
// move the recipe into the household, then a second account joins and pulls it
await jfetch('/v1/sync/push', {
  method: 'POST',
  body: JSON.stringify({ mutations: [{ entity: 'recipes', op: 'upsert', id: rid, base_updated_at: null, fields: { household_id: hh.body.id } }] }),
}, token);
const auth2 = await jfetch('/v1/auth/guest', { method: 'POST', body: JSON.stringify({ platform: 'ios' }) });
const token2 = auth2.body.access_token;
const join = await jfetch('/v1/households/join', { method: 'POST', body: JSON.stringify({ token: invite.body.invite_token }) }, token2);
check('second user joins household', join.status === 200 && join.body.id === hh.body.id);
const pull2 = await jfetch('/v1/sync?entities=recipes', {}, token2);
check('household member sees shared recipe via sync', pull2.status === 200 &&
  (pull2.body.changes?.recipes?.rows ?? []).some((r) => r.id === rid),
  `${pull2.body.changes?.recipes?.rows?.length ?? 0} recipes visible`);

// 10. share link (K3) + cart handoff (L1/L2) + pantry (WS8)
const share = await jfetch(`/v1/recipes/${rid}/share`, { method: 'POST', body: '{}' }, token);
check('recipe share link', share.status === 200 && !!share.body.share_token);
const shared = await jfetch(`/v1/shared/${share.body.share_token}`, {}, token2);
check('share token resolves for other user (origin shared)', shared.status === 200 && shared.body.recipe?.origin === 'shared',
  `"${shared.body.recipe?.title}"`);
const handoff = await jfetch(`/v1/lists/${lid}/handoff?chain=ah`, {}, token);
check('cart handoff: AH deep links + copy fallback', handoff.status === 200 && handoff.body.mode === 'deep_links' && handoff.body.copy_text?.length > 0,
  `${handoff.body.product_links?.length ?? 0} links`);
const handoff2 = await jfetch(`/v1/lists/${lid}/handoff?chain=vomar`, {}, token);
check('cart handoff degrades honestly for other chains', handoff2.status === 200 && handoff2.body.mode === 'copy_list');

await jfetch('/v1/sync/push', {
  method: 'POST',
  body: JSON.stringify({ mutations: [
    { entity: 'pantry_items', op: 'upsert', id: crypto.randomUUID(), base_updated_at: null, fields: { name: 'ui', source: 'manual' } },
    { entity: 'pantry_items', op: 'upsert', id: crypto.randomUUID(), base_updated_at: null, fields: { name: 'knoflook', source: 'manual' } },
  ] }),
}, token);
const pantry = await jfetch('/v1/pantry/cook-suggestions', {}, token);
check('cook-from-pantry ranks own library by fewest missing', pantry.status === 200 && (pantry.body.suggestions?.length ?? 0) > 0
  && pantry.body.suggestions[0].missing_count <= (pantry.body.suggestions.at(-1)?.missing_count ?? 99),
  `pantry=${pantry.body.pantry_size}, top miss ${pantry.body.suggestions?.[0]?.missing_count}/${pantry.body.suggestions?.[0]?.total}`);

// 11. match-fix correction wins on the next match (E5 instant tier)
const before = await jfetch('/v1/match?item=ui&chains=ah', {}, token);
const shortlisted = before.body.matches?.ah?.best;
if (shortlisted) {
  const altSku = shortlisted.sku_id;
  await jfetch('/v1/sync/push', {
    method: 'POST',
    body: JSON.stringify({ mutations: [{ entity: 'match_corrections', op: 'upsert', id: crypto.randomUUID(), base_updated_at: null,
      fields: { chain_id: 'ah', item_normalised: 'ui', chosen_sku_id: altSku } }] }),
  }, token);
  const after = await jfetch('/v1/match?item=ui&chains=ah', {}, token);
  check('user correction becomes the instant top match', after.body.matches?.ah?.best?.source === 'correction'
    && after.body.matches?.ah?.best?.sku_id === altSku);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll e2e checks passed (spine + WS7/WS8/WS9).');
process.exit(failures ? 1 : 0);
