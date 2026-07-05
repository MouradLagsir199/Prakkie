# Observability & cost guardrails

## Telemetry baseline

App Insights 5% fixed-rate sampling (`host.json`) + 1 GB/day workspace cap, 30-day retention. Low-volume custom events sent **non-sampled** so workbook numbers are exact: `import_attempted/succeeded/failed{platform,status}`, `import_cache_hit/miss`, `match_confidence` (metric, dim chain), `chain_ingest_completed/failed{chain,deltas}`, `apify_run{actor}`, `video_quota_denied`.

## The one workbook (Bicep-deployed, mirrors docs/03 §6)

1. **Imports:** attempted vs succeeded per platform/method, 422/503 breakdown, p50/p95 duration vs <15 s/<3 s targets, **URL-hash cache hit-rate tile** (the Apify budget lever).
2. **Match confidence:** histogram + % lines below shortlist threshold per chain (live proxy for the ≥90% gate).
3. **Per-chain freshness:** hours since last ingest (the same value drives the in-app "prijzen van {datum}" label), product-count trend, delta-spike signal.

## Apify spend, concretely

Hourly timer `monitor-apify-usage` calls Apify `GET /v2/users/me/usage/monthly` + `/limits` → custom metrics `apify_usd_month_to_date`, `apify_runs_today` (cross-checked against local `apify_run` events).

**Alerts:** >€10 warn / >€15 critical (mirrors the docs/03 budget line), >100 runs/day (retry loop or abuse), day-over-day delta >€2.

**Hard caps stay in code:** `maxPaidDatasetItems=1` always; per-actor `maxTotalChargeUsd` (verbatim: Pinterest pin 1.00, Pinterest media transcript 0.25; default 0.50 for others, config-tunable).

## Azure guardrails

- RG budget €50 alerts 50/80/100% actual + 100% forecast
- PG `cpu_credits_remaining` <30 + storage >80% alerts
- Blob lifecycle policies + ≤200 KB webp images
- Functions execution-count anomaly (>3× 7-day baseline) catches retry storms
- Dev Postgres stopped by default

## Video quota enforcement point

Inside `import-recipe`, **after cache lookup, before any transcript actor**:

1. Cache hit consumes no quota, no Apify call.
2. Cache miss reaching a transcript actor reads `app.usage_counters` for `(user, month)` in the same transaction as the import row.
3. Over quota (free = 0, video is premium; premium = N/month config) → typed `quota_exceeded` → upgrade sheet. Caption/metadata imports never touch the quota.
4. `video_quota_denied` event lands in the workbook, so quota pressure is visible before users complain.
