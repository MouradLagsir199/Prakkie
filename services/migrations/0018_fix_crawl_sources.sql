-- 0018 — crawl-bronnen gerepareerd na de eerste echte oogst (2026-07-07):
--  * jumbo.com: oude sitemap-URL is 404; recepten staan op /recepten/sitemap.xml
--  * voedingscentrum.nl: recepten leven onder /nl/gezonde-recepten/ — het oude
--    include-filter '/recepten/' matchte daardoor nul URL's
--  * plus.nl: sitemap-recipe.xml is een SPA-prerender die 200 + 404-HTML geeft;
--    uit tot er een echte sitemap is
--  * smulweb.nl: onbereikbaar (connectie-reset op alles); uit tot nader order

UPDATE discovery.crawl_sources
   SET sitemap_url = 'https://www.jumbo.com/recepten/sitemap.xml'
 WHERE domain = 'jumbo.com';

UPDATE discovery.crawl_sources
   SET robots_config = '{"include": "recept"}'::jsonb
 WHERE domain = 'voedingscentrum.nl';

UPDATE discovery.crawl_sources
   SET enabled = false,
       last_crawl_stats = '{"note": "sitemap-recipe.xml is SPA-prerender 404; geen bruikbare sitemap gevonden 2026-07-07"}'::jsonb
 WHERE domain = 'plus.nl';

UPDATE discovery.crawl_sources
   SET enabled = false,
       last_crawl_stats = '{"note": "site onbereikbaar (connection reset) 2026-07-07"}'::jsonb
 WHERE domain = 'smulweb.nl';
