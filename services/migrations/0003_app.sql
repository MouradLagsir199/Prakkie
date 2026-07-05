-- 0003 — schema app (all synced, all in the GDPR export) — plan/04 §1
-- Conventions: uuid PKs (UUIDv7, client-generatable); money = integer cents;
-- every synced table carries created_at, trigger-maintained updated_at, deleted_at tombstone.

CREATE TABLE app.users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext UNIQUE,          -- NULL for guests
  apple_sub        text UNIQUE,
  google_sub       text UNIQUE,
  password_hash    text,
  display_name     text,
  is_guest         boolean NOT NULL DEFAULT false,
  locale           text NOT NULL DEFAULT 'nl' CHECK (locale IN ('nl', 'en')),
  units            text NOT NULL DEFAULT 'metric' CHECK (units IN ('metric', 'imperial')),
  default_servings integer NOT NULL DEFAULT 2 CHECK (default_servings > 0),
  diet_flags       text[] NOT NULL DEFAULT '{}',
  home_chain_ids   text[] NOT NULL DEFAULT '{ah}',  -- first entry = "jouw winkel"
  purge_after      timestamptz,            -- account delete: 30-day grace, then nightly purge
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE app.devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  push_token         text,
  -- rotating refresh token (ADR-0004): only the sha256 of the current token is
  -- stored; a well-formed token for this device with a stale hash = reuse → revoke
  refresh_token_hash text,
  refresh_family     uuid NOT NULL DEFAULT gen_random_uuid(),
  revoked_at         timestamptz,
  notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_devices_user ON app.devices (user_id);

CREATE TABLE app.households (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE app.household_members (
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX idx_household_members_user ON app.household_members (user_id);

CREATE TABLE app.recipes (
  id              uuid PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES app.users(id),
  household_id    uuid REFERENCES app.households(id),
  title           text NOT NULL,
  origin          text NOT NULL CHECK (origin IN ('import', 'manual', 'crawled_save', 'shared')),
  source_url      text,
  source_platform text,
  source_author   text,                    -- bron blijft bewaard (spec §C6)
  images          jsonb NOT NULL DEFAULT '[]'::jsonb,
  servings_base   integer NOT NULL DEFAULT 2 CHECK (servings_base > 0),
  time_prep_min   integer,
  time_cook_min   integer,
  ingredients     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- B8: [{raw_text,quantity,unit,item_normalised,note,confidence}]
  steps           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- B8: [{order,text,timer_seconds?}]
  nutrition       jsonb,
  missing_fields  text[] NOT NULL DEFAULT '{}',
  tags            text[] NOT NULL DEFAULT '{}',
  cuisine         text,
  diet_flags      text[] NOT NULL DEFAULT '{}',
  ingredient_keys text[] GENERATED ALWAYS AS (public.jsonb_ingredient_keys(ingredients)) STORED,
  search_tsv      tsvector GENERATED ALWAYS AS (
                    to_tsvector('dutch',
                      coalesce(title, '') || ' ' || public.imm_join(tags) || ' ' || coalesce(cuisine, ''))
                  ) STORED,
  price_cache     jsonb,                   -- 24h TTL, written by list-price
  last_cooked_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_recipes_ingredient_keys ON app.recipes USING gin (ingredient_keys);
CREATE INDEX idx_recipes_search ON app.recipes USING gin (search_tsv);
CREATE INDEX idx_recipes_owner_updated ON app.recipes (owner_id, updated_at);
CREATE INDEX idx_recipes_household_updated ON app.recipes (household_id, updated_at) WHERE household_id IS NOT NULL;

CREATE TABLE app.recipe_collections (
  id           uuid PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES app.users(id),
  household_id uuid REFERENCES app.households(id),
  name         text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX idx_collections_owner_updated ON app.recipe_collections (owner_id, updated_at);

CREATE TABLE app.collection_membership (
  collection_id uuid NOT NULL REFERENCES app.recipe_collections(id) ON DELETE CASCADE,
  recipe_id     uuid NOT NULL REFERENCES app.recipes(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, recipe_id)
);

-- C5: one writer per row — household members can never overwrite each other's notes
CREATE TABLE app.recipe_notes (
  id            uuid PRIMARY KEY,
  recipe_id     uuid NOT NULL REFERENCES app.recipes(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  note_text     text NOT NULL DEFAULT '',
  modifications jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (recipe_id, user_id)
);

CREATE TABLE app.lists (
  id              uuid PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES app.users(id),
  household_id    uuid REFERENCES app.households(id),
  name            text NOT NULL,
  layout_chain_id text NOT NULL DEFAULT 'ah' REFERENCES catalog.chains(id),  -- "AH-indeling" chip
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_lists_owner_updated ON app.lists (owner_id, updated_at);
CREATE INDEX idx_lists_household_updated ON app.lists (household_id, updated_at) WHERE household_id IS NOT NULL;

CREATE TABLE app.list_items (
  id              uuid PRIMARY KEY,
  list_id         uuid NOT NULL REFERENCES app.lists(id) ON DELETE CASCADE,
  name            text NOT NULL,
  quantity        numeric,
  unit            text,
  item_normalised text,
  aisle_group_id  smallint REFERENCES catalog.aisle_taxonomy(id),  -- user-overridable (G3)
  sort_order      integer NOT NULL DEFAULT 0,
  is_manual       boolean NOT NULL DEFAULT false,  -- manual lines are never clobbered by plan re-derive (G4)
  provenance      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- "samengevoegd: shakshuka (1) + nasi (2)"
  matches         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {chain_id:{sku_id,confidence,user_pinned}}
  checked         boolean NOT NULL DEFAULT false,
  checked_by      uuid REFERENCES app.users(id),
  checked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_list_items_sync ON app.list_items (list_id, updated_at);  -- sync hot path

CREATE TABLE app.plans (
  id                  uuid PRIMARY KEY,
  owner_id            uuid NOT NULL REFERENCES app.users(id),
  household_id        uuid REFERENCES app.households(id),
  week_start          date NOT NULL,  -- Monday of the ISO week
  applied_template_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
-- UNIQUE(scope, week_start): scope = household when set, else the owner
CREATE UNIQUE INDEX uq_plans_household_week ON app.plans (household_id, week_start)
  WHERE household_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_plans_owner_week ON app.plans (owner_id, week_start)
  WHERE household_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_plans_owner_updated ON app.plans (owner_id, updated_at);

CREATE TABLE app.plan_entries (
  id         uuid PRIMARY KEY,
  plan_id    uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  recipe_id  uuid NOT NULL REFERENCES app.recipes(id),
  entry_date date,                    -- NULL = the "Zonder datum" strip (H3)
  meal_slot  text NOT NULL DEFAULT 'dinner' CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner')),
  servings   integer NOT NULL CHECK (servings > 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_plan_entries_sync ON app.plan_entries (plan_id, updated_at);

CREATE TABLE app.plan_templates (
  id           uuid PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES app.users(id),
  household_id uuid REFERENCES app.households(id),
  name         text NOT NULL,
  entries      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{weekday|null,meal_slot,recipe_id,servings}]
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX idx_plan_templates_owner_updated ON app.plan_templates (owner_id, updated_at);

CREATE TABLE app.pantry_items (
  id              uuid PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES app.users(id),
  household_id    uuid REFERENCES app.households(id),
  name            text NOT NULL,
  item_normalised text,
  quantity        numeric,
  unit            text,
  ean             text,
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'purchased', 'barcode')),
  expires_at      date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_pantry_owner_updated ON app.pantry_items (owner_id, updated_at);

-- per-user override, wins at match time (E5)
CREATE TABLE app.match_corrections (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  chain_id        text NOT NULL REFERENCES catalog.chains(id),
  item_normalised text NOT NULL,
  chosen_sku_id   text NOT NULL,
  rejected_sku_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, chain_id, item_normalised)
);

-- nightly rebuilt aggregate (E5 learning loop; written by the ingest app)
CREATE TABLE app.match_overrides_agg (
  chain_id        text NOT NULL,
  item_normalised text NOT NULL,
  sku_id          text NOT NULL,
  votes           integer NOT NULL DEFAULT 0,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, item_normalised, sku_id)
);

CREATE TABLE app.import_jobs (
  id             uuid PRIMARY KEY,       -- = the importId returned by the 202
  user_id        uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source_url     text NOT NULL,
  url_hash       text NOT NULL,
  platform       text,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'scraping', 'transcribing', 'parsing', 'ready', 'failed')),
  failure_kind   text CHECK (failure_kind IN ('unusable_422', 'transient_503')),
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_recipe  jsonb,
  apify_cost_usd numeric(8, 4) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_jobs_user ON app.import_jobs (user_id, created_at);
CREATE INDEX idx_import_jobs_url_hash ON app.import_jobs (url_hash);

CREATE TABLE app.subscriptions (
  user_id      uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  tier         text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'premium', 'lifetime')),
  store        text,
  store_txn_id text,
  status       text,
  valid_until  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- monthly quota enforcement (video/OCR imports, spec §20)
CREATE TABLE app.usage_counters (
  user_id       uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  period        text NOT NULL,  -- 'YYYYMM'
  video_imports integer NOT NULL DEFAULT 0,
  ocr_imports   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

CREATE TABLE app.export_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('gdpr_export', 'account_delete')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  blob_path    text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at   timestamptz
);

-- updated_at is server-authoritative on every synced table (sync cursor integrity)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'devices', 'households', 'recipes', 'recipe_collections', 'recipe_notes',
    'lists', 'list_items', 'plans', 'plan_entries', 'plan_templates', 'pantry_items',
    'match_corrections', 'import_jobs', 'subscriptions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t, t);
  END LOOP;
END $$;
