-- 0028 — drie owner-besluiten van 2026-07-10:
--   1. Boodschappen is één vaste lijst, niet per datum: lists.is_current markeert
--      dé actuele lijst van de gebruiker/het huishouden. Gedateerde lijsten
--      blijven bestaan als legacy maar de app toont ze niet meer.
--   2. Weekplanning accepteert alleen nog recepten of losse cataloog-producten
--      (geen vrije tekst): product-entries dragen quantity + unit zodat de
--      import naar het boodschappenlijstje kloppende hoeveelheden meeneemt.
--   3. Vierde AI-actie 'generate' (recept genereren bij lege zoekresultaten) in
--      het ai_usage-quotum.

ALTER TABLE app.lists ADD COLUMN is_current boolean NOT NULL DEFAULT false;

ALTER TABLE app.plan_entries ADD COLUMN quantity numeric,
                             ADD COLUMN unit text;

ALTER TABLE app.ai_usage DROP CONSTRAINT ai_usage_kind_check;
ALTER TABLE app.ai_usage ADD CONSTRAINT ai_usage_kind_check
  CHECK (kind IN ('prakkie', 'import', 'enrich', 'generate'));
