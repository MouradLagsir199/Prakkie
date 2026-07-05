-- 0011 — recipe price precompute writes from the API app (WS7 badge pipeline).
-- The matcher (corrections → lexicon → trgm) lives API-side, so the
-- price-per-portion precompute runs there; it needs write access to the two
-- discovery pricing tables only. Everything else in discovery stays read-only.

GRANT INSERT, UPDATE, DELETE ON discovery.recipe_prices TO prakkie_app;
