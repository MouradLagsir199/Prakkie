-- 0007 — read-only backup role for the nightly logical dump (WS1 durability).
-- prakkie_backup is created by scripts/db-migrate.mjs (password from Key Vault);
-- it can SELECT everything and write nothing — the dump timer in the ingest app
-- is its only user.

GRANT USAGE ON SCHEMA app, catalog, discovery TO prakkie_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO prakkie_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO prakkie_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA discovery TO prakkie_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO prakkie_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT ON TABLES TO prakkie_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA discovery GRANT SELECT ON TABLES TO prakkie_backup;
