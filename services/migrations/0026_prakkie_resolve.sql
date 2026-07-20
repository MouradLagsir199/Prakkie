-- 0026 — "Vind mijn prakkie" (AI-resolver, plan 2026-07-08):
--   1. catalog.ai_resolve_cache: één AI-productkeuze per (genormaliseerd item ×
--      keten × model). De meeste mensen kopen wekelijks hetzelfde — cache-hits
--      zijn gratis en tellen niet mee voor het maandquotum. TTL zit in code
--      (verse keuze na 7 dagen of als de sku uit het assortiment valt).
--   2. app.prakkie_searches: quotum-teller per gebruiker per kalendermaand.
--      Eén tik op "Vind mijn prakkie" met ≥1 on-gecacht item = 1 zoekopdracht.

CREATE TABLE catalog.ai_resolve_cache (
  item_normalised text NOT NULL,
  chain_id        text NOT NULL REFERENCES catalog.chains(id),
  model           text NOT NULL,
  sku_id          text,                     -- NULL = model zei "niets past hier"
  resolved_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_normalised, chain_id, model)
);

CREATE TABLE app.prakkie_searches (
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  month   date NOT NULL,                    -- eerste dag van de kalendermaand
  used    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.ai_resolve_cache TO prakkie_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.prakkie_searches TO prakkie_app;
