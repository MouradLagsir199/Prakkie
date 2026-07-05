-- 0006 — least-privilege grants (plan/06_iac.md: app + ingest roles, admin only for migrations)
-- Roles prakkie_app / prakkie_ingest are created by scripts/db-migrate.mjs (passwords
-- come from Key Vault and can never live in a committed SQL file).

GRANT USAGE ON SCHEMA app, catalog, discovery TO prakkie_app;
GRANT USAGE ON SCHEMA app, catalog, discovery TO prakkie_ingest;

-- API app: owns app.*, reads catalog + discovery
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO prakkie_app;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO prakkie_app;
GRANT SELECT ON ALL TABLES IN SCHEMA discovery TO prakkie_app;

-- Ingest app: owns catalog + discovery; app-side access limited to the E5 loop
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA catalog TO prakkie_ingest;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA discovery TO prakkie_ingest;
GRANT SELECT ON app.match_corrections TO prakkie_ingest;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.match_overrides_agg TO prakkie_ingest;

-- future tables created by the migration-running admin inherit the same shape
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prakkie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT ON TABLES TO prakkie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA discovery GRANT SELECT ON TABLES TO prakkie_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prakkie_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA discovery GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prakkie_ingest;
