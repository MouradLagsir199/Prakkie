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

console.log(failures ? `\n${failures} FAILED` : '\nAll e2e spine checks passed.');
process.exit(failures ? 1 : 0);
