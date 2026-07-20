-- Preserve the consciously selected catalog image for loose planner products.
ALTER TABLE app.plan_entries ADD COLUMN IF NOT EXISTS image_url text;
