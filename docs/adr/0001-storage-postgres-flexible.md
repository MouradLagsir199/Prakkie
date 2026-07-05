# ADR-0001 — Primary data store: Azure Database for PostgreSQL Flexible Server (B1ms + pgvector + pg_trgm)

**Status:** Accepted · **Date:** 2026-07-05

## Decision

One PostgreSQL Flexible Server (Burstable **Standard_B1ms**, 32 GiB, PG 16, West Europe, HA off, PITR 7 d) hosts all three workloads, separated by schema: `app` (user data), `catalog` (11-chain product catalog + embeddings + price history), `discovery` (crawled recipe corpus). Extensions: `vector`, `pg_trgm`, `unaccent`, `citext`. Nightly `pg_dump -Fc` to an immutable Blob container (30 d + first-of-month kept 12 mo) as the independent durability backstop next to PITR.

## Context & alternatives

The storage decision was left open by `docs/03_azure_architecture_and_storage.md` §5 with four options and five ordered criteria (cost ≤ €15 target · durability/PITR · matching fit · ops simplicity · portability). Full scoring table, adversarial cost-first stress test, and per-alternative rejection rationale: see [`plan/02_adr-0001-storage.md`](../../plan/02_adr-0001-storage.md).

Summary: Cosmos free tier wins the cost criterion (€0 vs ≈ €16/mo) but the criterion is a threshold, which Postgres meets within €1; Postgres then wins matching fit (pg_trgm + unaccent fuzzy Dutch product search + pgvector HNSW + relational joins in one query — the E3 matching engine is the product's moat), ops simplicity and portability outright. Azure SQL serverless and the blob-catalog option fail the matching-fit criterion structurally.

## Consequences

≈ €16/month is the biggest fixed budget line (envelope still closes at €27–50). B1ms constraints accepted: staggered nightly ingestion, batched embedding upserts, `cpu_credits_remaining` alert; escape hatch = B2s SKU bump (flag to owner first). Exit path is `pg_dump | pg_restore` anywhere. Revisit at >500 users, sustained credit depletion, or >20 GiB.
