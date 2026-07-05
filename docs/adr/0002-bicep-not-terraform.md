# ADR-0002 — Infrastructure as code: Bicep (not Terraform)

**Status:** Accepted · **Date:** 2026-07-05

## Decision

All infrastructure is defined in **Bicep**, deployed at subscription scope (`az deployment sub create`) so resource groups themselves are IaC-managed. One template + per-environment `.bicepparam` files (`prakkie-dev`, `prakkie-prod`). `what-if` runs before every deploy; prod is gated.

## Rationale

Azure-only stack (fixed by the spec pack), solo team: Bicep is first-party, has zero state-file management (ARM is the state), `what-if` gives plan-preview parity with Terraform for our needs, and the az CLI we already require is the only tooling. Terraform's advantages (multi-cloud, ecosystem modules) buy nothing here and add a state backend + version pinning to operate.

## Consequences

If the stack ever leaves Azure, IaC is rewritten — accepted, since the data layer (ADR-0001) is the portable part that matters. Bicep modules live in `infra/modules/`; resource list in [`plan/06_iac.md`](../../plan/06_iac.md).
