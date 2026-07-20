-- 0019 — lekkerensimpel.com: de sitemap-index begint bij post-sitemap.xml met
-- de óúdste blogposts (Articles, geen Recipe-JSON-LD) — 400/400 rejected op
-- 2026-07-07. De nieuwste posts (mét Recipe-schema) staan in post-sitemap8.xml.

UPDATE discovery.crawl_sources
   SET sitemap_url = 'https://www.lekkerensimpel.com/post-sitemap8.xml'
 WHERE domain = 'lekkerensimpel.com';
