-- 0027 — één quotum-tabel voor alle drie de AI-acties (owner 2026-07-10):
--   'prakkie'  = Vind mijn prakkie (was app.prakkie_searches)
--   'import'   = recept importeren (parse-LLM; URL-cache-hits tellen niet)
--   'enrich'   = "Vul het recept aan" (gaten in een geïmporteerd recept vullen)
-- Limieten leven in code (lib/ai-quota.ts): €2,99-plan 100/30/30 per maand,
-- proefperiode (tier 'free', eerste 30 dagen) de helft. Er is géén onbeperkte tier.

CREATE TABLE app.ai_usage (
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  month   date NOT NULL,                    -- eerste dag van de kalendermaand
  kind    text NOT NULL CHECK (kind IN ('prakkie', 'import', 'enrich')),
  used    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month, kind)
);

INSERT INTO app.ai_usage (user_id, month, kind, used)
SELECT user_id, month, 'prakkie', used FROM app.prakkie_searches;

DROP TABLE app.prakkie_searches;

-- import kan nu ook op een op-quotum stranden — de status-poll moet dat
-- eerlijk kunnen zeggen
ALTER TABLE app.import_jobs DROP CONSTRAINT import_jobs_failure_kind_check;
ALTER TABLE app.import_jobs ADD CONSTRAINT import_jobs_failure_kind_check
  CHECK (failure_kind IN ('unusable_422', 'transient_503', 'quota_exceeded', 'trial_expired'));

GRANT SELECT, INSERT, UPDATE, DELETE ON app.ai_usage TO prakkie_app;
