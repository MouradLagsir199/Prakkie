-- 0030 — wanden-taxonomie (owner-art, 2026-07-12): de 10 afdelingen van 0029
-- worden 25 schappenwanden, in de exacte loopvolgorde van de eigen wand-
-- illustraties (REDESIGN/1-4.png → apps/mobile assets). De wand-toewijzing is
-- per paneel (groente/fruit delen schap-groep 1, vlees/vis groep 3, kaas/
-- vleeswaren groep 5) en komt uit de reseed van store_categories
-- (scripts/store-categories.curated.csv → seed-store-categories.mjs — direct
-- na deze migratie draaien, anders is de winkel even leeg).
-- Glutenvrij heeft bewust nog géén panelen: geen betrouwbaar productdata-
-- signaal — de wand toont een eerlijke "binnenkort"-staat.

DELETE FROM catalog.store_categories;   -- stats cascaden mee
DELETE FROM catalog.store_departments;

INSERT INTO catalog.store_departments (id, slug, name_nl, theme, sort, aisle_group_ids) VALUES
  (1,  'groente-aardappelen',   'Groente & aardappelen',           'produce', 10,  '{1}'),
  (2,  'fruit-sappen',          'Fruit & verse sappen',            'produce', 20,  '{1,15}'),
  (3,  'maaltijden-salades',    'Maaltijden & salades',            'fridge',  30,  '{1,6}'),
  (4,  'vlees',                 'Vlees',                           'fridge',  40,  '{3}'),
  (5,  'vis',                   'Vis',                             'fridge',  50,  '{3,9}'),
  (6,  'vega',                  'Vegetarisch & plantaardig',       'fridge',  60,  '{4}'),
  (7,  'vleeswaren',            'Vleeswaren',                      'fridge',  70,  '{5,7}'),
  (8,  'kaas',                  'Kaas',                            'fridge',  80,  '{5}'),
  (9,  'zuivel-eieren',         'Zuivel & eieren',                 'fridge',  90,  '{2,4}'),
  (10, 'bakkerij',              'Bakkerij',                        'bakery',  100, '{6}'),
  (11, 'glutenvrij',            'Glutenvrij',                      'dry',     110, '{}'),
  (12, 'borrel-chips-snacks',   'Borrel, chips & snacks',          'dry',     120, '{13}'),
  (13, 'pasta-rijst-wereld',    'Pasta, rijst & wereldkeuken',     'dry',     130, '{8}'),
  (14, 'soepen-sauzen-kruiden', 'Soepen, sauzen, kruiden & olie',  'dry',     140, '{9,10}'),
  (15, 'koek-snoep-chocolade',  'Koek, snoep & chocolade',         'dry',     150, '{11,12}'),
  (16, 'ontbijt-beleg',         'Ontbijtgranen & beleg',           'dry',     160, '{6,7,12}'),
  (17, 'tussendoortjes',        'Tussendoortjes',                  'dry',     170, '{1,6,7,11,12}'),
  (18, 'diepvries',             'Diepvries',                       'freezer', 180, '{14}'),
  (19, 'koffie-thee',           'Koffie & thee',                   'dry',     190, '{16}'),
  (20, 'frisdrank-water',       'Frisdrank, sappen & water',       'dry',     200, '{15}'),
  (21, 'bier-wijn',             'Bier, wijn & aperitieven',        'dry',     210, '{17}'),
  (22, 'drogisterij',           'Drogisterij',                     'nonfood', 220, '{18}'),
  (23, 'huishouden',            'Huishouden',                      'nonfood', 230, '{19}'),
  (24, 'baby-kind',             'Baby & kind',                     'nonfood', 240, '{1,2,18,19}'),
  (25, 'huisdier',              'Huisdier',                        'nonfood', 250, '{3,4,19,20}');
