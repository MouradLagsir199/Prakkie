-- 0020 — voedingscentrum.nl uit: hun receptpagina's dragen geen Recipe-JSON-LD
-- (alleen Organization/BreadcrumbList; 400/400 rejected op 2026-07-07). De
-- crawler is bewust JSON-LD-only (docs/05); per-site HTML-parsing willen we niet.

UPDATE discovery.crawl_sources
   SET enabled = false,
       last_crawl_stats = '{"note": "geen Recipe-JSON-LD op receptpaginas; JSON-LD-only crawler kan hier niets — 2026-07-07"}'::jsonb
 WHERE domain = 'voedingscentrum.nl';
