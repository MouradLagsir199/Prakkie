-- 0013: household e-mail invites + list-item attribution (owner directives 2026-07-06)
--   * invite household members by e-mail address (accepted when that e-mail
--     registers/logs in and taps accept) — replaces link-only invites in the UI
--   * list_items.added_by: who added what (Boodschappen tab shows the log)

CREATE TABLE IF NOT EXISTS app.household_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE CASCADE,
  email        text NOT NULL,
  invited_by   uuid NOT NULL REFERENCES app.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz
);
-- one open invite per (household, email)
CREATE UNIQUE INDEX IF NOT EXISTS uq_household_invites_open
  ON app.household_invites (household_id, lower(email)) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_household_invites_email ON app.household_invites (lower(email));

ALTER TABLE app.list_items ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES app.users(id);
