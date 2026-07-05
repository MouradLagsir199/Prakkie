// End-to-end smoke test for the /v1 API against a live environment (WS1 acceptance).
// Usage: node scripts/api-smoke.mjs --env dev
// Exercises: guest auth → settings → recipe/list/plan CRUD → sync pull/push
// (incl. an LWW conflict) → refresh rotation + reuse detection → guest upgrade
// (id preserved) → logout. Creates its own throwaway user; cleans nothing else.

const env = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : 'dev';
const BASE = `https://func-prakkie-api-${env}.azurewebsites.net/api`;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

async function call(method, path, { body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 204s */
  }
  return { status: res.status, body: json };
}

console.log(`Smoke-testing ${BASE}\n--- auth: guest ---`);
const guest = await call('POST', '/v1/auth/guest', { body: { platform: 'ios' } });
check('guest 201', guest.status === 201, `got ${guest.status}: ${JSON.stringify(guest.body)}`);
const { access_token: at1, refresh_token: rt1, user } = guest.body;
check('guest user is_guest', user?.is_guest === true);

console.log('--- me ---');
const patched = await call('PATCH', '/v1/me', {
  token: at1,
  body: { display_name: 'Smoke Tester', home_chain_ids: ['jumbo', 'ah'], default_servings: 4 },
});
check('PATCH /me 200', patched.status === 200, JSON.stringify(patched.body));
check('settings persisted', patched.body?.default_servings === 4 && patched.body?.home_chain_ids?.[0] === 'jumbo');
check('unauthenticated /me 401', (await call('GET', '/v1/me')).status === 401);

console.log('--- recipes CRUD ---');
const recipe = await call('POST', '/v1/recipes', {
  token: at1,
  body: {
    title: 'Shakshuka smoke',
    origin: 'manual',
    servings_base: 2,
    ingredients: [
      { raw_text: '2 bosuien', quantity: 2, unit: null, item_normalised: 'bosui', note: null, confidence: 1 },
    ],
    steps: [{ order: 1, text: 'Snijd de bosui en laat 20 min sudderen.' }],
    tags: ['snel'],
  },
});
check('POST recipe 201', recipe.status === 201, JSON.stringify(recipe.body));
const recipeId = recipe.body?.id;
check('generated ingredient_keys', recipe.body?.ingredient_keys?.includes('bosui'));
const updatedRecipe = await call('PATCH', `/v1/recipes/${recipeId}`, { token: at1, body: { cuisine: 'midden-oosters' } });
check('PATCH recipe applies', updatedRecipe.body?.cuisine === 'midden-oosters');
const search = await call('GET', '/v1/recipes?q=shakshuka', { token: at1 });
check('FTS search finds it', search.body?.items?.some((r) => r.id === recipeId));

console.log('--- lists + items ---');
const list = await call('POST', '/v1/lists', { token: at1, body: { name: 'Weekend', layout_chain_id: 'jumbo' } });
check('POST list 201', list.status === 201, JSON.stringify(list.body));
const item = await call('POST', '/v1/list-items', {
  token: at1,
  body: { list_id: list.body?.id, name: 'bosui', quantity: 2, is_manual: true },
});
check('POST list item 201', item.status === 201, JSON.stringify(item.body));

console.log('--- plans ---');
const plan = await call('POST', '/v1/plans', { token: at1, body: { week_start: '2026-07-06' } });
check('POST plan 201', plan.status === 201, JSON.stringify(plan.body));
const entry = await call('POST', '/v1/plan-entries', {
  token: at1,
  body: { plan_id: plan.body?.id, recipe_id: recipeId, entry_date: '2026-07-07', servings: 4 },
});
check('POST plan entry 201', entry.status === 201, JSON.stringify(entry.body));

console.log('--- sync pull ---');
const since = new Date(Date.now() - 60_000).toISOString();
const pull = await call('GET', `/v1/sync?since=${encodeURIComponent(since)}&entities=recipes,lists,list_items,plans,plan_entries`, { token: at1 });
check('pull 200', pull.status === 200, JSON.stringify(pull.body).slice(0, 300));
check('pull sees recipe', pull.body?.changes?.recipes?.rows?.some((r) => r.id === recipeId));
check('pull sees list item', pull.body?.changes?.list_items?.rows?.length >= 1);

console.log('--- sync push: offline-created row + LWW conflict ---');
const offlineId = crypto.randomUUID();
const push1 = await call('POST', '/v1/sync/push', {
  token: at1,
  body: {
    mutations: [
      {
        entity: 'list_items',
        op: 'upsert',
        id: offlineId,
        fields: { list_id: list.body?.id, name: 'kikkererwten', quantity: 1, checked: true },
        base_updated_at: null,
      },
    ],
  },
});
const r1 = push1.body?.results?.[0];
check('offline insert applied', r1?.status === 'applied', JSON.stringify(push1.body));
check('checked_by is server-set', r1?.row?.checked_by === user?.id);
// stale write (old base): name group should still win per LWW-per-group; checked survives server-side
const push2 = await call('POST', '/v1/sync/push', {
  token: at1,
  body: {
    mutations: [
      {
        entity: 'list_items',
        op: 'upsert',
        id: offlineId,
        fields: { name: 'kikkererwten in blik', quantity: 2, unit: 'blik' },
        base_updated_at: '2020-01-01T00:00:00Z',
      },
    ],
  },
});
const r2 = push2.body?.results?.[0];
check('conflict detected', r2?.status === 'conflict_applied', JSON.stringify(push2.body));
check('name group applied', r2?.row?.name === 'kikkererwten in blik' && r2?.row?.unit === 'blik');
check('checked untouched by conflict', r2?.row?.checked === true);
const pushForbidden = await (async () => {
  const stranger = await call('POST', '/v1/auth/guest', { body: { platform: 'android' } });
  return call('POST', '/v1/sync/push', {
    token: stranger.body?.access_token,
    body: { mutations: [{ entity: 'list_items', op: 'upsert', id: offlineId, fields: { name: 'gekaapt' }, base_updated_at: null }] },
  });
})();
check('foreign row is forbidden', pushForbidden.body?.results?.[0]?.status === 'forbidden', JSON.stringify(pushForbidden.body));

console.log('--- refresh rotation + reuse detection ---');
const refreshed = await call('POST', '/v1/auth/refresh', { body: { refresh_token: rt1 } });
check('refresh 200', refreshed.status === 200, JSON.stringify(refreshed.body).slice(0, 200));
const rt2 = refreshed.body?.refresh_token;
check('token rotated', rt2 && rt2 !== rt1);
const reuse = await call('POST', '/v1/auth/refresh', { body: { refresh_token: rt1 } });
check('old token reuse → 401', reuse.status === 401 && reuse.body?.error === 'refresh_reuse_detected', JSON.stringify(reuse.body));
const afterRevoke = await call('POST', '/v1/auth/refresh', { body: { refresh_token: rt2 } });
check('family revoked after reuse', afterRevoke.status === 401);

console.log('--- guest upgrade preserves user id ---');
const email = `smoke-${Date.now()}@prakkie.test`;
const upgraded = await call('POST', '/v1/auth/upgrade', {
  token: refreshed.body?.access_token ?? at1,
  body: { email, password: 'sm0ke-Wachtwoord!', display_name: 'Upgraded Tester' },
});
check('upgrade 200', upgraded.status === 200, JSON.stringify(upgraded.body).slice(0, 300));
check('user id preserved', upgraded.body?.user?.id === user?.id, `${upgraded.body?.user?.id} vs ${user?.id}`);
check('no longer guest', upgraded.body?.user?.is_guest === false);
const login = await call('POST', '/v1/auth/login', { body: { email, password: 'sm0ke-Wachtwoord!', platform: 'web' } });
check('email login works post-upgrade', login.status === 200 && login.body?.user?.id === user?.id);
check('recipe survives across sessions', (await call('GET', `/v1/recipes/${recipeId}`, { token: login.body?.access_token })).status === 200);
const badLogin = await call('POST', '/v1/auth/login', { body: { email, password: 'verkeerd-wachtwoord', platform: 'web' } });
check('wrong password 401', badLogin.status === 401);

console.log('--- providers unconfigured → 501 ---');
check('apple 501', (await call('POST', '/v1/auth/apple', { body: { id_token: 'x', platform: 'ios' } })).status === 501);
check('google 501', (await call('POST', '/v1/auth/google', { body: { id_token: 'x', platform: 'android' } })).status === 501);

console.log('--- logout ---');
const logoutToken = login.body?.access_token;
check('logout 204', (await call('POST', '/v1/auth/logout', { token: logoutToken })).status === 204);
check('refresh after logout 401', (await call('POST', '/v1/auth/refresh', { body: { refresh_token: login.body?.refresh_token } })).status === 401);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
