-- Activate the newly implemented supermarket catalog connectors.
--
-- Picnic remains kill-switched until the account-bound scraper has completed
-- at least one real import. Exposing an empty chain would let users start a
-- composition they cannot finish. Its connector/schema entry is nevertheless
-- kept current here, ready for that first authenticated run.

INSERT INTO catalog.chains
  (id, display_name, connector, full_assortment, enabled)
VALUES
  ('dekamarkt', 'DekaMarkt',  'detailresult', true,  true),
  ('vomar',     'Vomar',      'vomar',        true,  true),
  ('hoogvliet', 'Hoogvliet',  'hoogvliet',    true,  true),
  ('picnic',    'Picnic',     'picnic',       false, false),
  ('ekoplaza',  'Ekoplaza',   'ekoplaza',     true,  true)
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  connector = EXCLUDED.connector,
  full_assortment = EXCLUDED.full_assortment,
  enabled = CASE
    WHEN EXCLUDED.id = 'picnic' THEN catalog.chains.enabled
    ELSE EXCLUDED.enabled
  END;
