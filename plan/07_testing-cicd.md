# Testing & CI/CD

Principle: **the product-defining numbers (import ≥95/≥85, matching ≥90) are CI gates, not aspirations.** Everything in CI is offline/deterministic; anything live runs on a schedule outside CI.

## 1. Import-reliability golden set (fixture replay — no live Apify in CI, ever)

`packages/testing/fixtures/import/` — ~120 curated NL cases at launch: ~40 blog/JSON-LD (incl. every docs/05 site), ~30 captions (NL+EN, el/tl/snufje, ranges, "naar smaak"), ~30 recorded video transcripts, ~20 adversarial (no quantities spoken / recipe-adjacent non-recipes → must yield `missing_fields`/422, never hallucinated). Each case = recorded Apify/HTTP responses + expected Recipe JSON + tier. Recorded once via `scripts/record-fixture` (live, local, cost-guarded, verbatim docs/06 inputs). `runApifyActor()`/`fetchPageMetadata()` are injectable → tests replay fixtures.

**Scoring:** field-level accuracy (title, servings, times, order-insensitive `(qty,unit,item)` triplets, steps, `missing_fields` correctness), averaged per tier.

**Two tiers:** every-PR fully offline (OpenAI cassettes replayed — gates all code around the parser deterministically); **weekly + on-prompt-change live-OpenAI run** on the full corpus (~cents) that **fails below 95/85** and refreshes cassettes on pass — catches prompt/model drift without making PRs nondeterministic.

## 2. Matching top-1 harness

`packages/matching/bench/`: seed lexicon + ≥500 labelled `{item_normalised, chain, expected_sku, alternates[]}` pairs against a frozen committed catalog snapshot; embeddings precomputed and committed (no OpenAI in CI); pg_trgm+pgvector run in a throwaway Postgres service container (same image/extensions as prod). **Gate: top-1 ≥90%** on common ingredients; top-3 + per-chain breakdown as PR annotations. Labelled set grows append-only from real corrections (E5) so scores stay comparable.

## 3. Deterministic unit/property tests (Vitest + fast-check)

- Pack-size reconciliation properties (minimal n with n×pack ≥ needed; restje ≥ 0; "pakt precies" iff 0; promo mechanics per type; mockup-06 cases verbatim)
- NL formatting round-trips (`€ 47,80`, `€ 1,85 p.p.`, el→ml, fractions, ranges)
- Aisle-sort snapshots per chain profile (fixed 30-item list renders sections in canonical order; reassignment/reorder persist; unknown → OVERIG last)
- Sync/merge conflicts (two-device LWW per field group, check-off merge, no data loss ever)
- List-merge provenance (merge, unmerge on recipe removal, re-scale on plan change)

## 4. Connector contract tests + nightly canary

10 connectors / 11 chains (Detailresult = Dirk+DekaMarkt), each with recorded HTTP fixtures → parse → zod `Product` → assert required fields. **Nightly canary (out of CI):** 3–5 polite live requests per chain → real parser → schema validation → on failure open/refresh a `connector-drift:{chain}` GitHub issue + App Insights event. Canary never blocks PRs; it's the drift early-warning. Honours per-chain kill switches.

## 5. E2E smoke — **Maestro** (over Detox)

Detox fights Expo's managed workflow; Maestro drives release-like builds via accessibility IDs in YAML and is the de-facto Expo choice. Flows: onboarding→chain select→empty library · paste-link import (fixture-replay backend)→review→save→card with price pill · recipe→list→aisle sections+total · plan→"Boodschappenlijst maken"→merged provenance line · Prijzen renders ranked chains incl. "n items niet in assortiment". Android emulator nightly + pre-release; iOS via EAS on release candidates.

## 6. GitHub Actions

| Workflow | Trigger | Jobs |
|---|---|---|
| `pr.yml` | every PR | install(cached) → lint+prettier → `tsc --noEmit` all workspaces → Vitest suites → **import golden set (offline) 95/85 gates** → **matching ≥90 gate** (PG service container) → connector contract tests → gitleaks |
| `infra.yml` | PR touching `infra/**` | bicep lint + `what-if` vs dev via OIDC, posted as PR comment |
| `deploy-dev.yml` | push to `main` | `deploy -Env dev` → Maestro smoke vs dev |
| `deploy-prod.yml` | manual dispatch + environment protection (owner approval) | same, `-Env prod`; requires green dev smoke |
| `accuracy-weekly.yml` | cron + label | live-OpenAI accuracy run, cassette-refresh PR on pass |
| `canary-nightly.yml` | cron | connector live canaries |
| `eas.yml` | tag `mobile-v*` / dispatch | `eas build` preview/production → `eas submit`; EAS Update for OTA JS fixes |

Branch protection on `main`: required checks, no direct pushes.
