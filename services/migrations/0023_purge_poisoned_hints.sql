-- 0023 — vergiftigde lexicon-hints eruit (owner 2026-07-07 avond: "Spar
-- kaastengel roomboter" stond als gecureerde rank-1-hint voor roomboter).
--
-- LES (zelfde avond geleerd): de AI-canonieken zijn ONTMERKTE PRODUCTNAMEN,
-- geen kop-labels ("Spar kaastengel roomboter" → "kaastengel roomboter") —
-- een eindigt-op-de-term-regel werkt dus niet. De betrouwbare regel: een hint
-- is vergiftigd wanneer naam of canoniek een samengesteld-woord (gebak/
-- gerecht/afgeleide) draagt dat de hint-term zelf niet noemt. Suffix-match
-- vangt samenstellingen (boterhamZAKJES, eiercakeJES, roomIJS); 'rijst'
-- matcht 'ijs' niet (de t breekt de woordgrens). Spiegel van COMPOSITE_RX in
-- services/functions-api/src/lib/match.ts en DISH_WORDS in
-- scripts/seed-lexicon-hints.mjs (de reseed hanteert dezelfde guard, dus de
-- nachtelijke loop brengt de rommel niet terug).
--
-- NB dev: een eerdere versie van deze migratie (kop-match-regel) is daar al
-- toegepast; dev is hersteld via een volledige reseed van de hints. Deze
-- definitieve versie is voor omgevingen die 0023 nog niet draaiden.

DELETE FROM catalog.lexicon_products lp
USING catalog.products p
LEFT JOIN catalog.name_canonical nc ON nc.name_search = public.fold_text(p.name)
WHERE p.chain_id = lp.chain_id AND p.sku_id = lp.sku_id
  AND NOT lp.item_normalised ~ '(saus|soep|salade|schotel|maaltijd|mix|poeder|drink|snack|chips|koek|koekjes?|biscuits?|croissants?|spritsen|sprits|taart|vlaai|wafels?|cakejes?|cake|flappen|flap|kano|tengels?|kaastengel|carrees?|hoef|picolientjes?|zakjes?|creme|gebak|ijs|dessert|pizza|burgers?|wraps?|broodjes?|repen|reep|spread|vulling|beleg|smaak|geur)($|\s)'
  AND (
    public.fold_text(p.name) ~ '(saus|soep|salade|schotel|maaltijd|mix|poeder|drink|snack|chips|koek|koekjes?|biscuits?|croissants?|spritsen|sprits|taart|vlaai|wafels?|cakejes?|cake|flappen|flap|kano|tengels?|kaastengel|carrees?|hoef|picolientjes?|zakjes?|creme|gebak|ijs|dessert|pizza|burgers?|wraps?|broodjes?|repen|reep|spread|vulling|beleg|smaak|geur)($|\s)'
    OR (nc.display_name IS NOT NULL AND public.fold_text(nc.display_name) ~ '(saus|soep|salade|schotel|maaltijd|mix|poeder|drink|snack|chips|koek|koekjes?|biscuits?|croissants?|spritsen|sprits|taart|vlaai|wafels?|cakejes?|cake|flappen|flap|kano|tengels?|kaastengel|carrees?|hoef|picolientjes?|zakjes?|creme|gebak|ijs|dessert|pizza|burgers?|wraps?|broodjes?|repen|reep|spread|vulling|beleg|smaak|geur)($|\s)')
  );
