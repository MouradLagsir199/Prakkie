# ean-enrichment

Geplande job die catalogusproducten zonder scraper-EAN (Aldi vrijwel het hele
assortiment, PLUS grotendeels, AH incidenteel) een EAN geeft uit Open Food
Facts, zodat cross-chain productmatching puur op EAN-identiteit kan draaien.

```
Open Food Facts parquet (Hugging Face)
        ↓  server-side copy, max 1×/20 dagen
Azure Blob Storage: stprakkie<env>/openfoodfacts/food.parquet
        ↓  geplande Container Apps Job: caj-ean-enrich-<env>
DuckDB: filter countries_tags ⊇ en:netherlands + kolomprojectie
        ↓
match-off.mjs: exact → token-set → insluiting (merk/verpakking mogen nooit
tegenspreken; ambigu = geen match; provenance in catalog.ean_enrichment)
        ↓
PostgreSQL: catalog.products.ean (alleen waar nog NULL)
```

## Draaien

- **Gepland (prod-pad):** wekelijks via de Container Apps Job
  (`infra/modules/enrichment-job.bicep`, cron `0 3 * * 1`). Handmatig starten:
  `az containerapp job start -g prakkie-<env> -n caj-ean-enrich-<env>`.
- **Lokaal tegen dev:**
  ```
  PG_HOST=… PG_USER=prakkie_ingest PG_PASSWORD=… node src/run.mjs
  ```
  Handige extra's: `DRY_RUN=1` (niets wegschrijven, voorbeeldmatches loggen),
  `OFF_LOCAL_PARQUET=./food.parquet` (blob/HF overslaan),
  `ENRICH_CHAINS=aldi` (subset).

## Configuratie (env)

| Var | Default | Betekenis |
| --- | --- | --- |
| `PG_HOST` / `PG_DATABASE` / `PG_USER` / `PG_PORT` | — / `prakkie` / `prakkie_ingest` / `5432` | database |
| `PG_PASSWORD` óf `KEY_VAULT_NAME` (+`PG_SECRET_NAME`) | — / `PG-INGEST-PASSWORD` | wachtwoord direct of via Key Vault (managed identity) |
| `STORAGE_ACCOUNT` | — | blob-cache; leeg = rechtstreeks van `OFF_PARQUET_URL` lezen |
| `OFF_PARQUET_URL` | HF `openfoodfacts/product-database` `food.parquet` | bron |
| `OFF_MAX_AGE_DAYS` | `20` | blob-kopie verversen wanneer ouder |
| `ENRICH_CHAINS` | `aldi,plus,ah` | ketens waarvan `ean IS NULL`-regels verrijkt worden |
| `DRY_RUN` | — | `1` = alleen rapporteren |

## Garanties

- `catalog.products.ean` wordt alleen gevuld waar hij nog `NULL` is; een
  scraper-EAN wint altijd (de ingest-upsert gebruikt `COALESCE(EXCLUDED.ean,
  products.ean)` zodat een scraper-`NULL` de verrijking ook niet wist).
- Elke geschreven EAN heeft een provenance-rij in `catalog.ean_enrichment`
  (methode, score, OFF-naam/merk, tijdstip) — herleidbaar en terugdraaibaar.
- Ambiguïteit (één naam, meerdere EAN's) of een tegensprekend merk/verpakking
  betekent: géén match. Liever een gat dan het verkeerde product.
