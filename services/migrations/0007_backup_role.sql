-- 0007 — read-only backup role for the nightly logical dump (WS1 durability).
-- Created NOLOGIN here; scripts/db-migrate.mjs grants LOGIN + the Key Vault
-- password once the backup timer ships (deferred by owner 2026-07-06). It can
-- SELECT everything and write nothing.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prakkie_backup') THEN
    CREATE ROLE prakkie_backup NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app, catalog, discovery TO prakkie_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO prakkie_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO prakkie_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA discovery TO prakkie_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO prakkie_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT ON TABLES TO prakkie_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA discovery GRANT SELECT ON TABLES TO prakkie_backup;
