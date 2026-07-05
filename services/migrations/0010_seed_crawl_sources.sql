-- 0010 — the nine docs/05 discovery sources (WS7). Adding a source = one row
-- (+ optional config tweaks); zero per-site code.

INSERT INTO discovery.crawl_sources (domain, name, sitemap_url, cadence, robots_config) VALUES
  ('ah.nl',                'Allerhande',          'https://www.ah.nl/sitemaps/entities/allerhande/recipes.xml', 'weekly', '{"include": "allerhande/recept/"}'),
  ('jumbo.com',            'Jumbo Recepten',      'https://www.jumbo.com/sitemap-recipes.xml',                  'weekly', '{"include": "/recepten/"}'),
  ('plus.nl',              'PLUS Recepten',       'https://www.plus.nl/sitemap-recipe.xml',                     'weekly', '{"include": "/recept"}'),
  ('smulweb.nl',           'Smulweb',             'https://www.smulweb.nl/sitemap.xml',                         'weekly', '{"include": "/recepten/"}'),
  ('leukerecepten.nl',     'Leukerecepten',       'https://www.leukerecepten.nl/sitemap.xml',                   'weekly', '{"include": "/recepten/"}'),
  ('lekkerensimpel.com',   'Lekker en Simpel',    'https://www.lekkerensimpel.com/sitemap_index.xml',           'weekly', '{"include": "/gerecht"}'),
  ('uitpaulineskeuken.nl', 'Uit Paulines Keuken', 'https://uitpaulineskeuken.nl/sitemap_index.xml',             'weekly', '{"include": "/recept"}'),
  ('24kitchen.nl',         '24Kitchen',           'https://www.24kitchen.nl/sitemap.xml',                       'weekly', '{"include": "/recepten/"}'),
  ('voedingscentrum.nl',   'Voedingscentrum',     'https://www.voedingscentrum.nl/sitemap.xml',                 'weekly', '{"include": "/recepten/"}')
ON CONFLICT (domain) DO NOTHING;
