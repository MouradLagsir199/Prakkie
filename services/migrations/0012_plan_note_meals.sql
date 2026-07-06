-- 0012: note meals — plan a week without a recipe ("uit eten", "restjes")
-- UX-audit P3 (plan/11 §Plannen): plan_entries.recipe_id becomes optional,
-- a free-text title carries the meal instead. At least one of the two must be set.

ALTER TABLE app.plan_entries ALTER COLUMN recipe_id DROP NOT NULL;
ALTER TABLE app.plan_entries ADD COLUMN IF NOT EXISTS title text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_plan_entries_recipe_or_title'
      AND conrelid = 'app.plan_entries'::regclass
  ) THEN
    ALTER TABLE app.plan_entries
      ADD CONSTRAINT chk_plan_entries_recipe_or_title
      CHECK (recipe_id IS NOT NULL OR title IS NOT NULL);
  END IF;
END $$;
