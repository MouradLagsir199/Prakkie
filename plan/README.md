# Prakkie — Build Plan (approved v1)

> **Scope:** the whole app, modules A–N per `docs/01_functional_spec.md`. Nothing deferred; ordering is dependency + parallelism, not a reduced release.
> **Track progress in [`progress.md`](progress.md)** — tick items off as workstreams land.

## Context

Prakkie turns any recipe found on social media, blogs or a discovery feed into a priced, aisle-sorted Dutch shopping list, compared across the 11 supported supermarket chains. The spec pack in `docs/00…06` is authoritative (00/01 win on conflict). The 7 approved HTML mockups in `tab_designs_ui/html/` are the UX contract (all 7 still carry the old "Bordje" title — re-export task tracked in progress). Fixed stack: Azure West Europe, Apify (verbatim actor IDs from `docs/06`), OpenAI parsing, ≤ €50/month up to ~500 users.

`secrets.txt` exists in the repo root. Its values are never printed in plans, code, or commits; the very first repo action is a `.gitignore` covering `secrets.txt` and `.env*`, and a one-time `scripts/setup-secrets` loads the values into Azure Key Vault, after which every service reads them via managed identity.

## Plan documents

| File | Contents |
|---|---|
| [`01_decisions.md`](01_decisions.md) | The four up-front decisions D1–D4 (storage, client, backend shape, repo layout) |
| [`02_adr-0001-storage.md`](02_adr-0001-storage.md) | Full storage ADR: scoring, stress test, config, consequences |
| [`03_architecture.md`](03_architecture.md) | Component → Azure map, two Function apps, auth, data flows, cost table |
| [`04_data-model.md`](04_data-model.md) | PostgreSQL schemas `app` / `catalog` / `discovery`, indexes, sync model, GDPR |
| [`05_workstreams.md`](05_workstreams.md) | WS0–WS10 dependency-ordered, acceptance criteria, critical path, parallel lanes |
| [`06_iac.md`](06_iac.md) | Bicep plan, resource list, one-command deploy, setup-secrets |
| [`07_testing-cicd.md`](07_testing-cicd.md) | Golden sets, matching harness, property tests, canaries, GitHub Actions |
| [`08_observability-cost.md`](08_observability-cost.md) | Telemetry, the one workbook, Apify spend alerting, budget guardrails, quota |
| [`09_risks.md`](09_risks.md) | Spec §21 risks carried over + build-specific risks |
| [`10_inputs-needed.md`](10_inputs-needed.md) | Everything still needed from the owner |
| [`progress.md`](progress.md) | **The living tracker — tick things off here** |
