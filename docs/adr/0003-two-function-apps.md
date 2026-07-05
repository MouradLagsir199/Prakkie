# ADR-0003 — Two Azure Functions apps (api + ingest), Consumption plan

**Status:** Accepted · **Date:** 2026-07-05

## Decision

Two Linux Consumption Function apps (Node 22, Functions v4 programming model):

- **`func-prakkie-api`** — user-facing: HTTP API, auth, sync, `import-recipe` (sync fast paths + Durable Functions orchestrator for the ≤5-min video-transcript tail).
- **`func-prakkie-ingest`** — machine-facing: 11 staggered nightly chain-ingestion timers, weekly discovery crawl, queue workers, price-compute, GDPR export worker, nightly `pg_dump`, Apify spend meter.

## Rationale

One app could host everything, but retry-heavy ingestion (429 storms, poison messages, long backoffs) must never exhaust the API app's scale-out instances or its share of the B1ms Postgres connection pool (~20 connections each). The apps deploy independently — connectors change weekly as chains change their JSON; the API doesn't. A second Consumption app costs ≈ €0. A *third* app (import split from API) buys nothing: import is API traffic and shares its auth middleware. Container Apps rejected: always-warm pricing isn't justified when the long-running path is handled by Durable Functions (202 + status polling).

## Consequences

Each app gets its own Durable task-hub name; both share one storage account and one Application Insights. Cross-app contracts go through Postgres and Storage Queues only.
