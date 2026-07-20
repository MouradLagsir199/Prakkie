-- 0024 — huishouden-beheer + profielfoto's (owner 2026-07-07 avond):
--  * rollen worden rechten: owner (admin) / editor (mag bewerken) / viewer
--    (alleen lezen). Bestaande 'member'-leden konden altijd bewerken → editor.
--    Enforcement zit in sync-push (viewer-schrijfguard) en list-ops.
--  * users.avatar_url: publieke blob-URL (container 'avatars'), gezet via
--    POST /v1/me/avatar.

ALTER TABLE app.users ADD COLUMN IF NOT EXISTS avatar_url text;

ALTER TABLE app.household_members DROP CONSTRAINT IF EXISTS household_members_role_check;
UPDATE app.household_members SET role = 'editor' WHERE role = 'member';
ALTER TABLE app.household_members
  ADD CONSTRAINT household_members_role_check
  CHECK (role IN ('owner', 'editor', 'viewer'));
ALTER TABLE app.household_members ALTER COLUMN role SET DEFAULT 'editor';
