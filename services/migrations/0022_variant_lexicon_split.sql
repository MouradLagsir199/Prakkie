-- 0022 — varianten zijn geen synoniemen (owner-bug 2026-07-07: "AH volle melk"
-- werd bij Alles-bij-Jumbo "halfvolle melk 6x200ML").
--
-- Oorzaak: 0009 maakte 'volle melk' een ALIAS van 'melk' — resolveLexicon
-- collapse't de variant vóór het matchen, dus elke keten zoekt op "melk" en de
-- variant-conflict-penalty in de matcher kan nooit vuren. Zelfde collapse bij
-- brood (wit/bruin/volkoren), kwark (magere) en rijst (witte/zilvervlies).
--
-- Fix: variantwoorden worden éigen lexicon-entries; alleen échte synoniemen en
-- vertalingen blijven alias (milk, rice, quark, santen). Audit voor de rest:
--   SELECT item_normalised, aliases FROM catalog.ingredient_lexicon
--   WHERE EXISTS (SELECT 1 FROM unnest(aliases) a
--                 WHERE a ~ '\m(volle|halfvolle|magere|witte?|bruine?|volkoren|zilvervlies)\M');

-- melk: 'volle melk' wordt eigen entry
UPDATE catalog.ingredient_lexicon
   SET aliases = array_remove(aliases, 'volle melk')
 WHERE item_normalised = 'melk';

INSERT INTO catalog.ingredient_lexicon (item_normalised, aliases, default_unit, aisle_group_id, is_seed) VALUES
  ('volle melk',       '{}',                            'ml',    2, true),
  ('magere melk',      '{}',                            'ml',    2, true),
  ('wit brood',        '{witbrood}',                    'stuks', 6, true),
  ('bruin brood',      '{bruinbrood}',                  'stuks', 6, true),
  ('volkorenbrood',    '{volkoren brood}',              'stuks', 6, true),
  ('magere kwark',     '{}',                            'g',     2, true),
  ('witte rijst',      '{}',                            'g',     8, true),
  ('zilvervliesrijst', '{zilvervlies rijst}',           'g',     8, true)
ON CONFLICT (item_normalised) DO NOTHING;

-- brood/kwark/rijst: variant-aliassen weghalen bij de basisterm
UPDATE catalog.ingredient_lexicon
   SET aliases = array_remove(array_remove(array_remove(aliases, 'wit brood'), 'bruin brood'), 'volkorenbrood')
 WHERE item_normalised = 'brood';

UPDATE catalog.ingredient_lexicon
   SET aliases = array_remove(aliases, 'magere kwark')
 WHERE item_normalised = 'kwark';

UPDATE catalog.ingredient_lexicon
   SET aliases = array_remove(array_remove(aliases, 'witte rijst'), 'zilvervliesrijst')
 WHERE item_normalised = 'rijst';
