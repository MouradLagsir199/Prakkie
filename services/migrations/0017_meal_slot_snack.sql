-- 0017 — Plannen krijgt maaltijd-categorieën in de UI (ontbijt/lunch/avondeten/
-- tussendoor). 'snack' = tussendoortje; de bestaande CHECK kende alleen de
-- eerste drie. Shared zod (packages/shared/src/plan.ts) is de spiegel.

ALTER TABLE app.plan_entries DROP CONSTRAINT IF EXISTS plan_entries_meal_slot_check;
ALTER TABLE app.plan_entries
  ADD CONSTRAINT plan_entries_meal_slot_check
  CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack'));
