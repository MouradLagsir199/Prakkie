-- 0011 — owner UX decision (2026-07-06): every shopping list is tied to a week
-- ("weekly list with calendar view"); the Lijst tab groups lists per week.
-- Nullable for legacy rows; the app always sets it (Monday of the ISO week).

ALTER TABLE app.lists ADD COLUMN IF NOT EXISTS week_start date;
CREATE INDEX IF NOT EXISTS idx_lists_week ON app.lists (week_start) WHERE deleted_at IS NULL;
