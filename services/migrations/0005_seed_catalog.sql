-- 0005 — seed reference data (mirrors packages/shared: chains.ts + aisle-taxonomy.ts)

INSERT INTO catalog.chains (id, display_name, connector, full_assortment, enabled) VALUES
  ('ah',        'Albert Heijn',        'ah',           true,  true),
  ('jumbo',     'Jumbo',               'jumbo',        true,  true),
  ('plus',      'Plus',                'plus',         true,  true),
  ('dirk',      'Dirk van den Broek',  'detailresult', true,  true),
  ('dekamarkt', 'DekaMarkt',           'detailresult', false, true),
  ('aldi',      'Aldi',                'aldi',         false, true),
  ('vomar',     'Vomar',               'vomar',        true,  true),
  ('hoogvliet', 'Hoogvliet',           'hoogvliet',    true,  true),
  ('spar',      'Spar',                'spar',         true,  true),
  -- kill-switched from day one (plan/05 WS2; pending owner decision #7)
  ('picnic',    'Picnic',              'picnic',       false, false),
  ('ekoplaza',  'Ekoplaza',            'ekoplaza',     true,  true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog.aisle_taxonomy (id, slug, name_nl, default_sort) VALUES
  (1,  'groente-fruit',          'GROENTE & FRUIT',              1),
  (2,  'zuivel-eieren',          'ZUIVEL & EIEREN',              2),
  (3,  'vlees-vis',              'VLEES & VIS',                  3),
  (4,  'vega-plantaardig',       'VEGA & PLANTAARDIG',           4),
  (5,  'kaas-vleeswaren',        'KAAS & VLEESWAREN',            5),
  (6,  'brood-banket',           'BROOD & BANKET',               6),
  (7,  'ontbijt-beleg',          'ONTBIJT & BELEG',              7),
  (8,  'pasta-rijst-wereld',     'PASTA, RIJST & WERELDKEUKEN',  8),
  (9,  'conserven-soepen',       'CONSERVEN & SOEPEN',           9),
  (10, 'kruiden-sauzen-olie',    'KRUIDEN, SAUZEN & OLIE',      10),
  (11, 'bakken-zoet',            'BAKPRODUCTEN & ZOET',         11),
  (12, 'snoep-koek',             'SNOEP & KOEK',                12),
  (13, 'chips-noten',            'CHIPS & NOTEN',               13),
  (14, 'diepvries',              'DIEPVRIES',                   14),
  (15, 'dranken-sappen',         'DRANKEN & SAPPEN',            15),
  (16, 'koffie-thee',            'KOFFIE & THEE',               16),
  (17, 'bier-wijn',              'BIER & WIJN',                 17),
  (18, 'drogisterij-verzorging', 'DROGISTERIJ & VERZORGING',    18),
  (19, 'huishouden-non-food',    'HUISHOUDEN & NON-FOOD',       19),
  (20, 'overig',                 'OVERIG',                      20)
ON CONFLICT (id) DO NOTHING;

-- "AH-indeling" store-walk order (shared/aisle-taxonomy.ts CHAIN_AISLE_ORDER.ah);
-- other chains fall back to default_sort until tuned during WS2
INSERT INTO catalog.chain_aisle_profiles (chain_id, aisle_group_id, sort_order)
SELECT 'ah', id, ord
FROM unnest(ARRAY[1, 6, 5, 3, 4, 2, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 14, 18, 19, 20])
     WITH ORDINALITY AS t(id, ord)
ON CONFLICT (chain_id, aisle_group_id) DO NOTHING;
