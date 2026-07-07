-- "boter" is een zoek-INTENTIE, geen eigen product: wie boter typt bedoelt
-- (room)boter/margarine — zoals de AH-zoekbalk dat begrijpt (owner 2026-07-07).
-- Als eigen lexicon-item won "popcorn boter" de hele-woord-boost terwijl échte
-- "Roomboter"-producten (boter zit ín het woord) hem misliepen. Alias van
-- roomboter maken activeert de morfologische zoektermen (boter → roomboter),
-- de canonieke-naam-boost én de bestaande hints/leer-loop voor roomboter.

DELETE FROM catalog.lexicon_products WHERE item_normalised = 'boter';
DELETE FROM catalog.ingredient_lexicon WHERE item_normalised = 'boter';

UPDATE catalog.ingredient_lexicon
SET aliases = (
  SELECT array_agg(DISTINCT a)
  FROM unnest(aliases || '{boter,margarine}'::text[]) AS a
)
WHERE item_normalised = 'roomboter';
