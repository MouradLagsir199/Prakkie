-- The dedicated DekaMarkt scraper walks all 146 web groups and stores every
-- unique product. The former partial-assortment flag predated that scraper.
UPDATE catalog.chains
SET full_assortment = true
WHERE id = 'dekamarkt';
