-- 0021 — twee owner-verzoeken (2026-07-07 avond):
--  1. Lijst delen met losse huisgenoten: app.lists.shared_with uuid[] — leden
--     in die array zien de lijst (en zijn items) ook zonder household_id.
--     "Deel met huishouden" blijft via household_id lopen.
--  2. Slimmere Ontdek-zoek: substring-matching op titel ("cake" → "Oranje
--     cake", "appelcake") naast de bestaande tsvector — trgm-index maakt
--     ILIKE '%…%' en similarity() op 1.6k+ recepten instant.

ALTER TABLE app.lists ADD COLUMN IF NOT EXISTS shared_with uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_lists_shared_with ON app.lists USING gin (shared_with);

CREATE INDEX IF NOT EXISTS idx_crawled_title_trgm
  ON discovery.crawled_recipes USING gin (title public.gin_trgm_ops);
