-- 0001 — extensions, schemas, shared helper functions (plan/04_data-model.md)
-- Extensions must be on the server allow-list (infra/modules/postgres.bicep: VECTOR,PG_TRGM,UNACCENT,CITEXT).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS discovery;

-- Server-authoritative updated_at on every synced table: the sync pull cursor
-- (plan/04 §5) orders by updated_at, so clients may never set it themselves.
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

-- Extracts lowercased item_normalised join keys from a B8 ingredients array.
-- Declared IMMUTABLE so it can back GENERATED columns (depends only on input).
CREATE OR REPLACE FUNCTION public.jsonb_ingredient_keys(ingredients jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT lower(e->>'item_normalised')), '{}'::text[])
  FROM jsonb_array_elements(coalesce(ingredients, '[]'::jsonb)) AS e
  WHERE coalesce(e->>'item_normalised', '') <> ''
$$;

-- array_to_string is only STABLE; this trusted-immutable wrapper lets tsvector
-- GENERATED columns include tag arrays.
CREATE OR REPLACE FUNCTION public.imm_join(arr text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_to_string(arr, ' '), '')
$$;
